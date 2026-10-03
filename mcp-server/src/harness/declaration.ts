import { promises as fs, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { findAgentsMdPath } from '../utils/agents-md-locator.js';
import type { HarnessDeclaration } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/harness/declaration.js -> dist/../harness/*.yaml (source layout mirrored by postbuild copy)
/** The bundled declarations dir — exported so registry.ts can classify `source: 'builtin'`. */
export const DECLARATIONS_DIR = path.resolve(__dirname, '..', '..', 'harness');

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

/** True when the input should be treated as a file path rather than a bare declaration name. */
function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\') || /\.ya?ml$/i.test(value);
}

/**
 * T4 — validates the optional `harness.lane`/`harness.maxCycles` pair.
 * Fail-closed at load: a lane phase must be an executable (non-top_level)
 * role the step engine can actually run, phases are unique so task-ids stay
 * unambiguous (T5's `phase`/`phase#cN` scheme breaks on duplicates), and
 * maxCycles is only meaningful WITH a lane. Absent lane = legacy linear
 * behavior, never an error.
 */
function validateLane(decl: HarnessDeclaration, name: string, filePath: string): void {
  const lane = decl.harness.lane;
  const maxCycles = decl.harness.maxCycles;
  const where = `Harness declaration '${name}' (${filePath})`;

  if (maxCycles !== undefined && lane === undefined) {
    throw new Error(`${where}: maxCycles declared without lane — cycle caps only apply to a cyclic lane`);
  }
  if (lane === undefined) return;

  if (!Array.isArray(lane) || lane.length === 0) {
    throw new Error(`${where}: lane must be a non-empty array of phase names`);
  }
  const seen = new Set<string>();
  for (const phase of lane) {
    if (typeof phase !== 'string' || phase.length === 0) {
      throw new Error(`${where}: lane phase names must be non-empty strings (got: ${JSON.stringify(phase)})`);
    }
    if (seen.has(phase)) {
      throw new Error(`${where}: duplicate lane phase '${phase}' — phases must be unique`);
    }
    seen.add(phase);
    if (phase === 'top_level') {
      throw new Error(`${where}: lane phase 'top_level' is the supervisor and cannot run as a phase`);
    }
    if (!decl.roles[phase]) {
      throw new Error(`${where}: lane phase '${phase}' is not a role defined under roles:`);
    }
  }

  if (maxCycles !== undefined && (!Number.isInteger(maxCycles) || maxCycles < 1)) {
    throw new Error(`${where}: maxCycles must be an integer >= 1 (got: ${JSON.stringify(maxCycles)})`);
  }
}

/**
 * Resolves the on-disk YAML file for a declaration reference. Two forms:
 *
 * 1. Path-like (absolute, contains a separator, or ends .yaml/.yml) — used for
 *    ad-hoc declarations outside any convention; relative paths resolve against
 *    workspaceRoot (else cwd). Operator-supplied, so absolute paths are allowed.
 * 2. Bare name — uniform workspace dir wins: `<workspaceRoot>/.free-llm-mcp/harness/<name>.yaml`
 *    (the shared artifacts location every harness tool uses), then the legacy
 *    `<workspaceRoot>/harness/<name>.yaml`, then the built-in mcp-server/harness/ dir.
 *    `path.basename` still strips separators so a name can't traverse out of any directory.
 */
export async function resolveDeclarationPath(nameOrPath: string, workspaceRoot?: string): Promise<string> {
  if (isPathLike(nameOrPath)) {
    const filePath = path.isAbsolute(nameOrPath)
      ? nameOrPath
      : path.resolve(workspaceRoot ?? process.cwd(), nameOrPath);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      throw new Error(`Harness declaration file not found: ${filePath}`);
    }
    return filePath;
  }

  const safeName = path.basename(nameOrPath); // no path traversal via harness name
  const candidates = [
    workspaceRoot ? path.join(workspaceRoot, '.free-llm-mcp', 'harness', `${safeName}.yaml`) : undefined,
    workspaceRoot ? path.join(workspaceRoot, 'harness', `${safeName}.yaml`) : undefined,
    path.join(DECLARATIONS_DIR, `${safeName}.yaml`),
  ].filter((p): p is string => !!p);

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(
    `Harness declaration '${nameOrPath}' not found (looked in: ${candidates.join(', ')})`,
  );
}

/**
 * Loads a harness declaration — by bare name (uniform `<root>/.free-llm-mcp/harness/`
 * first, then legacy `<root>/harness/`, built-in last) or by explicit .yaml path.
 * Declarations are read-only policy, cached by resolved file path + workspaceRoot
 * for the process lifetime — a harness's allowlist/budget shouldn't drift mid-run
 * just because someone edited the YAML (or AGENTS.md) on disk while a run was executing.
 *
 * Relative `harness.allowedWorkspaceRoots` entries are resolved against the
 * declaration file's own directory, so an external declaration (e.g.
 * ctf-katana/harness/appsec.yaml) can say `allowedWorkspaceRoots: ['.']` and
 * mean "the folder it lives in" regardless of the server process cwd.
 */
export async function loadHarnessDeclaration(name = 'research-analysis', workspaceRoot?: string): Promise<HarnessDeclaration> {
  const filePath = await resolveDeclarationPath(name, workspaceRoot);
  const cacheKey = `${filePath}::${workspaceRoot ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const raw = await fs.readFile(filePath, 'utf-8');
  const parsed = parseYaml(raw) as HarnessDeclaration;

  if (!parsed?.harness?.name || !parsed?.roles || typeof parsed.roles !== 'object') {
    throw new Error(`Malformed harness declaration '${name}' (${filePath}): missing harness.name or roles`);
  }

  validateLane(parsed, name, filePath);
  const allowedRoots = parsed.harness.allowedWorkspaceRoots;
  if (Array.isArray(allowedRoots)) {
    const declDir = path.dirname(filePath);
    parsed.harness.allowedWorkspaceRoots = allowedRoots.map(root =>
      path.isAbsolute(root) ? root : path.resolve(declDir, root),
    );
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
