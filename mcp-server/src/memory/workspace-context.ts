import fs from 'node:fs/promises';
import path from 'node:path';

export interface DynamicWorkspaceContext {
  name: string;
  description: string;
  primaryLanguages: string[];
  keyComponents: string[];
  contextSummary: string;
}

/**
 * Dynamically derives workspace context from the provided workspace root.
 * Inspects package.json, pyproject.toml, AGENTS.md, local skill definitions,
 * and directory structure to provide accurate, grounded context for LLM prompts
 * across any arbitrary repository or directory.
 */
export async function extractDynamicWorkspaceContext(workspaceRoot: string): Promise<DynamicWorkspaceContext> {
  const baseName = path.basename(workspaceRoot) || 'workspace';
  let name = baseName;
  let description = '';
  const keyComponents: string[] = [];
  const primaryLanguages: string[] = [];

  // 1. Inspect package.json (Node/JS/TS)
  try {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    if (pkg.name) name = pkg.name;
    if (pkg.description) description = pkg.description;
    primaryLanguages.push('javascript', 'typescript');

    if (pkg.dependencies && typeof pkg.dependencies === 'object') {
      keyComponents.push(...Object.keys(pkg.dependencies).slice(0, 8));
    }
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      const topScripts = Object.keys(pkg.scripts).slice(0, 5);
      keyComponents.push(...topScripts.map(s => `npm:${s}`));
    }
  } catch {}

  // 2. Inspect pyproject.toml / requirements.txt (Python)
  try {
    const pyPath = path.join(workspaceRoot, 'pyproject.toml');
    const raw = await fs.readFile(pyPath, 'utf-8');
    primaryLanguages.push('python');
    const nameMatch = raw.match(/name\s*=\s*["']([^"']+)["']/);
    if (nameMatch && (name === baseName || !name)) name = nameMatch[1];
    const descMatch = raw.match(/description\s*=\s*["']([^"']+)["']/);
    if (descMatch && !description) description = descMatch[1];
  } catch {}

  // 3. Inspect Cargo.toml (Rust) / go.mod (Go)
  try {
    const cargoPath = path.join(workspaceRoot, 'Cargo.toml');
    const raw = await fs.readFile(cargoPath, 'utf-8');
    primaryLanguages.push('rust');
    const nameMatch = raw.match(/name\s*=\s*["']([^"']+)["']/);
    if (nameMatch && (name === baseName || !name)) name = nameMatch[1];
  } catch {}

  try {
    const goPath = path.join(workspaceRoot, 'go.mod');
    const raw = await fs.readFile(goPath, 'utf-8');
    primaryLanguages.push('go');
    const modMatch = raw.match(/module\s+([^\s\n\r]+)/);
    if (modMatch && (name === baseName || !name)) name = path.basename(modMatch[1]);
  } catch {}

  // 4. Inspect AGENTS.md / .agents/AGENTS.md / GEMINI.md
  try {
    const agentPaths = [
      path.join(workspaceRoot, '.agents', 'AGENTS.md'),
      path.join(workspaceRoot, 'AGENTS.md'),
      path.join(workspaceRoot, 'GEMINI.md'),
    ];
    for (const ap of agentPaths) {
      try {
        const raw = await fs.readFile(ap, 'utf-8');
        const descMatch = raw.match(/(?:Description|Project Context)[:*\s]+([^\n\r]+)/i);
        if (descMatch && (!description || description === 'Software project')) {
          const val = descMatch[1].replace(/^[#\-*\s]+/, '').trim();
          if (val && !val.includes('(fill this in)')) {
            description = val;
          }
        }
        break;
      } catch {}
    }
  } catch {}

  // 5. Discover project skills (.free-llm-mcp/skills, skills, .agents/skills)
  try {
    const skillRoots = [
      path.join(workspaceRoot, '.free-llm-mcp', 'skills'),
      path.join(workspaceRoot, 'skills'),
      path.join(workspaceRoot, '.agents', 'skills'),
    ];
    for (const sr of skillRoots) {
      try {
        const entries = await fs.readdir(sr, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isDirectory() || ent.name.endsWith('.md')) {
            keyComponents.push(`skill:${ent.name.replace(/\.md$/, '')}`);
          }
        }
      } catch {}
    }
  } catch {}

  // 6. Inspect top-level source folders or tools (src, lib, app, internal, tools)
  try {
    const subDirs = ['src', 'lib', 'app', 'internal', 'tools'];
    for (const sub of subDirs) {
      const fullSub = path.join(workspaceRoot, sub);
      try {
        const entries = await fs.readdir(fullSub, { withFileTypes: true });
        for (const ent of entries.slice(0, 10)) {
          if (!ent.name.startsWith('.') && !ent.name.endsWith('.test.ts') && !ent.name.endsWith('.spec.ts')) {
            keyComponents.push(ent.name.replace(/\.[^/.]+$/, ''));
          }
        }
      } catch {}
    }
  } catch {}

  const uniqueComponents = Array.from(new Set(keyComponents)).slice(0, 15);
  const compStr = uniqueComponents.length > 0 ? `Key modules/tools: ${uniqueComponents.join(', ')}.` : '';
  const descStr = description ? ` (${description})` : '';
  const contextSummary = `Workspace "${name}"${descStr}. ${compStr}`.trim();

  return {
    name,
    description: description || 'Software project',
    primaryLanguages: Array.from(new Set(primaryLanguages)),
    keyComponents: uniqueComponents,
    contextSummary,
  };
}
