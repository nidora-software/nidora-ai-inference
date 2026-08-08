import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';

export const API_KEY = 'test-api-key';
export const AGENT_SECRET = 'test-agent-secret';

export const authHeaders = { 'x-api-key': API_KEY };
export const agentHeaders = { 'x-agent-secret': AGENT_SECRET };

export interface Harness extends BuiltApp {
  config: Config;
  cleanup: () => Promise<void>;
}

export async function makeHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'nidora-gw-'));
  const config = loadConfig({
    GATEWAY_API_KEYS: API_KEY,
    AGENT_SHARED_SECRET: AGENT_SECRET,
    DATA_DIR: dataDir,
    LOG_LEVEL: 'silent',
    // Tests drive time explicitly; a long-poll that actually waits would make
    // every case slow for no coverage.
    MAX_POLL_WAIT_S: '0',
    ...overrides,
  });

  const built = await buildApp({ config, databaseFile: ':memory:' });
  await built.app.ready();

  return {
    ...built,
    config,
    cleanup: async () => {
      built.shutdown.abort();
      await built.app.close();
      built.db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A real, decodable PNG of the given size — the gateway probes its header. */
export function pngDataUri(width: number, height: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  // One filter byte + 3 bytes per pixel, per row.
  const raw = Buffer.alloc(height * (1 + width * 3));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

export function createJobBody(overrides: Record<string, unknown> = {}) {
  return {
    pipeline: 'wan22-i2v',
    params: {
      image: pngDataUri(832, 480),
      prompt: 'the woman smiles and waves at the camera',
      negative_prompt: '',
      resolution: '480p',
      ...overrides,
    },
  };
}

/** A pod poll body with sensible defaults. */
export function pollBody(overrides: Record<string, unknown> = {}) {
  return {
    pod_id: 'pod-a',
    agent_version: '0.1.0',
    model_path: 'Wan-AI/Wan2.2-I2V-A14B-Diffusers',
    max_in_flight: 1,
    sglang_ready: true,
    in_flight: [],
    wait_s: 0,
    ...overrides,
  };
}
