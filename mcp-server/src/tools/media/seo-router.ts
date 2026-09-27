export interface SeoInput {
  scriptContent: string;
}

export function buildSeoPrompt(scriptContent: string): string {
  return `Analyze this video script and output a YouTube distribution package in raw JSON:
{
  "title_candidates": [
    "Curiosity Hook Title",
    "Benefit / Problem-Solving Title",
    "Direct Search SEO Title"
  ],
  "description": "Engaging 3-paragraph summary with chapter links and takeaways",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "chapters": [{"timestamp": "00:00", "title": "Introduction"}],
  "thumbnail_prompts": ["High contrast 16:9 FLUX prompt with focal point on right"]
}
Script:
${scriptContent.slice(0, 3000)}`;
}
