import { ProviderRegistry } from '../../providers/registry.js';
import type { ChatResponse } from '../../providers/types.js';

export interface StoryInput {
  premise: string;
  characters?: Array<{ name: string; description: string; motivation?: string }>;
  tone?: string;
  scene?: string;
  model?: string;
  apiKey?: string;
}

export async function generateStoryScript(input: StoryInput): Promise<string> {
  const registry = ProviderRegistry.getInstance();
  const aion = registry.getProvider('aionlabs');
  const apiKey = input.apiKey || process.env.AIONLABS_API_KEY;

  const charactersBlock = input.characters?.length
    ? `\nCharacters:\n${input.characters.map((c) => `- ${c.name}: ${c.description}${c.motivation ? ` (Goal: ${c.motivation})` : ''}`).join('\n')}`
    : '';

  const systemPrompt = `You are a master cinematic storyteller and roleplaying dramatist. 
Produce an immersive narrative scene with vivid dialogue, character tension, emotional subtext, and clear visual cues.
Format with [SCENE], [VISUAL], [ACTION], and character lines.`;

  const userPrompt = `Premise: ${input.premise}${charactersBlock}
Tone: ${input.tone || 'cinematic, high-tension'}
Target Scene / Conflict: ${input.scene || 'Opening scene establishing the core crisis'}`;

  const targetModel = input.model || 'aion-labs/aion-3.5';

  if (aion && (apiKey || aion.isAvailable())) {
    try {
      const resp = (await aion.chat({
        model: targetModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })) as ChatResponse;

      const choice = resp.choices?.[0]?.message?.content;
      if (choice && typeof choice === 'string') {
        return choice.trim();
      }
    } catch (err: any) {
      if (process.env.DEBUG) {
        console.warn(`[StoryRouter] AionLabs route failed (${err.message}), falling back to director reasoning.`);
      }
    }
  }

  // Fallback to local director or Groq reasoning if AionLabs is unavailable
  const groq = registry.getProvider('groq');
  if (groq && groq.isAvailable()) {
    const resp = await groq.chat({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    return resp.choices?.[0]?.message?.content?.trim() || '';
  }

  return `[SCENE: ${input.scene || 'ESTABLISHING'}]\n[VISUAL: Cinematic opening based on premise: ${input.premise}]\nNARRATOR: The story unfolds.`;
}
