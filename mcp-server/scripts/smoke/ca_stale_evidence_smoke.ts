/**
 * Smoke challenge: stale retrieval evidence.
 * A sample project is indexed, one file is then edited (a function renamed) and another deleted, and retrieval is
 * asked about the OLD name. Pass = the index hit for the edited file is reported stale and the deleted one missing,
 * so neither would reach a coding prompt. Uses the real indexer and embedding model (first run downloads it) in a
 * temporary home; nothing touches ~/.free-llm-mcp.
 *
 *   npx tsx scripts/smoke/ca_stale_evidence_smoke.ts
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-stale-home-'));
const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-stale-ws-'));
process.env.FREE_LLM_MCP_HOME = home;
process.env.VECTOR_STORAGE_ROOT = path.join(home, 'vectors');
process.env.MEMORY_STORE_PATH = path.join(home, 'memory.json');

await fs.mkdir(path.join(ws, 'src'), { recursive: true });
await fs.writeFile(path.join(ws, 'src/currency.ts'), 'export function convertCurrency(amount: number, rate: number) {\n  return amount * rate;\n}\n');
await fs.writeFile(path.join(ws, 'src/legacy.ts'), 'export function legacyRoundHalfUp(n: number) {\n  return Math.round(n);\n}\n');
await fs.writeFile(path.join(ws, 'src/util.ts'), 'export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));\n');

const { WorkspaceIndexer } = await import('../../src/memory/indexer.js');
const { memoryManager } = await import('../../src/memory/index.js');
const { evidenceFromHit, keepFreshEvidence } = await import('../../src/memory/evidence.js');
const { WorkspaceScanner } = await import('../../src/cache/workspace.js');

const wsHash = await new WorkspaceScanner(ws).getWorkspaceHash(ws);
await new WorkspaceIndexer(ws).indexWorkspace(ws, true);

// the challenge: edit one file, delete another, then ask about the old names
await fs.writeFile(path.join(ws, 'src/currency.ts'), 'export function convertMoney(amount: number, fx: number) {\n  return amount * fx;\n}\n');
await fs.rm(path.join(ws, 'src/legacy.ts'));

const hits = (await memoryManager.searchWithProvenance(wsHash, 'convertCurrency legacyRoundHalfUp')) as any[];
const { kept, dropped } = await keepFreshEvidence(hits.map(h => evidenceFromHit(h)), ws);

console.log(`hits: ${hits.length}`, hits.map(h => h.path));
console.log('kept   :', kept.map(k => k.path));
console.log('dropped:', dropped.map(d => `${d.evidence.path} (${d.reason})`));

const droppedPaths = Object.fromEntries(dropped.map(d => [d.evidence.path, d.reason]));
const pass = droppedPaths['src/currency.ts'] === 'stale' && droppedPaths['src/legacy.ts'] === 'missing' && !kept.some(k => k.path === 'src/currency.ts' || k.path === 'src/legacy.ts');
console.log(pass ? 'PASS: stale and missing evidence kept out of the prompt' : 'FAIL: stale evidence would have reached the prompt');

await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.exit(pass ? 0 : 1);
