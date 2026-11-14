import fs from 'node:fs';
import path from 'node:path';
import { LAYA_MODEL } from './laya-bridge.js';

export const ASSUMPTIONS_HEADING = "## Agent's assumptions";
export const QUESTIONS_HEADING = "## Agent's questions";
export const LAYA_MESSAGES_FILE = '.free-llm-mcp/laya-messages.json';

export interface InjectionDecision {
  decision: 'forward' | 'hold' | 'keyword_only' | 'blocked';
  keywordsPassed: boolean;
  matchedKeywords: string[];
  layaChoice?: string;
  reason: string;
}

export interface LayaForwardDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_KEYWORDS = [
  'error', 'fail', 'failing', 'blocked', 'stuck', 'wrong', 'breaks', 'regression',
  'refuted', 'assumption', 'deviation', 'diverge', 'conflict', 'contradict',
  'risk', 'unsafe', 'dangerous', 'destructive', 'verify', 'confirm', 'question',
];

export function classifyKeywords(text: string, patterns: string[] = DEFAULT_KEYWORDS): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const p of patterns) {
    const re = p.match(/^\/(.+)\/([a-z]*)$/);
    if (re) {
      try {
        if (new RegExp(re[1], re[2]).test(text)) matched.push(p);
      } catch { }
      continue;
    }
    if (lower.includes(p.toLowerCase())) matched.push(p);
  }
  return matched;
}

