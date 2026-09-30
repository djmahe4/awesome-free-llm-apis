import fetch from 'node-fetch';

export type KeyframeModel =
  | 'flux'
  | 'black-forest-labs/flux.1-schnell'
  | 'black-forest-labs/FLUX.1-schnell'
  | 'black-forest-labs/FLUX.1-dev'
  | 'krea/Krea-2-Turbo'
  | 'Tongyi-MAI/Z-Image-Turbo'
  | 'Qwen/Qwen-Image'
  | 'community/MarcosFRG/flux-1-schnell'
  | 'lykon/dreamshaper-8-lcm'
  | 'tongyi-mai/z-image-turbo'
  | 'bytedance/seedream-5.0-lite'
  | 'Qwen/Qwen-Image-2.1'
  | 'BBB662/ndf-krea2'
  | 'MArilei/PiB'
  | 'turbo'
  | 'gptimage'
  | 'zimage'
  | (string & {});

export type MotionEngine =
  | 'wan2.1'
  | 'wan2.1-i2v-14b'
  | 'wan2.1-t2v-1.3b'
  | 'wan2.2'
  | 'wan2.2-i2v-a14b'
  | 'hunyuan-video'
  | 'ltx'
  | 'ltx-2'
  | 'cogvideox-5b'
  | (string & {});

export interface KeyframeInput {
  prompt: string;
  width?: number;
  height?: number;
  seed?: number;
  model?: KeyframeModel;
  apiKey?: string;
  enhance?: boolean;
}

export interface KeyframeResult {
  imageUrl: string;
  headers?: Record<string, string>;
  status: number;
}

/**
 * Builds the Pollinations generation URL with authentication and parameters.
 * Supports official models as well as community zero-cost / micro-cost image models.
 */
export function buildKeyframeUrl(input: KeyframeInput): string {
  const w = input.width || 1280;
  const h = input.height || 720;
  const model = input.model || 'flux';
  const apiKey = input.apiKey || process.env.POLLINATIONS_API_KEY;

  const params = new URLSearchParams({
    width: String(w),
    height: String(h),
    model,
    nologo: 'true'
  });

  if (input.seed !== undefined) {
    params.set('seed', String(input.seed));
  }
  if (input.enhance !== undefined) {
    params.set('enhance', String(input.enhance));
  }
  if (apiKey) {
    params.set('key', apiKey);
  }

  const encodedPrompt = encodeURIComponent(input.prompt);
  const baseUrl = apiKey ? 'https://gen.pollinations.ai/image' : 'https://image.pollinations.ai/prompt';

  return `${baseUrl}/${encodedPrompt}?${params.toString()}`;
}

export async function requestKeyframe(input: KeyframeInput): Promise<KeyframeResult> {
  const url = buildKeyframeUrl(input);
  const apiKey = input.apiKey || process.env.POLLINATIONS_API_KEY;

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers
  });

  if (response.status === 429) {
    throw new Error('Pollinations rate limit exceeded (HTTP 429). Please provide or top-up POLLINATIONS_API_KEY.');
  }

  if (!response.ok && response.status !== 200) {
    throw new Error(`Pollinations error HTTP ${response.status}: ${response.statusText}`);
  }

  return {
    imageUrl: url,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries())
  };
}

export async function generateMotionClip(
  keyframePath: string,
  prompt: string,
  engine: MotionEngine = 'wan2.1',
  hfToken?: string
): Promise<string> {
  if (engine === 'wan2.2') {
    // Pollinations fast video endpoint for rapid drafting
    const baseUrl = 'https://gen.pollinations.ai/image';
    const apiKey = process.env.POLLINATIONS_API_KEY;
    const keyParam = apiKey ? `&key=${apiKey}` : '';
    return `${baseUrl}/${encodeURIComponent(prompt)}?model=alibaba/wan-2.2-fast&duration=5${keyParam}`;
  }

  const { Client } = await import('@gradio/client');
  // Use active official or mirrored spaces
  let spaceId = 'Wan-AI/Wan2.1';
  if (engine === 'ltx' || engine === 'ltx-2') {
    spaceId = 'Lightricks/ltx-video-distilled';
  } else if (engine === 'hunyuan-video') {
    spaceId = 'multimodalart/Hunyuan-Video-1-5';
  } else if (engine === 'cogvideox-5b') {
    spaceId = 'THUDM/CogVideoX-5B-Space';
  } else if (engine === 'wan2.1-i2v-14b' || engine === 'wan2.1') {
    spaceId = 'Wan-AI/Wan2.1';
  }
  const token = hfToken || process.env.HF_TOKEN;
  const client = await Client.connect(spaceId, token ? { token } : undefined);
  const result = await client.predict('/generate', { image: keyframePath, prompt });
  return (result.data as any)[0];
}
