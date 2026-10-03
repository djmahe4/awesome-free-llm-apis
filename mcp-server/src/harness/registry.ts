/**
 * T2 — Declaration registry: global tracking + hash provenance.
 *
 * Every declaration file a harness run deploys with is recorded (upsert) in
 * `<workspaceRoot>/.free-llm-mcp/registry.json` under `withFileLock`:
 *
 *   { path, sha256, source: 'builtin' | 'workspace' | 'path', trackedAt }
 *
 * `source` classification: `builtin` = mcp-server's bundled harness dir,
 * `workspace` = inside workspaceRoot, `path` = anywhere else (ad-hoc file).
 * The run additionally pins `declarationPath` + `declarationSha256` (run.json),
 * and any later resume re-hashes the file — a changed or deleted declaration
 * emits a WARN trace `declaration_tamper`. The trace never blocks the run:
 * policy is cached for the process lifetime (declaration.ts), the alert is the
 * point — same non-fatal philosophy as the boot reconciliation hooks.
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { withFileLock } from '../utils/file-lock.js';
import { DECLARATIONS_DIR, resolveDeclarationPath, loadedDeclarationRecord } from './declaration.js';
import type { HarnessRun } from './types.js';
import type { HarnessStore } from './store.js';

export interface RegistryEntry {
  path: string;
  sha256: string;
  source: 'builtin' | 'workspace' | 'path';
  trackedAt: number;
}

interface RegistryFile {
  version: 1;
  declarations: Record<string, RegistryEntry>;
}

function registryPath(workspaceRoot?: string): string {
  return path.join(path.resolve(workspaceRoot ?? process.cwd()), '.free-llm-mcp', 'registry.json');
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function classify(filePath: string, workspaceRoot?: string): RegistryEntry['source'] {
  if (filePath === DECLARATIONS_DIR || filePath.startsWith(DECLARATIONS_DIR + path.sep)) return 'builtin';
  if (workspaceRoot) {
    const ws = path.resolve(workspaceRoot);
    if (filePath.startsWith(ws + path.sep)) return 'workspace';
  }
  return 'path';
}

/** Missing or corrupt registry starts fresh — provenance is best-effort, never fatal. */
async function readRegistryFile(rp: string): Promise<RegistryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(rp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.declarations && typeof parsed.declarations === 'object') {
      return parsed as RegistryFile;
    }
  } catch { /* missing or unreadable — start fresh */ }
  return { version: 1, declarations: {} };
}

/**
 * Resolves, hashes and upserts a declaration into the workspace registry.
 * `trackedAt` is first-seen time (kept on re-track); `sha256` follows the
 * bytes this process parsed when a load record exists — so a run pins the
 * hash of the policy actually enforced, not whatever is on disk a moment
 * later (closes the read-then-hash race between load and track) — else the
 * current file content. Write is tmp+rename inside `withFileLock` so a
 * crash or concurrent deploy can't leave a torn registry.json.
 */
export async function trackDeclaration(nameOrPath: string, workspaceRoot?: string): Promise<RegistryEntry> {
  const filePath = path.resolve(await resolveDeclarationPath(nameOrPath, workspaceRoot));
  const loaded = loadedDeclarationRecord(filePath, workspaceRoot);
  const sha256 = loaded?.sha256 ?? sha256Hex(await fs.readFile(filePath, 'utf-8'));
  const rp = registryPath(workspaceRoot);

  return withFileLock(rp, async () => {
    const registry = await readRegistryFile(rp);
    const entry: RegistryEntry = {
      path: filePath,
      sha256,
      source: classify(filePath, workspaceRoot),
      trackedAt: registry.declarations[filePath]?.trackedAt ?? Date.now(),
    };
    registry.declarations[filePath] = entry;
    const tmp = `${rp}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf-8');
    await fs.rename(tmp, rp);
    return entry;
  });
}

/** Snapshot of all tracked declarations, oldest-tracked first. Empty list when none/corrupt. */
export async function getDeclarationRegistry(workspaceRoot?: string): Promise<RegistryEntry[]> {
  const rp = registryPath(workspaceRoot);
  try {
    const registry = await readRegistryFile(rp);
    return Object.values(registry.declarations).sort((a, b) => a.trackedAt - b.trackedAt);
  } catch {
    return [];
  }
}

/**
 * Re-hashes the run's pinned declaration file; on mismatch (or deletion)
 * appends a `declaration_tamper` warn trace and returns false. Runs without
 * provenance (legacy run.json) always pass — no trace, nothing to check.
 * Never throws: a trace write failure must not break the resume path.
 */
export async function verifyDeclarationIntegrity(run: HarnessRun, store: HarnessStore): Promise<boolean> {
  if (!run.declarationPath || !run.declarationSha256) return true;

  let actualSha256: string | null = null;
  let reason: 'mismatch' | 'missing';
  try {
    actualSha256 = sha256Hex(await fs.readFile(run.declarationPath, 'utf-8'));
    if (actualSha256 === run.declarationSha256) return true;
    reason = 'mismatch';
  } catch {
    reason = 'missing';
    actualSha256 = null;
  }

  await store.appendTrace({
    runId: run.runId,
    role: 'top_level',
    type: 'declaration_tamper',
    data: { path: run.declarationPath, expectedSha256: run.declarationSha256, actualSha256, reason },
  }).catch(() => {});
  return false;
}
