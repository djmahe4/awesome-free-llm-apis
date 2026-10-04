import path from 'node:path';

export function generateUnifiedDiff(
  relPath: string,
  hashTag: string,
  originalLines: string[],
  patchedLines: string[],
  maxDiffLines = 100
): { unifiedDiff: string; origSnippet: string; replSnippet: string; startLine: number } {
  // 1. Identify common prefix and common suffix
  let prefix = 0;
  while (
    prefix < originalLines.length &&
    prefix < patchedLines.length &&
    originalLines[prefix] === patchedLines[prefix]
  ) {
    prefix++;
  }

  let origSuffix = originalLines.length - 1;
  let patchSuffix = patchedLines.length - 1;
  while (
    origSuffix >= prefix &&
    patchSuffix >= prefix &&
    originalLines[origSuffix] === patchedLines[patchSuffix]
  ) {
    origSuffix--;
    patchSuffix--;
  }

  // Context padding (3 lines of context around change)
  const contextPad = 3;
  const origStart = Math.max(0, prefix - contextPad);
  const origEnd = Math.min(originalLines.length, origSuffix + 1 + contextPad);
  const patchStart = Math.max(0, prefix - contextPad);
  const patchEnd = Math.min(patchedLines.length, patchSuffix + 1 + contextPad);

  const origCount = origEnd - origStart;
  const patchCount = patchEnd - patchStart;
  const startLine = origStart + 1;

  const hunkLines: string[] = [];
  hunkLines.push(`--- ${relPath} ${hashTag}`);
  hunkLines.push(`+++ ${relPath} (proposed)`);
  hunkLines.push(`@@ -${startLine},${origCount} +${patchStart + 1},${patchCount} @@`);

  // Leading context
  for (let i = origStart; i < prefix; i++) {
    hunkLines.push(` ${originalLines[i]}`);
  }

  // Deleted lines from original
  const delCount = origSuffix - prefix + 1;
  if (delCount > 0) {
    if (delCount > maxDiffLines) {
      for (let i = prefix; i < prefix + 15; i++) {
        hunkLines.push(`-${originalLines[i]}`);
      }
      hunkLines.push(`- ... [${delCount - 25} lines omitted] ...`);
      for (let i = origSuffix - 9; i <= origSuffix; i++) {
        hunkLines.push(`-${originalLines[i]}`);
      }
    } else {
      for (let i = prefix; i <= origSuffix; i++) {
        hunkLines.push(`-${originalLines[i]}`);
      }
    }
  }

  // Added lines in patch
  const addCount = patchSuffix - prefix + 1;
  if (addCount > 0) {
    if (addCount > maxDiffLines) {
      for (let i = prefix; i < prefix + 15; i++) {
        hunkLines.push(`+${patchedLines[i]}`);
      }
      hunkLines.push(`+ ... [${addCount - 25} lines omitted] ...`);
      for (let i = patchSuffix - 9; i <= patchSuffix; i++) {
        hunkLines.push(`+${patchedLines[i]}`);
      }
    } else {
      for (let i = prefix; i <= patchSuffix; i++) {
        hunkLines.push(`+${patchedLines[i]}`);
      }
    }
  }

  // Trailing context
  for (let i = origSuffix + 1; i < origEnd; i++) {
    hunkLines.push(` ${originalLines[i]}`);
  }

  const origSnippet = originalLines.slice(origStart, origEnd).join('\n');
  const replSnippet = patchedLines.slice(patchStart, patchEnd).join('\n');

  return {
    unifiedDiff: hunkLines.join('\n') + '\n',
    origSnippet,
    replSnippet,
    startLine,
  };
}

/**
 * Computes a target-anchored sliding window snippet instead of a naive slice(0, 10).
 * Centers preview around the first modification line while preserving header context.
 */
function computeWindowedSnippet(
  originalLines: string[],
  patchedLines: string[],
  windowSize = 12
): { origSnippet: string; replSnippet: string; startLine: number } {
  // Find first modified line (1-indexed)
  let diffLine = 1;
  const maxL = Math.max(originalLines.length, patchedLines.length);
  for (let i = 0; i < maxL; i++) {
    if (originalLines[i] !== patchedLines[i]) {
      diffLine = i + 1;
      break;
    }
  }

  const half = Math.floor(windowSize / 2);
  const startLine = Math.max(1, diffLine - half);
  const origSnippet = originalLines.slice(startLine - 1, startLine - 1 + windowSize).join('\n');
  const replSnippet = patchedLines.slice(startLine - 1, startLine - 1 + windowSize).join('\n');

  return { origSnippet, replSnippet, startLine };
}

/** Assert path is inside workspaceRoot to prevent path traversal on writes. */
export function assertSafe(fullPath: string, workspaceRoot: string): void {
  const normalized = path.resolve(fullPath);
  const root = path.resolve(workspaceRoot);
  if (!normalized.startsWith(root + path.sep) && normalized !== root) {
    throw new Error(`[security] Path traversal blocked: ${normalized} is outside ${root}`);
  }
}

