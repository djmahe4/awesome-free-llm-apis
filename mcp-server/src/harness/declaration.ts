import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { HarnessDeclaration } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/harness/declaration.js -> dist/../harness/*.yaml (source layout mirrored by postbuild copy)
const DECLARATIONS_DIR = path.resolve(__dirname, '..', '..', 'harness');

const cache = new Map<string, HarnessDeclaration>();

/**
 * Loads a named harness declaration (default: the built-in research-analysis
 * harness). Declarations are read-only policy, cached by name for the process
 * lifetime — a harness's allowlist/budget shouldn't drift mid-run just because
 * someone edited the YAML on disk while a run was executing.
 */
export async function loadHarnessDeclaration(name = 'research-analysis'): Promise<HarnessDeclaration> {
  const cached = cache.get(name);
  if (cached) return cached;

  const safeName = path.basename(name); // no path traversal via harness name
  const filePath = path.join(DECLARATIONS_DIR, `${safeName}.yaml`);
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = parseYaml(raw) as HarnessDeclaration;

  if (!parsed?.harness?.name || !parsed?.roles || typeof parsed.roles !== 'object') {
    throw new Error(`Malformed harness declaration '${name}': missing harness.name or roles`);
  }

  cache.set(name, parsed);
  return parsed;
}

export function listRoleNames(decl: HarnessDeclaration): string[] {
  return Object.keys(decl.roles);
}

/** Picks the first role (excluding top_level) whose triggers match the goal text, else 'researcher' if present, else the first non-top_level role. */
export function selectRole(decl: HarnessDeclaration, goal: string): string {
  const lower = goal.toLowerCase();
  for (const [role, def] of Object.entries(decl.roles)) {
    if (role === 'top_level') continue;
    if (def.triggers?.some(t => lower.includes(t.toLowerCase()))) return role;
  }
  if (decl.roles.researcher) return 'researcher';
  const fallback = Object.keys(decl.roles).find(r => r !== 'top_level');
  if (!fallback) throw new Error(`Harness declaration '${decl.harness.name}' has no non-top_level role to select`);
  return fallback;
}
