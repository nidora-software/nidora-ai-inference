/**
 * Minimal image header probing for the three formats we accept.
 *
 * Written by hand rather than pulled from a library on purpose. General-purpose
 * probes carry parsers for a dozen exotic formats (ICNS, JXL, HEIF) that we
 * never accept and that have a history of infinite-loop DoS advisories. Reading
 * only the headers we allow means the attack surface is exactly the three
 * formats `domain/inputs.ts` already sniffed for.
 *
 * Every read is bounds-checked; a truncated or malformed header returns null
 * rather than throwing or looping.
 */
export interface Dimensions {
  width: number;
  height: number;
}

export function probeDimensions(bytes: Buffer): Dimensions | null {
  return probeJpeg(bytes) ?? probePng(bytes) ?? probeWebp(bytes);
}

/**
 * PNG: IHDR is always the first chunk, width/height at fixed offsets 16..24.
 */
function probePng(bytes: Buffer): Dimensions | null {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

/**
 * JPEG: walk the marker segments to the first Start-Of-Frame, whose payload
 * holds the dimensions. The scan is strictly forward and bounded by the buffer
 * length, so a corrupt length field ends the walk rather than spinning.
 */
function probeJpeg(bytes: Buffer): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1; // resynchronise over fill bytes
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;

    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // Start of scan — entropy-coded data follows; no SOF was found.
    if (marker === 0xda) return null;

    if (offset + 1 >= bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2) return null;

    // SOF0-SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 7 >= bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width && height ? { width, height } : null;
    }

    offset += length;
  }
  return null;
}

/**
 * WebP: three container variants (lossy VP8, lossless VP8L, extended VP8X),
 * each storing the dimensions at a different fixed offset.
 */
function probeWebp(bytes: Buffer): Dimensions | null {
  if (bytes.length < 30) return null;
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  if (bytes.subarray(8, 12).toString('ascii') !== 'WEBP') return null;

  const chunk = bytes.subarray(12, 16).toString('ascii');

  if (chunk === 'VP8 ') {
    // 14-bit dimensions after the 3-byte start code and 0x9d012a signature.
    if (bytes.readUInt8(23) !== 0x9d || bytes.readUInt8(24) !== 0x01 || bytes.readUInt8(25) !== 0x2a) {
      return null;
    }
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }

  if (chunk === 'VP8L') {
    if (bytes.readUInt8(20) !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }

  if (chunk === 'VP8X') {
    // 24-bit little-endian, stored as (dimension - 1).
    const width = 1 + (bytes.readUInt8(24) | (bytes.readUInt8(25) << 8) | (bytes.readUInt8(26) << 16));
    const height = 1 + (bytes.readUInt8(27) | (bytes.readUInt8(28) << 8) | (bytes.readUInt8(29) << 16));
    return { width, height };
  }

  return null;
}
