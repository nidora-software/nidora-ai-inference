/**
 * Validating the client's input image.
 *
 * SECURITY: only uploaded bytes are accepted — the image arrives as a multipart
 * file part, exactly as SGLang takes it. URLs are refused by construction:
 * there is no field to put one in. SGLang's `reference_url` is never exposed,
 * so no client-supplied URL can reach the gateway's or a pod's network
 * (`reference_url: http://169.254.169.254/...` would otherwise hand out the
 * host's cloud instance-role credentials).
 *
 * The declared mime type is likewise ignored; the format is sniffed from magic
 * bytes so an `image/jpeg` part header can't smuggle something else past us.
 */
import { createHash } from 'node:crypto';

export interface DecodedImage {
  bytes: Buffer;
  /** Sniffed, not the label the client claimed. */
  format: 'jpeg' | 'png' | 'webp';
  extension: string;
  mediaType: string;
  sha256: string;
}

export class InputError extends Error {}

function sniff(bytes: Buffer): DecodedImage['format'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

const META: Record<DecodedImage['format'], { extension: string; mediaType: string }> = {
  jpeg: { extension: 'jpg', mediaType: 'image/jpeg' },
  png: { extension: 'png', mediaType: 'image/png' },
  webp: { extension: 'webp', mediaType: 'image/webp' },
};

export function readImage(bytes: Buffer, maxBytes: number): DecodedImage {
  if (bytes.length === 0) throw new InputError('input_reference is empty');
  if (bytes.length > maxBytes) {
    throw new InputError(`input_reference exceeds the ${maxBytes} byte limit`);
  }

  const format = sniff(bytes);
  if (!format) throw new InputError('input_reference is not a JPEG, PNG or WebP image');

  return {
    bytes,
    format,
    extension: META[format].extension,
    mediaType: META[format].mediaType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
