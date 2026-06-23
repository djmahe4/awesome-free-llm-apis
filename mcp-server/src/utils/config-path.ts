import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

/**
 * Resolves the configuration directory (.free-llm-mcp or .free-llms-mcp) by:
 * 1. Searching parent directories (up to 2 levels, excluding user profile directory).
 * 2. Searching startDir itself.
 * 3. Searching child directories (up to 2 levels).
 * Prioritizes the folder name ".free-llms-mcp" over ".free-llm-mcp".
 * Defaults to startDir/.free-llm-mcp if none exist.
 */
export function resolveConfigDir(startDir: string): string {
  if (!startDir) {
    return path.join(os.homedir(), '.free-llm-mcp');
  }

  const normStart = path.resolve(startDir);
  const homeDir = path.resolve(os.homedir());
  const folderNames = ['.free-llms-mcp', '.free-llm-mcp'];
  
  const searchDirs: string[] = [];

  // 1. Search up to 2 immediate parent directories (excluding os.homedir())
  let current = normStart;
  for (let i = 0; i < 2; i++) {
    const parent = path.dirname(current);
    if (!parent || parent === current || parent === homeDir) {
      break;
    }
    if (parent === '/' || /^[A-Za-z]:[\\\/]?$/.test(parent)) {
      searchDirs.push(parent);
      break;
    }
    searchDirs.push(parent);
    current = parent;
  }

  // 2. Search startDir itself
  searchDirs.push(normStart);

  // 3. Search up to 2 levels of child directories
  const childDirs: string[] = [];
  try {
    const depth1 = fs.readdirSync(normStart, { withFileTypes: true });
    for (const entry of depth1) {
      if (entry.isDirectory()) {
        const entryName = entry.name.toLowerCase();
        if (
          entryName === '.git' ||
          entryName === 'node_modules' ||
          entryName === 'venv' ||
          entryName === '.venv'
        ) {
          continue;
        }
        const p1 = path.join(normStart, entry.name);
        childDirs.push(p1);
      }
    }

    // Depth 2 children
    for (const subdir of childDirs) {
      try {
        const depth2 = fs.readdirSync(subdir, { withFileTypes: true });
        for (const entry of depth2) {
          if (entry.isDirectory()) {
            const entryName = entry.name.toLowerCase();
            if (
              entryName === '.git' ||
              entryName === 'node_modules' ||
              entryName === 'venv' ||
              entryName === '.venv'
            ) {
              continue;
            }
            const p2 = path.join(subdir, entry.name);
            childDirs.push(p2);
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  } catch {
    // Ignore read errors
  }

  searchDirs.push(...childDirs);

  // 4. Resolve: Check ".free-llms-mcp" first, then ".free-llm-mcp" across all searchDirs
  for (const name of folderNames) {
    for (const dir of searchDirs) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
          return p;
        }
      } catch {
        // ignore errors
      }
    }
  }

  // 5. Default fallback: create in startDir
  return path.join(normStart, '.free-llm-mcp');
}
