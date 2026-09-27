export interface LyricsInput {
  theme: string;
  meter?: 'iambic_pentameter' | 'trochaic_tetrameter' | 'free_verse';
  rhymeScheme?: 'AABB' | 'ABAB' | 'AABC';
}

export function formatLyricsPrompt(input: LyricsInput): string {
  return `Act as a master lyricist and vocal prosody planner.
Theme: ${input.theme}
Target Meter: ${input.meter || 'iambic_pentameter'}
Target Rhyme Scheme: ${input.rhymeScheme || 'AABB'}

Instructions:
1. Conduct chain-of-thought syllabic counting (syllable count) for every line.
2. Validate metric stress patterns so vocal prosody does not collapse during TTS.
3. Output the planned verses with [syllable_count] tags per line.
Primary Model: deepseek-r1-distill-qwen-32b`;
}
