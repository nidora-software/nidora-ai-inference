/**
 * On-disk storage for job inputs and generated media.
 *
 * Artifacts are served by the gateway itself, never redirected to object
 * storage. That is part of the published contract, not a preference: a client
 * sends credentials with the artifact request, so the correct posture is to pin
 * the host and refuse redirects — which means a presigned S3/R2 URL cannot be
 * followed. Read docs/gateway.md before attempting to move this to S3.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { isSafeFilename } from '../domain/filenames.js';

export class ArtifactTooLarge extends Error {}

export interface StoredArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export class ArtifactStore {
  readonly inputsDir: string;
  readonly artifactsDir: string;

  constructor(dataDir: string) {
    this.inputsDir = join(dataDir, 'inputs');
    this.artifactsDir = join(dataDir, 'artifacts');
  }

  async init(): Promise<void> {
    await mkdir(this.inputsDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
  }

  inputPath(jobId: string, extension: string): string {
    return join(this.inputsDir, jobId, `input.${extension}`);
  }

  async writeInput(jobId: string, extension: string, bytes: Buffer): Promise<string> {
    const path = this.inputPath(jobId, extension);
    await mkdir(dirname(path), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, bytes);
    return path;
  }

  /**
   * Stream an upload to `<dir>/.<name>.part` while hashing and counting, then
   * rename into place — atomic on the same filesystem, so a torn upload never
   * appears as a valid artifact and a retried POST simply overwrites the part
   * file. Aborts as soon as the byte cap is exceeded rather than after.
   */
  async writeArtifact(
    jobId: string,
    filename: string,
    source: Readable,
    maxBytes: number,
  ): Promise<StoredArtifact> {
    const dir = join(this.artifactsDir, jobId);
    await mkdir(dir, { recursive: true });
    const finalPath = join(dir, filename);
    const partPath = join(dir, `.${filename}.part`);

    const hash = createHash('sha256');
    let bytes = 0;
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes > maxBytes) {
        source.destroy(new ArtifactTooLarge(`artifact exceeds ${maxBytes} bytes`));
      }
    });

    try {
      await pipeline(source, createWriteStream(partPath));
    } catch (error) {
      await rm(partPath, { force: true });
      throw error;
    }

    await rename(partPath, finalPath);
    return { path: finalPath, bytes, sha256: hash.digest('hex') };
  }

  /**
   * Resolve a client-supplied filename inside a job's artifact directory.
   * Returns null for anything that escapes it — `path.resolve` collapses `..`
   * before the prefix check, so traversal is caught rather than served.
   */
  resolveArtifact(jobId: string, filename: string): string | null {
    if (!isSafeFilename(jobId) || !isSafeFilename(filename)) return null;
    const base = resolve(join(this.artifactsDir, jobId));
    const candidate = resolve(join(base, filename));
    if (candidate !== base && !candidate.startsWith(base + sep)) return null;
    return candidate;
  }

  async exists(path: string): Promise<number | null> {
    try {
      const info = await stat(path);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }

  async removeJob(jobId: string): Promise<void> {
    await Promise.all([
      rm(join(this.inputsDir, jobId), { recursive: true, force: true }),
      rm(join(this.artifactsDir, jobId), { recursive: true, force: true }),
    ]);
  }

  async removeInput(jobId: string): Promise<void> {
    await rm(join(this.inputsDir, jobId), { recursive: true, force: true });
  }
}
