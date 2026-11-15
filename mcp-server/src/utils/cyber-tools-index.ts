import fs from 'node:fs/promises';
import path from 'node:path';

export interface ToolIndexEntry {
  name: string;
  description?: string;
  module?: string;
  method?: string;
  url?: string;
}

let indexCache: Map<string, ToolIndexEntry> | null = null;
let descriptionsCache: Record<string, string> | null = null;

function candidatePaths(repoPath?: string): string[] {
  const roots = repoPath ? [repoPath] : [
    path.resolve(process.cwd(), 'external/cyber-tools-index'),
    path.resolve(process.cwd(), 'tests/context/cybersec-toolkit'),
    path.resolve(process.cwd(), 'scratch/cybersec-toolkit'),
  ];
  return roots.map(r => path.join(r, 'tools_config.json'));
}

async function readToolsConfig(repoPath?: string): Promise<unknown | null> {
  for (const p of candidatePaths(repoPath)) {
    try {
      await fs.access(p);
      return JSON.parse(await fs.readFile(p, 'utf-8'));
    } catch {
      continue;
    }
  }
  return null;
}

function toEntry(raw: Record<string, unknown>): ToolIndexEntry | null {
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!name) return null;
  const entry: ToolIndexEntry = { name };
  if (typeof raw.description === 'string') entry.description = raw.description;
  if (typeof raw.module === 'string') entry.module = raw.module;
  if (typeof raw.method === 'string') entry.method = raw.method;
  if (typeof raw.url === 'string') entry.url = raw.url;
  return entry;
}

export async function loadToolIndex(repoPath?: string): Promise<Map<string, ToolIndexEntry>> {
  if (!repoPath && indexCache) return indexCache;
  const raw = await readToolsConfig(repoPath);
  const map = new Map<string, ToolIndexEntry>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const e = toEntry(item as Record<string, unknown>);
      if (e) map.set(e.name.toLowerCase(), e);
    }
  }
  if (!repoPath) indexCache = map;
  return map;
}

export async function loadToolDescriptions(repoPath?: string): Promise<Record<string, string>> {
  if (!repoPath && descriptionsCache) return descriptionsCache;
  const index = await loadToolIndex(repoPath);
  const out: Record<string, string> = {};
  for (const [key, e] of index) {
    if (e.description) out[key] = e.description;
  }
  if (!repoPath) descriptionsCache = out;
  return out;
}

export async function enrichToolsWithDescriptions(
  tools: Record<string, unknown>,
  repoPath?: string,
): Promise<Record<string, unknown>> {
  const descriptions = await loadToolDescriptions(repoPath);
  if (!Object.keys(descriptions).length) return tools;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(tools)) {
    const d = descriptions[name.toLowerCase()];
    if (d && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out[name] = { ...(entry as Record<string, unknown>), description: d };
    } else {
      out[name] = entry;
    }
  }
  return out;
}

export function resetToolIndexCache(): void {
  indexCache = null;
  descriptionsCache = null;
}
