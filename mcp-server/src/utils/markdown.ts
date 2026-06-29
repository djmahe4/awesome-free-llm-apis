export function toMarkdownResponse(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '_No response generated._';

  // Keep existing markdown as-is.
  if (
    /(^|\n)#{1,6}\s/.test(text) ||
    /```[\s\S]*```/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /(^|\n)\s*[-*]\s+/.test(text)
  ) {
    return text;
  }

  // If response looks like JSON, convert to markdown code block.
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    return `\`\`\`json\n${text}\n\`\`\``;
  }

  return text;
}