async function askLayaForward(
  text: string,
  deps?: LayaForwardDeps,
): Promise<{ choice: string; available: boolean }> {
  const baseUrl = (deps?.baseUrl ?? process.env.OLLAMA_LOCAL_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  const body = {
    model: deps?.model ?? LAYA_MODEL,
    state: JSON.stringify({ kind: 'inject_candidate', excerpt: text.slice(0, 900) }),
    questions: {
      forward: {
        type: 'choice',
        instructions: 'Should this observation be injected into an active coding agent task?',
        criteria: {
          forward: 'useful signal that changes or confirms what the agent is doing',
          hold: 'noise, redundant, or already known to the agent',
        },
      },
    },
  };
  try {
    const doFetch = deps?.fetchImpl ?? fetch;
    const res = await doFetch(`${baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps?.timeoutMs ?? 5000),
    });
    if (!res.ok) return { choice: 'hold', available: false };
    const json: any = await res.json();
    const choice = json?.answers?.forward?.choice;
    if (typeof choice !== 'string') return { choice: 'hold', available: false };
    return { choice, available: true };
  } catch {
    return { choice: 'hold', available: false };
  }
}

export async function decideForward(
  text: string,
  opts: { keywords?: string[] } & LayaForwardDeps,
): Promise<InjectionDecision> {
  const matchedKeywords = classifyKeywords(text, opts.keywords);
  const keywordsPassed = matchedKeywords.length > 0;
  if (!keywordsPassed) {
    return { decision: 'blocked', keywordsPassed: false, matchedKeywords: [], reason: 'no keyword hit' };
  }
  const { choice, available } = await askLayaForward(text, opts);
  if (!available) {
    return {
      decision: 'keyword_only',
      keywordsPassed: true,
      matchedKeywords,
      reason: 'laya unavailable; keyword gate passed',
    };
  }
  if (choice === 'forward') {
    return { decision: 'forward', keywordsPassed: true, matchedKeywords, layaChoice: choice, reason: 'keyword gate AND laya forward' };
  }
  return { decision: 'hold', keywordsPassed: true, matchedKeywords, layaChoice: choice, reason: 'laya held the injection' };
}

export interface QueuedInjection {
  sessionId: string;
  source: string;
  text: string;
  decision: InjectionDecision['decision'];
  keywords: string[];
  queuedAt: string;
}

function queuePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, LAYA_MESSAGES_FILE);
}

export function queueMessage(workspaceRoot: string, entry: QueuedInjection): void {
  const file = queuePath(workspaceRoot);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let entries: QueuedInjection[] = [];
  if (fs.existsSync(file)) {
    try {
      entries = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(entries)) entries = [];
    } catch (err) {
      console.warn(`[laya-injector] queueMessage failed to parse ${file}:`, (err as Error)?.message ?? err);
      entries = [];
    }
  }
  entries.push(entry);
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf8');
}

export function peekMessages(workspaceRoot: string): QueuedInjection[] {
  const file = queuePath(workspaceRoot);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`[laya-injector] peekMessages failed to read ${file}:`, (err as Error)?.message ?? err);
    return [];
  }
}

export function drainMessages(workspaceRoot: string): QueuedInjection[] {
  const file = queuePath(workspaceRoot);
  const entries = peekMessages(workspaceRoot);
  if (entries.length) {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.warn(`[laya-injector] drainMessages failed to delete ${file}:`, (err as Error)?.message ?? err);
    }
  }
  return entries;
}

function extractSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const startIdx = lines.findIndex(l => l.trim() === heading);
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##?\s+/.test(lines[i])) { endIdx = i; break; }
  }
  return lines.slice(startIdx + 1, endIdx).join('\n');
}

export function appendAgentAssumptions(tasksPath: string, items: string[]): void {
  if (!items.length) return;
  const existing = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const headingIdx = lines.findIndex(l => l.trim() === ASSUMPTIONS_HEADING);
  if (headingIdx === -1) {
    if (existing && !existing.endsWith('\n')) lines.push('');
    lines.push(ASSUMPTIONS_HEADING);
    for (const item of items) lines.push(`- ${item}`);
  } else {
    let endIdx = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##?\s+/.test(lines[i])) { endIdx = i; break; }
    }
    const bullets = items.map(item => `- ${item}`);
    lines.splice(endIdx, 0, ...bullets);
  }
  fs.writeFileSync(tasksPath, lines.join('\n') + '\n', 'utf8');
}

export interface AgentQuestions {
  answered: Array<{ question: string; answer: string }>;
  pending: string[];
}

export function readAgentQuestions(content: string): AgentQuestions {
  const body = extractSection(content, QUESTIONS_HEADING);
  if (body === null) return { answered: [], pending: [] };
  const answered: Array<{ question: string; answer: string }> = [];
  const pending: string[] = [];
  let current: { question: string; answer?: string } | null = null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const qMatch = line.match(/^(?:Q\d+|question)\s*:\s*(.+)$/i);
    if (qMatch) {
      if (current && current.answer) answered.push({ question: current.question, answer: current.answer });
      else if (current) pending.push(current.question);
      current = { question: qMatch[1].trim() };
      continue;
    }
    if (!current) continue;
    const aMatch = line.match(/^(?:A\d+|answer)\s*:\s*(.+)$/i);
    if (aMatch) current.answer = aMatch[1].trim();
  }
  if (current) {
    if (current.answer) answered.push({ question: current.question, answer: current.answer });
    else pending.push(current.question);
  }
  return { answered, pending };
}

export function removeConsumedQuestions(tasksPath: string): void {
  if (!fs.existsSync(tasksPath)) return;
  const content = fs.readFileSync(tasksPath, 'utf8');
  const { answered, pending } = readAgentQuestions(content);
  if (!answered.length) return;
  const lines = content.split(/\r?\n/);
  const headingIdx = lines.findIndex(l => l.trim() === QUESTIONS_HEADING);
  if (headingIdx === -1) return;
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##?\s+/.test(lines[i])) { endIdx = i; break; }
  }

  if (pending.length === 0) {
    fs.writeFileSync(tasksPath, [...lines.slice(0, headingIdx), ...lines.slice(endIdx)].join('\n'), 'utf8');
  } else {
    const newSection = [
      lines[headingIdx],
      '',
      ...pending.map((q, idx) => `Q${idx + 1}: ${q}`),
      ''
    ];
    fs.writeFileSync(tasksPath, [...lines.slice(0, headingIdx), ...newSection, ...lines.slice(endIdx)].join('\n'), 'utf8');
  }
}

export function recordAgentQuestions(tasksPath: string, questions: string[]): void {
  if (!questions.length) return;
  const existing = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const headingIdx = lines.findIndex(l => l.trim() === QUESTIONS_HEADING);
  if (headingIdx === -1) {
    if (existing && !existing.endsWith('\n')) lines.push('');
    lines.push(QUESTIONS_HEADING);
    questions.forEach((q, i) => lines.push(`Q${i + 1}: ${q}`));
  } else {
    let endIdx = lines.length;
    let maxQNum = 0;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##?\s+/.test(lines[i])) { endIdx = i; break; }
      const m = lines[i].trim().match(/^Q(\d+)\s*:/i);
      if (m) {
        const num = parseInt(m[1], 10);
        if (num > maxQNum) maxQNum = num;
      }
    }
    const newLines = questions.map((q, i) => `Q${maxQNum + i + 1}: ${q}`);
    lines.splice(endIdx, 0, ...newLines);
  }
  fs.writeFileSync(tasksPath, lines.join('\n') + '\n', 'utf8');
}

export function buildResumeFeedback(workspaceRoot: string, drained: QueuedInjection[]): string {
  if (!drained.length) return '';
  return drained
    .map(e => `[${e.decision}] (${e.source}) ${e.text}`)
    .join('\n');
}
