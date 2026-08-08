/**
 * Decoding and validating the client's input image.
 *
 * SECURITY: only bytes are accepted — a `data:` URI or bare base64. URLs are
 * refused outright. SGLang's `reference_url` field is never exposed, so there
 * is no path by which a client-supplied URL reaches the gateway's or a pod's
 * network (`reference_url: http://169.254.169.254/...` would otherwise hand out
 * the host's cloud instance-role credentials).
 *
 * The declared mime type is likewise ignored; the format is sniffed from magic
 * bytes so a `data:image/jpeg` label can't smuggle something else past us.
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

const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)?(;charset=[\w-]+)?;base64,/i;

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

export function decodeImage(raw: unknown, maxBytes: number): DecodedImage {
  if (typeof raw !== 'string' || raw === '') {
    throw new InputError('params.image is required and must be a base64 data URI');
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !DATA_URI.test(raw)) {
    throw new InputError(
      'params.image must be image bytes as a base64 data URI — URLs are not accepted',
    );
  }

  const base64 = raw.replace(DATA_URI, '');
  // 4 base64 chars per 3 bytes; reject before allocating the decoded copy.
  if (Math.floor((base64.length * 3) / 4) > maxBytes) {
    throw new InputError(`params.image exceeds the ${maxBytes} byte limit`);
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new InputError('params.image did not decode to any bytes');
  if (bytes.length > maxBytes) {
    throw new InputError(`params.image exceeds the ${maxBytes} byte limit`);
  }

  const format = sniff(bytes);
  if (!format) throw new InputError('params.image is not a JPEG, PNG or WebP image');

  return {
    bytes,
    format,
    extension: META[format].extension,
    mediaType: META[format].mediaType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
