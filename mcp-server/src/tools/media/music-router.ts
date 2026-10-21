export interface MusicInput {
  emotion: string;
  tempo_bpm: number;
  duration_s: number;
  style?: string;
}

export function buildMusicPrompt(input: MusicInput): string {
  return `Generate ${input.duration_s}s of ${input.emotion} ${input.style || 'orchestral'} music at ${input.tempo_bpm}bpm. No vocals. High quality instrumental stems suitable for film scoring.`;
}

export async function generateBgm(
  prompt: string,
  engine: 'musicgen' | 'stable-audio' = 'musicgen',
  hfToken?: string
): Promise<string> {
  const { Client } = (await (Function('m', 'return import(m)')('@gradio/client'))) as any;
  const spaceId = engine === 'musicgen' ? 'facebook/MusicGen' : 'artificialguybr/Stable-Audio-Open-Zero';
  const token = hfToken || process.env.HF_TOKEN;
  const client = await Client.connect(spaceId, token ? { token } : undefined);
  const result = await client.predict('/predict', { text: prompt });
  return (result.data as any)[0];
}
