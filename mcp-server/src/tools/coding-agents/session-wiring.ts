import { BoundedMap } from '../../utils/bounded-map.js';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import {
  type CodingAgentsInput,
  type CodingAgentsResult,
  formatCodingAgentsMarkdown,
} from './types.js';

export async function discoverWiringTargets(
  newFilePath: string,
  workspaceRoot: string,
  sessionId: string
): Promise<{ wiringFiles: string[]; snippets: string[] }> {
  try {
    const { ContextGatherer } = await import('../../pipeline/middlewares/context-gatherer.js');
    const parentDir = path.dirname(newFilePath);
    const parentBasename = path.basename(parentDir);
    const fileBase = path.basename(newFilePath, path.extname(newFilePath));

    const query = `${parentBasename} ${fileBase} import`;
    const snippets = await ContextGatherer.gatherContext({
      workspaceRoot,
      query,
      limit: 5,
      sessionId,
    });

    const wiringFiles: string[] = [];
    const filePattern = /\[Context\]\s*---\s*FILE:\s*([^\s-]+)\s*---/g;
    for (const snippet of snippets) {
      let m: RegExpExecArray | null;
      while ((m = filePattern.exec(snippet)) !== null) {
        const foundPath = m[1].replace(/\\/g, '/');
        if (
          foundPath !== newFilePath &&
          !wiringFiles.includes(foundPath) &&
          !foundPath.includes('docs/') &&
          !foundPath.endsWith('.md')
        ) {
          wiringFiles.push(foundPath);
        }
      }
    }

    // Check parent barrel export (index.ts / index.js)
    const fullParent = path.resolve(workspaceRoot, parentDir);
    for (const barrelName of ['index.ts', 'index.js']) {
      const fullBarrel = path.join(fullParent, barrelName);
      const barrelRel = path.relative(workspaceRoot, fullBarrel).replace(/\\/g, '/');
      if (barrelRel !== newFilePath && (await fs.pathExists(fullBarrel))) {
        if (!wiringFiles.includes(barrelRel)) wiringFiles.unshift(barrelRel);
      }
    }

    return { wiringFiles, snippets };
  } catch (err: any) {
    console.warn(`[coding-agents] Wiring discovery skipped: ${err.message}`);
    return { wiringFiles: [], snippets: [] };
  }
}

export async function scanCodeFiles(dir: string, maxFiles = 100): Promise<string[]> {
  const result: string[] = [];
  const queue = [dir];
  const SKIP = new Set([
    'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '.cache', 'coverage',
    'docs', 'documentation', 'site', 'specs', 'man', 'manual', 'wiki', 'notes', '.github', '.agents'
  ]);
  const EXT = /\.(ts|js|tsx|jsx|mjs|cjs|json|py|go|rs|c|cpp|h|hpp|java|cs|rb|php|swift|kt)$/i;

  while (queue.length > 0 && result.length < maxFiles) {
    const current = queue.shift()!;
    try {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink() || SKIP.has(entry.name.toLowerCase())) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
        } else if (entry.isFile() && EXT.test(entry.name)) {
          const rel = path.relative(dir, full).replace(/\\/g, '/');
          result.push(rel);
          if (result.length >= maxFiles) break;
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }
  return result;
}

// ── Main Handler ──────────────────────────────────────────────────────────────

// Background pipeline runs, keyed by sessionId — non-dry-run execution can involve
// local/cloud LLM patch generation over several files, and a large prompt can
// legitimately take a long time to produce a large diff. Rather than impose a hard
// timeout (which would kill valid slow work), a real (non-dry-run) run executes
// off the request/response path and callers poll with action:'status', mirroring
// use_free_llm's run/continue/status/abort pattern (RunRegistry.ts). dry_run
// previews, plan creation, and rollback stay synchronous — they're fast and
// callers expect an immediate result.
export { BoundedMap } from '../../utils/bounded-map.js';

// Bounded: each result holds the full patched content of every file in the run, and a long-running
// dashboard used to keep all of them for its lifetime.
export const codingAgentsResultsCache = new BoundedMap<string, CodingAgentsResult>(50);

export function withMarkdown(result: CodingAgentsResult): CodingAgentsResult {
  result.content = formatCodingAgentsMarkdown(result);
  result.markdown = result.content;
  return result;
}

/**
 * Deterministic per-workspace session id (R3): the canonical coding_agents
 * session is a pure function of workspaceRoot, so CAS file history,
 * checkpoint rollback, and the background run key never fragment within one
 * workspace. Other tools (use_free_llm etc.) keep their explicit-override behaviour.
 */
export function stableWorkspaceSessionId(workspaceRoot?: string): string {
  const resolved = path.resolve(workspaceRoot || process.cwd());
  return `omp-ws-${crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`;
}

/**
 * In-memory alias table: a caller-chosen input.sessionId is preserved and
 * resolves to its canonical workspace session, so polling status/abort/resume
 * with the id the tool was originally called with keeps working even though
 * the fallback to the workspace session happened internally. Each entry
 * remembers the workspace it was registered under, and an alias is only reused
 * when the call supplies that same workspace (a status/abort call without a
 * workspace may reuse it — those only read the in-process run registry), so a
 * reused caller id can never bind another workspace's file I/O to this
 * session. First registration wins; the canonical id also self-resolves so
 * polling with the returned sessionId needs no workspaceRoot. Not persisted
 * (in-memory only).
 */
type SessionAlias = { root: string; canonical: string };

export const sessionAliases = new BoundedMap<string, SessionAlias>(500);

export function aliasServesCall(
  alias: SessionAlias | undefined,
  input: CodingAgentsInput,
  resolvedRoot: string,
): alias is SessionAlias {
  if (!alias) return false;
  if (input.workspaceRoot && input.workspaceRoot.trim() !== '') return alias.root === resolvedRoot;
  return input.action === 'status' || input.action === 'abort';
}
