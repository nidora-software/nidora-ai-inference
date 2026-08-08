/**
 * The closed model registry.
 *
 * SECURITY: `model` arrives from the client. It is matched against this map and
 * never reaches a model path, a LoRA path, or SGLang's runtime LoRA endpoints —
 * an attacker-chosen HF repo loaded onto the GPU is `trust_remote_code` remote
 * code execution. Generation parameters are owned here and clamped, so a client
 * cannot turn a 45-second job into a 30-minute one and starve the queue.
 *
 * Keying by model id rather than by an invented pipeline name is what makes the
 * gateway's API conform to SGLang's (and therefore OpenAI's): the client names a
 * model exactly as it would when calling SGLang directly, and a pod's
 * capability is simply the model it loaded.
 */
import type { Resolution } from './sizing.js';

export interface ModelSpec {
  /** Which SGLang endpoint fulfils this model's task. */
  endpoint: string;
  /** SGLang reports this alongside the model id on `GET /models`. */
  task: string;
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

export const MODELS: Record<string, ModelSpec> = {
  'Wan-AI/Wan2.2-I2V-A14B-Diffusers': {
    endpoint: '/v1/videos',
    task: 'i2v',
    resolutions: ['480p', '720p'],
    defaults: { seconds: 5, num_inference_steps: 4, guidance_scale: 1.0 },
    limits: { maxSeconds: 10, maxSteps: 12 },
    negativePrompt: WAN22_NEGATIVE_PROMPT,
    maxPromptChars: 2000,
  },
};

/**
 * A model identifies the same weights whether it arrived as an HF repo id
 * (`Wan-AI/Wan2.2-I2V-A14B-Diffusers`) or as the local directory SGLang was
 * pointed at (`/workspace/models/Wan2.2-I2V-A14B-Diffusers`), so only the last
 * segment is compared. This is a lookup key, never a path that gets used.
 */
function modelKey(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return (segments[segments.length - 1] ?? '').toLowerCase();
}

/** Canonical registry id for a client- or pod-supplied name, or null. */
export function resolveModelId(name: unknown): string | null {
  if (typeof name !== 'string' || name === '') return null;
  if (Object.hasOwn(MODELS, name)) return name;
  const key = modelKey(name);
  if (!key) return null;
  return Object.keys(MODELS).find((id) => modelKey(id) === key) ?? null;
}

export function getModel(name: unknown): ModelSpec | null {
  const id = resolveModelId(name);
  return id ? MODELS[id]! : null;
}

export function modelNames(): string[] {
  return Object.keys(MODELS);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
