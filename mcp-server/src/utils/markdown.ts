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
export function squeezeJsonReply(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  try {
    JSON.parse(trimmed);
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return trimmed.replace(/\n+(?=[{\[])/g, '').replace(/([}\]])\n+/g, '$1');
    }
  } catch {}

  return trimmed;
}
