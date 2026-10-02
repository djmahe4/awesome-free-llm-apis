import { promises as fs } from 'fs';
import path from 'path';
import type { ShortTermMemory } from '../memory/short-term.js';

export interface ScopeClaim {
  runId: string;
  agentId: string;
  files: string[];
  claimedAt: number;
}

export interface ScopeResult {
  acquired: boolean;
  conflicts?: string[];
  claim?: ScopeClaim;
}

export interface ReasoningScopeEntry {
  runId: string;
  agentId: string;
  role: string;
  keywords: string[];
  findingsText: string;
  timestamp: number;
}

export interface ReasoningCollisionResult {
  hasOverlap: boolean;
  overlappingKeywords: string[];
  relayedContext: string;
  sourceAgents: string[];
}

export function extractWeightedKeywordLines(text: string, keywords: string[], maxTokens = 500): string {
  if (!text || keywords.length === 0) return '';
  const kwSet = new Set(keywords.map(k => k.toLowerCase()));
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const scoredLines = lines.map(line => {
    const tokens = line.toLowerCase().split(/[^a-z0-9_-]+/);
    let matchCount = 0;
    for (const t of tokens) {
      if (kwSet.has(t)) matchCount++;
    }
    return { line, score: matchCount };
  }).filter(item => item.score > 0);

  scoredLines.sort((a, b) => b.score - a.score);

  const maxChars = maxTokens * 4;
  let currentChars = 0;
  const selected: string[] = [];

  for (const item of scoredLines) {
    if (currentChars + item.line.length > maxChars) break;
    selected.push(item.line);
    currentChars += item.line.length + 1;
  }

  return selected.join('\n');
}

export class FileScopeRegistry {
  private scopePath: string;

  constructor(private workspaceRoot: string) {
    this.scopePath = path.join(workspaceRoot, '.free-llm-mcp', 'harness', 'scopes.json');
  }

  private async loadClaims(): Promise<ScopeClaim[]> {
    try {
      const data = await fs.readFile(this.scopePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private async saveClaims(claims: ScopeClaim[]): Promise<void> {
    await fs.mkdir(path.dirname(this.scopePath), { recursive: true });
    await fs.writeFile(this.scopePath, JSON.stringify(claims, null, 2), 'utf-8');
  }

  async acquireScope(input: { runId: string; agentId: string; files: string[] }): Promise<ScopeResult> {
    const claims = await this.loadClaims();
    const normalizedFiles = input.files.map(f => path.normalize(f).toLowerCase());
    const conflicts: string[] = [];

    for (const existing of claims) {
      if (existing.runId === input.runId && existing.agentId === input.agentId) continue;
      for (const ef of existing.files) {
        if (normalizedFiles.includes(path.normalize(ef).toLowerCase())) {
          conflicts.push(ef);
        }
      }
    }

    if (conflicts.length > 0) {
      return { acquired: false, conflicts };
    }

    const newClaim: ScopeClaim = {
      runId: input.runId,
      agentId: input.agentId,
      files: input.files,
      claimedAt: Date.now()
    };
    claims.push(newClaim);
    await this.saveClaims(claims);
    return { acquired: true, claim: newClaim };
  }

  async releaseScope(runId: string, agentId?: string): Promise<void> {
    let claims = await this.loadClaims();
    claims = claims.filter(c => !(c.runId === runId && (!agentId || c.agentId === agentId)));
    await this.saveClaims(claims);
  }
}

export class ReasoningScopeRegistry {
  private reasoningPath: string;

  private memory?: ShortTermMemory;

  constructor(private workspaceRoot: string, memory?: ShortTermMemory) {
    this.reasoningPath = path.join(workspaceRoot, '.free-llm-mcp', 'harness', 'reasoning_scopes.json');
    this.memory = memory;
  }

  private async loadEntries(): Promise<ReasoningScopeEntry[]> {
    try {
      const data = await fs.readFile(this.reasoningPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private async saveEntries(entries: ReasoningScopeEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.reasoningPath), { recursive: true });
    await fs.writeFile(this.reasoningPath, JSON.stringify(entries, null, 2), 'utf-8');
  }

  async registerReasoningScope(entry: Omit<ReasoningScopeEntry, 'timestamp'>): Promise<void> {
    const entries = await this.loadEntries();
    const fullEntry: ReasoningScopeEntry = { ...entry, timestamp: Date.now() };
    entries.push(fullEntry);
    await this.saveEntries(entries);

    if (this.memory) {
      const memKey = `reasoning:${entry.runId}:${entry.agentId}:${entry.role}`;
      this.memory.set(memKey, {
        keywords: entry.keywords,
        findings: entry.findingsText,
        role: entry.role,
        agentId: entry.agentId,
      });
    }
  }

  async checkAndRelayReasoningContext(query: {
    runId: string;
    agentId: string;
    role: string;
    keywords: string[];
    maxTokens?: number;
  }): Promise<ReasoningCollisionResult> {
    const entries = await this.loadEntries();
    const queryKws = new Set(query.keywords.map(k => k.toLowerCase()));
    const overlappingKws = new Set<string>();
    const sourceAgents = new Set<string>();
    const findingsChunks: string[] = [];

    // Pull from shortTerm memory if available
    if (this.memory) {
      const prefix = `reasoning:${query.runId}:`;
      const memEntries = this.memory.getByPrefix(prefix);
      for (const item of memEntries) {
        const val = item.value as { keywords?: string[]; findings?: string; role?: string; agentId?: string };
        if (!val || !val.keywords || val.agentId === query.agentId) continue;
        const matched = val.keywords.filter(k => queryKws.has(k.toLowerCase()));
        if (matched.length > 0) {
          matched.forEach(m => overlappingKws.add(m));
          sourceAgents.add(`${val.role}:${val.agentId}`);
          if (val.findings) findingsChunks.push(val.findings);
        }
      }
    }

    for (const e of entries) {
      if (e.runId === query.runId && e.agentId === query.agentId) continue;
      const matched = e.keywords.filter(k => queryKws.has(k.toLowerCase()));
      if (matched.length > 0) {
        matched.forEach(m => overlappingKws.add(m));
        sourceAgents.add(`${e.role}:${e.agentId}`);
        findingsChunks.push(e.findingsText);
      }
    }

    if (overlappingKws.size === 0) {
      return { hasOverlap: false, overlappingKeywords: [], relayedContext: '', sourceAgents: [] };
    }

    // Deduplicate findings chunks
    const uniqueChunks = Array.from(new Set(findingsChunks));
    const aggregatedFindings = uniqueChunks.join('\n');
    const relayed = extractWeightedKeywordLines(aggregatedFindings, Array.from(overlappingKws), query.maxTokens ?? 500);

    return {
      hasOverlap: true,
      overlappingKeywords: Array.from(overlappingKws),
      relayedContext: relayed,
      sourceAgents: Array.from(sourceAgents),
    };
  }
}
