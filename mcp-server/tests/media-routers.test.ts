import { describe, it, expect } from 'vitest';
import { buildKeyframeUrl } from '../src/tools/media/video-router.js';
import { formatLyricsPrompt } from '../src/tools/media/lyrics-router.js';
import { buildSeoPrompt } from '../src/tools/media/seo-router.js';
import { buildMusicPrompt } from '../src/tools/media/music-router.js';

describe('Media Sub-Routers', () => {
  it('buildKeyframeUrl formats valid Pollinations FLUX query with dimensions and model', () => {
    const url = buildKeyframeUrl({ prompt: 'cinematic hero shot', width: 1280, height: 720 });
    expect(url).toContain('https://image.pollinations.ai/prompt/');
    expect(url).toContain('width=1280');
    expect(url).toContain('height=720');
    expect(url).toContain('model=flux');
  });

  it('buildKeyframeUrl switches to gen.pollinations.ai and attaches key when apiKey provided', () => {
    const url = buildKeyframeUrl({ prompt: 'hero', apiKey: 'sk_test_123', enhance: true });
    expect(url).toContain('https://gen.pollinations.ai/image/');
    expect(url).toContain('key=sk_test_123');
    expect(url).toContain('enhance=true');
  });

  it('formatLyricsPrompt enforces syllabic counting and stress pattern rules', () => {
    const prompt = formatLyricsPrompt({ theme: 'space exploration', meter: 'iambic_pentameter', rhymeScheme: 'AABB' });
    expect(prompt).toContain('iambic_pentameter');
    expect(prompt).toContain('AABB');
    expect(prompt).toContain('syllable count');
  });

  it('buildSeoPrompt requests curiosity, benefit, and direct search titles', () => {
    const prompt = buildSeoPrompt('Full explainer script content');
    expect(prompt).toContain('Curiosity Hook');
    expect(prompt).toContain('Benefit');
    expect(prompt).toContain('thumbnail_prompts');
  });

  it('buildMusicPrompt includes tempo, emotion, and duration constraints', () => {
    const prompt = buildMusicPrompt({ emotion: 'epic', tempo_bpm: 120, duration_s: 30 });
    expect(prompt).toContain('120bpm');
    expect(prompt).toContain('epic');
    expect(prompt).toContain('30');
  });
});
