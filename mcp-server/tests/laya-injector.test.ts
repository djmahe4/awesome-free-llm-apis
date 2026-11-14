import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASSUMPTIONS_HEADING,
  QUESTIONS_HEADING,
  classifyKeywords,
  decideForward,
  queueMessage,
  peekMessages,
  drainMessages,
  appendAgentAssumptions,
  recordAgentQuestions,
  readAgentQuestions,
  removeConsumedQuestions,
  buildResumeFeedback,
  type QueuedInjection,
} from '../src/harness/laya-injector.js';
import { removeDir } from './helpers/temp-dir.js';

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) await removeDir(dir);
});

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function layaFetch(choice: string, opts?: { ok?: boolean; fail?: boolean }): typeof fetch {
  return (async () => {
    if (opts?.fail) throw new Error('laya down');
    return {
      ok: opts?.ok ?? true,
      json: async () => ({ answers: { forward: { choice } } }),
    } as any;
  }) as unknown as typeof fetch;
}

function entry(overrides: Partial<QueuedInjection> = {}): QueuedInjection {
  return {
    sessionId: 'ses_x',
    source: 'claude:abc',
    text: 'cache assumption was wrong',
    decision: 'forward',
    keywords: ['wrong'],
    queuedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('classifyKeywords', () => {
  it('matches literals case-insensitively', () => {
    expect(classifyKeywords('This FAILS badly', ['fail'])).toEqual(['fail']);
    expect(classifyKeywords('all good', ['fail', 'error'])).toEqual([]);
  });

  it('supports /regex/flags patterns and ignores invalid regexes', () => {
    expect(classifyKeywords('exit code 42', ['/^exit/i'])).toEqual(['/^exit/i']);
    expect(classifyKeywords('exit code 42', ['/^Exit/'])).toEqual([]);
    expect(classifyKeywords('anything', ['/['])).toEqual([]);
  });

  it('uses default keyword list when patterns omitted', () => {
    const matched = classifyKeywords('blocked on the cache question');
    expect(matched).toContain('blocked');
    expect(matched).toContain('question');
  });
});

describe('decideForward', () => {
  it('blocks without a keyword hit and never calls laya', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return {} as any; }) as unknown as typeof fetch;
    const decision = await decideForward('perfectly fine progress', { fetchImpl });
    expect(decision.decision).toBe('blocked');
    expect(decision.keywordsPassed).toBe(false);
    expect(decision.matchedKeywords).toEqual([]);
    expect(calls).toBe(0);
  });

  it('forwards when keyword gate passes and laya says forward', async () => {
    const decision = await decideForward('the cache assumption is wrong', {
      fetchImpl: layaFetch('forward'),
    });
    expect(decision.decision).toBe('forward');
    expect(decision.keywordsPassed).toBe(true);
    expect(decision.matchedKeywords).toContain('wrong');
    expect(decision.layaChoice).toBe('forward');
  });

  it('holds when laya is available but chooses hold', async () => {
    const decision = await decideForward('the cache assumption is wrong', {
      fetchImpl: layaFetch('hold'),
    });
    expect(decision.decision).toBe('hold');
    expect(decision.layaChoice).toBe('hold');
  });

  it('degrades to keyword_only when laya is unreachable', async () => {
    const decision = await decideForward('the cache assumption is wrong', {
      fetchImpl: layaFetch('forward', { fail: true }),
    });
    expect(decision.decision).toBe('keyword_only');
    expect(decision.reason).toContain('keyword gate passed');
  });

  it('degrades to keyword_only on non-ok laya responses', async () => {
    const decision = await decideForward('the cache assumption is wrong', {
      fetchImpl: layaFetch('forward', { ok: false }),
    });
    expect(decision.decision).toBe('keyword_only');
  });
});

describe('message queue', () => {
  it('queues, peeks, drains, and tolerates a missing file', () => {
    const ws = mktemp('laya-queue-');
    expect(peekMessages(ws)).toEqual([]);
    queueMessage(ws, entry());
    queueMessage(ws, entry({ text: 'second', decision: 'keyword_only' }));
    const peeked = peekMessages(ws);
    expect(peeked).toHaveLength(2);
    expect(peeked[0].text).toBe('cache assumption was wrong');
    const drained = drainMessages(ws);
    expect(drained).toHaveLength(2);
    expect(peekMessages(ws)).toEqual([]);
    expect(drainMessages(ws)).toEqual([]);
  });
});

describe('tasks.md ledger', () => {
  it('appendAgentAssumptions creates the heading and appends bullets idempotently', () => {
    const tasksPath = path.join(mktemp('laya-tasks-'), 'tasks.md');
    appendAgentAssumptions(tasksPath, ['cache is stale']);
    appendAgentAssumptions(tasksPath, ['env is pinned']);
    const content = fs.readFileSync(tasksPath, 'utf8');
    expect(content.split(ASSUMPTIONS_HEADING).length - 1).toBe(1);
    expect(content).toContain('- cache is stale');
    expect(content).toContain('- env is pinned');
  });

  it('recordAgentQuestions + readAgentQuestions classify answered vs pending', () => {
    const tasksPath = path.join(mktemp('laya-tasks2-'), 'tasks.md');
    fs.writeFileSync(tasksPath, '## Task\n\ndo the thing\n', 'utf8');
    recordAgentQuestions(tasksPath, ['which cache?', 'which env?']);
    const content = fs.readFileSync(tasksPath, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    fs.appendFileSync(tasksPath, 'A1: the redis cache\n', 'utf8');
    const { answered, pending } = readAgentQuestions(fs.readFileSync(tasksPath, 'utf8'));
    expect(answered).toEqual([{ question: 'which env?', answer: 'the redis cache' }]);
    expect(pending).toEqual(['which cache?']);
    const interleaved = `${QUESTIONS_HEADING}\nQ1: a?\nA1: b\nQ2: c?\n`;
    expect(readAgentQuestions(interleaved)).toEqual({
      answered: [{ question: 'a?', answer: 'b' }],
      pending: ['c?'],
    });
    expect(readAgentQuestions('no questions section here')).toEqual({ answered: [], pending: [] });
  });

  it('removeConsumedQuestions strips the questions section', () => {
    const tasksPath = path.join(mktemp('laya-tasks3-'), 'tasks.md');
    fs.writeFileSync(tasksPath, `## Task\n\nwork\n\n${QUESTIONS_HEADING}\n\nQ1: which?\nA1: that one\n`, 'utf8');
    removeConsumedQuestions(tasksPath);
    const content = fs.readFileSync(tasksPath, 'utf8');
    expect(content).not.toContain(QUESTIONS_HEADING);
    expect(content).not.toContain('Q1:');
    expect(content).toContain('## Task');
    expect(readAgentQuestions(content)).toEqual({ answered: [], pending: [] });
  });
});

describe('buildResumeFeedback', () => {
  it('formats drained entries and returns empty for none', () => {
    expect(buildResumeFeedback('/ws', [])).toBe('');
    const feedback = buildResumeFeedback('/ws', [
      entry(),
      entry({ decision: 'keyword_only', source: 'codex:0f1e2d3c4b5a', text: 'second line' }),
    ]);
    expect(feedback.split('\n')).toEqual([
      '[forward] (claude:abc) cache assumption was wrong',
      '[keyword_only] (codex:0f1e2d3c4b5a) second line',
    ]);
  });
});
