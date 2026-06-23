import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { getSharedEncoder } from './tiktoken.js';

export interface SurgicalReadOptions {
  maxTokens?: number;
  includeLinkedSections?: boolean;
}

/**
 * Robustly checks if a file is binary by scanning the first 1KB for null bytes.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const fd = await fs.open(filePath, 'r');
    const { bytesRead, buffer } = await fd.read(Buffer.alloc(1024), 0, 1024, 0);
    await fd.close();
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Token-efficient surgical reader that extracts only the most relevant section
 * from a document.
 */
export async function surgicalRead(
  filePath: string,
  query: string,
  options: SurgicalReadOptions = {}
): Promise<string> {
  const maxTokens = options.maxTokens ?? 500;
  const includeLinkedSections = options.includeLinkedSections ?? false;

  if (!existsSync(filePath)) {
    return '';
  }

  const isBin = await isBinaryFile(filePath);
  if (isBin) {
    return '';
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }

  const lines = content.split(/\r?\n/);
  const headings: Array<{ level: number; title: string; lineIndex: number }> = [];

  // Parse headings
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        title: match[2].trim(),
        lineIndex: i
      });
    }
  }

  let startLine = 0;
  let endLine = lines.length;
  let winningHeadingTitle = '';

  if (headings.length > 0) {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let bestScore = -1;
    let winningIndex = -1;

    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      let score = 0;

      // Score matching terms in heading title
      for (const term of queryTerms) {
        if (h.title.toLowerCase().includes(term)) {
          score += 10;
        }
      }

      // Score matching terms in the first few lines of the section content
      const nextHeadingIndex = i + 1 < headings.length ? headings[i + 1].lineIndex : lines.length;
      const previewLines = lines.slice(h.lineIndex + 1, Math.min(nextHeadingIndex, h.lineIndex + 6));
      const previewText = previewLines.join(' ').toLowerCase();
      for (const term of queryTerms) {
        if (previewText.includes(term)) {
          score += 1;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        winningIndex = i;
      }
    }

    if (winningIndex !== -1) {
      const winner = headings[winningIndex];
      winningHeadingTitle = winner.title;
      startLine = winner.lineIndex;
      
      // Find where the section ends: next heading of equal or higher level
      endLine = lines.length;
      for (let i = winningIndex + 1; i < headings.length; i++) {
        if (headings[i].level <= winner.level) {
          endLine = headings[i].lineIndex;
          break;
        }
      }
    }
  }

  let sectionLines = lines.slice(startLine, endLine);
  let sectionText = sectionLines.join('\n');

  // Handle linked sections if enabled
  if (includeLinkedSections && headings.length > 0) {
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    const matches = [...sectionText.matchAll(linkRegex)];
    const resolvedTitles = new Set<string>();

    for (const match of matches) {
      const linkedTitle = match[1].trim();
      if (resolvedTitles.has(linkedTitle) || linkedTitle === winningHeadingTitle) continue;
      resolvedTitles.add(linkedTitle);

      const targetHeadingIndex = headings.findIndex(h => h.title.toLowerCase() === linkedTitle.toLowerCase());
      if (targetHeadingIndex !== -1) {
        const targetHeading = headings[targetHeadingIndex];
        const nextHeadingIndex = targetHeadingIndex + 1 < headings.length ? headings[targetHeadingIndex + 1].lineIndex : lines.length;
        const targetSectionLines = lines.slice(targetHeading.lineIndex + 1, nextHeadingIndex);
        
        // Extract 3-line snippet
        const nonHeaderLines = targetSectionLines
          .map(l => l.trim())
          .filter(l => l !== '' && !/^#/.test(l));
        const snippet = nonHeaderLines.slice(0, 3).join('\n');

        if (snippet) {
          sectionText += `\n\n### Linked Section: ${targetHeading.title}\n${snippet}`;
        }
      }
    }
  }

  // Pre-truncate string to avoid tokenizing huge amounts of text unnecessarily
  const charLimit = maxTokens * 15; // 15 chars/token is a safe upper bound
  if (sectionText.length > charLimit) {
    sectionText = sectionText.substring(0, charLimit);
  }

  // Enforce token limit using tiktoken
  const encoder = getSharedEncoder();
  const tokens = encoder.encode(sectionText);
  if (tokens.length > maxTokens) {
    sectionText = encoder.decode(tokens.slice(0, maxTokens)) + '... [truncated]';
  }

  return sectionText;
}
