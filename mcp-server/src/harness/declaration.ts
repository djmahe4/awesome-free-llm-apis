import { promises as fs, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { findAgentsMdPath } from '../utils/agents-md-locator.js';
import type { HarnessDeclaration } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/harness/declaration.js -> dist/../harness/*.yaml (source layout mirrored by postbuild copy)
const DECLARATIONS_DIR = path.resolve(__dirname, '..', '..', 'harness');

const cache = new Map<string, HarnessDeclaration>();

/**
 * Reads an optional `## Skill Access` fenced YAML block from AGENTS.md, e.g.:
 * ```yaml
 * roles:
 *   researcher: { skillTags: [research, osint] }
 *   coder:      { skillTags: [coding] }
 * ```
 * Same locator precedence as persona-detector.ts's AGENTS.md lookup
 * (canonical .agents/AGENTS.md, falling back to legacy root AGENTS.md), and
 * the same `yaml` parser already used for harness declarations — no new
 * parsing dependency introduced for this.
 */
function loadAgentsSkillAccess(workspaceRoot: string | undefined): Record<string, string[]> | null {
  if (!workspaceRoot) return null;
  const candidates = [findAgentsMdPath(workspaceRoot), path.join(workspaceRoot, 'AGENTS.md')]
    .filter((p): p is string => !!p);

  for (const agentsMdPath of candidates) {
    try {
      if (!existsSync(agentsMdPath)) continue;
      const content = readFileSync(agentsMdPath, 'utf-8');
      const match = content.match(/##\s*Skill Access\s*\n```ya?ml\n([\s\S]*?)```/i);
      if (!match) continue;
      const block = parseYaml(match[1]) as { roles?: Record<string, { skillTags?: string[] }> };
      if (!block?.roles || typeof block.roles !== 'object') continue;

      const result: Record<string, string[]> = {};
      for (const [role, def] of Object.entries(block.roles)) {
        if (Array.isArray(def?.skillTags)) result[role] = def.skillTags.filter(t => typeof t === 'string');
      }
      return result;
    } catch {
      // Malformed or unreadable AGENTS.md skill-access block — ignored, not
      // fatal: absence of this block means "no extra restriction", same as
      // today's behavior before this feature existed.
    }
  }
  return null;
}

/**
 * Merges AGENTS.md's per-role skillTags (if declared) into the harness
 * declaration's own role allowlists, as an additional `execute_skill`
 * constraint rule — reuses policy.ts's array-membership constraintsMatch
 * rather than inventing a parallel permission system. Only applies to role
 * names that already exist in BOTH the harness YAML and AGENTS.md; a role
 * AGENTS.md mentions that isn't part of this harness is ignored (AGENTS.md
 * can't invent or widen roles it doesn't control).
 */
function applySkillAccess(decl: HarnessDeclaration, skillAccess: Record<string, string[]> | null): HarnessDeclaration {
  if (!skillAccess) return decl;
  for (const [role, skillTags] of Object.entries(skillAccess)) {
    const roleDef = decl.roles[role];
    if (!roleDef || skillTags.length === 0) continue;
    roleDef.tools = [...roleDef.tools, { tool: 'execute_skill', constraints: { skillTags } }];
  }
  return decl;
}

/**
 * Loads a named harness declaration (default: the built-in research-analysis
 * harness). Declarations are read-only policy, cached by name+workspaceRoot
 * for the process lifetime — a harness's allowlist/budget shouldn't drift
 * mid-run just because someone edited the YAML (or AGENTS.md) on disk while
 * a run was executing.
 */
export async function loadHarnessDeclaration(name = 'research-analysis', workspaceRoot?: string): Promise<HarnessDeclaration> {
  const cacheKey = `${name}::${workspaceRoot ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const safeName = path.basename(name); // no path traversal via harness name
  const filePath = path.join(DECLARATIONS_DIR, `${safeName}.yaml`);
  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = parseYaml(raw) as HarnessDeclaration;

  if (!parsed?.harness?.name || !parsed?.roles || typeof parsed.roles !== 'object') {
    throw new Error(`Malformed harness declaration '${name}': missing harness.name or roles`);
  }

  const withSkillAccess = applySkillAccess(parsed, loadAgentsSkillAccess(workspaceRoot));

  cache.set(cacheKey, withSkillAccess);
  return withSkillAccess;
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
