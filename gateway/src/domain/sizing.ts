/**
 * Aspect-preserving output sizing.
 *
 * Port of the `fit_480p()` helper documented in docs/api.md: scale the input's
 * aspect ratio to the largest 16-pixel-aligned frame that fits the resolution's
 * pixel budget. Living in the gateway rather than the agent means retuning it
 * is a gateway redeploy, not a 30-minute CUDA image rebuild.
 */
export type Resolution = '480p' | '720p';

export const RESOLUTIONS: readonly Resolution[] = ['480p', '720p'];

const PIXEL_BUDGET: Record<Resolution, number> = {
  '480p': 480 * 832,
  '720p': 720 * 1280,
};

/**
 * Longest side the model is expected to produce at each resolution.
 *
 * The area budget alone is not enough. A 10000x1 input scaled to preserve area
 * gives 63184x16 — inside the pixel budget, but a frame no diffusion model can
 * generate, and one that would either OOM the GPU or be rejected downstream
 * after the job had already been queued and dispatched. Clamping the long side
 * turns a pathological aspect ratio into a merely letterboxed one.
 */
const MAX_DIMENSION: Record<Resolution, number> = {
  '480p': 832,
  '720p': 1280,
};

export function isResolution(value: unknown): value is Resolution {
  return typeof value === 'string' && (RESOLUTIONS as readonly string[]).includes(value);
}

/** Round down to a multiple of 16, never below one macroblock. */
function align16(value: number): number {
  return Math.max(16, Math.floor(Math.round(value) / 16) * 16);
}

export function fitSize(width: number, height: number, resolution: Resolution): string {
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`invalid image dimensions ${width}x${height}`);
  }

  let scale = Math.sqrt(PIXEL_BUDGET[resolution] / (width * height));

  // Then pull back if the aspect ratio pushed either side past what the model
  // can render. Both constraints applied in this order means the result is
  // always within the pixel budget AND within the frame bounds.
  const longest = Math.max(width, height) * scale;
  const limit = MAX_DIMENSION[resolution];
  if (longest > limit) scale *= limit / longest;

  return `${align16(width * scale)}x${align16(height * scale)}`;
}
