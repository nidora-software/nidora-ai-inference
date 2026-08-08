/**
 * The closed pipeline registry.
 *
 * SECURITY: `pipeline` arrives from the client. It is matched against this map
 * and never reaches a model path, a LoRA path, or SGLang's runtime LoRA
 * endpoints — an attacker-chosen HF repo loaded onto the GPU is
 * `trust_remote_code` remote code execution. Generation parameters are owned
 * here and clamped, so a client cannot turn a 45-second job into a 30-minute
 * one and starve the queue.
 */
import type { Resolution } from './sizing.js';

export interface PipelineSpec {
  /** Which SGLang endpoint fulfils this pipeline. */
  endpoint: string;
  resolutions: readonly Resolution[];
  defaults: {
    seconds: number;
    num_inference_steps: number;
    guidance_scale: number;
  };
  limits: {
    maxSeconds: number;
    maxSteps: number;
  };
  negativePrompt: string;
  maxPromptChars: number;
}

/**
 * Wan 2.2's own pacing is 81 frames at 16 fps. The 4-step / guidance 1.0
 * defaults come from the Lightning distill LoRA being a 4-step distill —
 * more steps make it worse, not better.
 */
const WAN22_NEGATIVE_PROMPT =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，' +
  '低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，' +
  '毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

export const PIPELINES: Record<string, PipelineSpec> = {
  'wan22-i2v': {
    endpoint: '/v1/videos',
    resolutions: ['480p', '720p'],
    defaults: { seconds: 5, num_inference_steps: 4, guidance_scale: 1.0 },
    limits: { maxSeconds: 10, maxSteps: 12 },
    negativePrompt: WAN22_NEGATIVE_PROMPT,
    maxPromptChars: 2000,
  },
};

export function getPipeline(name: unknown): PipelineSpec | null {
  if (typeof name !== 'string') return null;
  return Object.hasOwn(PIPELINES, name) ? PIPELINES[name]! : null;
}

export function pipelineNames(): string[] {
  return Object.keys(PIPELINES);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
