import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { detectThoughtSources, listClaudeJsonlSources, listOpencodeSessionSources, listCodexSessionSources, listAntigravitySessionSources } from '../src/harness/thought-sources.js';
import { containsWorkspacePath, isSameOrNestedWorkspacePath } from '../src/harness/workspace-path.js';
import { openOpencodeDb, readOpencodeThoughts, opencodeDbPath } from '../src/harness/opencode-reader.js';
import { readCodexThoughts } from '../src/harness/codex-reader.js';
import { listAntigravitySessions, readAntigravityThoughts } from '../src/harness/antigravity-reader.js';
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

function makeOpencodeDb(dir: string, sessionDir = 'C:\\work\\proj'): { dbPath: string; sessionId: string } {
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated TEXT)');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created TEXT, data TEXT)');
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created TEXT, data TEXT)');
  const sessionId = 'ses_test123';
  db.prepare('INSERT INTO session (id, directory, title, time_updated) VALUES (?, ?, ?, ?)')
    .run(sessionId, sessionDir, 'Fix the bug', '2026-01-01T00:00:00Z');
  const msgId = 'msg_1';
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run(msgId, sessionId, '2026-01-01T00:00:01Z', JSON.stringify({ role: 'assistant' }));
  const partId = 'prt_1';
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
    .run(partId, msgId, sessionId, '2026-01-01T00:00:02Z', JSON.stringify({ type: 'reasoning', text: 'try the cache first' }));
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
    .run('prt_2', msgId, sessionId, '2026-01-01T00:00:03Z', JSON.stringify({ type: 'text', text: 'not a reasoning part' }));
  db.close();
  return { dbPath, sessionId };
}

function guardEnv(...names: string[]): () => void {
  const saved: Array<[string, string | undefined]> = names.map(n => [n, process.env[n]]);
  for (const n of names) delete process.env[n];
  return () => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  };
}

function makeCodexSession(home: string, ws: string, sessionId: string): string {
  const dateDir = path.join(home, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dateDir, { recursive: true });
  const meta = {
    type: 'session_meta',
    payload: { id: sessionId, session_id: sessionId, cwd: ws, padding: 'x'.repeat(20000) },
  };
  const lines = [
    JSON.stringify(meta),
    JSON.stringify({ type: 'response_item', payload: { id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'codex thought one' }], timestamp: '2026-01-01T00:00:01Z' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'fallback message', timestamp: '2026-01-01T00:00:02Z' } }),
  ];
  const rolloutPath = path.join(dateDir, `rollout-2026-01-01-${sessionId}.jsonl`);
  fs.writeFileSync(rolloutPath, lines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    path.join(home, '.codex', 'session_index.jsonl'),
    JSON.stringify({ id: sessionId, thread_name: 'codex session title', updated_at: '2026-01-01T00:00:00Z' }) + '\n',
    'utf8',
  );
  return rolloutPath;
}

function makeAntigravitySession(home: string, ws: string, id: string): string {
  const logsDir = path.join(home, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'GENERIC', content: `workspace context ${ws} ${'z'.repeat(20000)}`, created_at: '2026-01-01T00:00:00Z', step_index: 0 }),
    JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>Fix the widget crash</USER_REQUEST>', created_at: '2026-01-01T00:00:01Z', step_index: 1 }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'the crash is in widget.ts line 12', created_at: '2026-01-01T00:00:02Z', step_index: 3 }),
  ];
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');
  return transcriptPath;
}

describe('listClaudeJsonlSources', () => {
  it('finds jsonl files under matching slug dirs sorted by mtime', () => {
    const home = mktemp('ts-home-');
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const slug = ws.replace(/[:\\/]/g, '-').toLowerCase();
    const projectsDir = path.join(home, '.claude', 'projects');
    const dir = path.join(projectsDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'b.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n', 'utf8');
    fs.mkdirSync(path.join(projectsDir, 'other-workspace-slug'), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, 'other-workspace-slug', 'c.jsonl'), '{}\n', 'utf8');
    fs.utimesSync(path.join(dir, 'a.jsonl'), new Date(2000), new Date(2000));

    const files = listClaudeJsonlSources(home, ws);
    expect(files).toHaveLength(2);
    expect(files[0].endsWith('b.jsonl')).toBe(true);
    expect(files[1].endsWith('a.jsonl')).toBe(true);
  });

  it('returns empty when projects dir missing', () => {
    expect(listClaudeJsonlSources(mktemp('ts-home2-'), 'C:\\nowhere')).toEqual([]);
  });
});

describe('opencode reader', () => {
  it('opencodeDbPath honors OPENCODE_DATA_DIR and default .local/share', () => {
    const saved = process.env.OPENCODE_DATA_DIR;
    process.env.OPENCODE_DATA_DIR = 'C:\\custom\\db.sqlite';
    expect(opencodeDbPath('C:\\Users\\x')).toBe('C:\\custom\\db.sqlite');
    delete process.env.OPENCODE_DATA_DIR;
    expect(opencodeDbPath('C:\\Users\\x')).toBe('C:\\Users\\x\\.local\\share\\opencode\\opencode.db');
    if (saved !== undefined) process.env.OPENCODE_DATA_DIR = saved;
  });

  it('reads reasoning parts only, most recent last', () => {
    const dir = mktemp('ts-oc-');
    const { dbPath, sessionId } = makeOpencodeDb(dir);
    const db = openOpencodeDb(dbPath);
    expect(db).not.toBeNull();
    const thoughts = readOpencodeThoughts(db!, sessionId, 20);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe('try the cache first');
    expect(thoughts[0].messageId).toBe('msg_1');
  });

  it('openOpencodeDb returns null for missing file', () => {
    expect(openOpencodeDb(path.join(mktemp('ts-oc2-'), 'nope.db'))).toBeNull();
  });
});

describe('listOpencodeSessionSources', () => {
  it('filters sessions by workspace directory', () => {
    const dir = mktemp('ts-ocss-');
    const { dbPath } = makeOpencodeDb(dir);
    const saved = process.env.OPENCODE_DATA_DIR;
    process.env.OPENCODE_DATA_DIR = dbPath;
    try {
      const sources = listOpencodeSessionSources('C:\\fakehome', 'c:\\work\\proj');
      expect(sources).toHaveLength(1);
      expect(sources[0].kind).toBe('opencode');
      expect(sources[0].label).toBe('opencode:ses_test123');
      expect(sources[0].title).toBe('Fix the bug');
      expect(sources[0].opencodeDb).toBe(dbPath);
      const none = listOpencodeSessionSources('C:\\fakehome', 'C:\\different');
      expect(none).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.OPENCODE_DATA_DIR = saved;
      else delete process.env.OPENCODE_DATA_DIR;
    }
  });
});

describe('listCodexSessionSources', () => {
  it('filters sessions by workspace cwd and merges title index', () => {
    const home = mktemp('ts-codex-');
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const restore = guardEnv('CODEX_HOME', 'OPENCODE_DATA_DIR', 'ANTIGRAVITY_DATA_DIR');
    try {
      const sessionId = '0f1e2d3c-4b5a-6789-abcd-ef0123456789';
      const rolloutPath = makeCodexSession(home, ws, sessionId);
      const firstLine = fs.readFileSync(rolloutPath, 'utf8').split('\n')[0];
      expect(firstLine.length).toBeGreaterThan(16 * 1024);
      const otherDir = path.join(home, '.codex', 'sessions', '2026', '01', '02');
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(
        path.join(otherDir, 'rollout-other.jsonl'),
        JSON.stringify({ type: 'session_meta', payload: { id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111', cwd: 'C:\\elsewhere' } }) + '\n',
        'utf8',
      );
      const sources = listCodexSessionSources(home, ws);
      expect(sources).toHaveLength(1);
      expect(sources[0].kind).toBe('codex');
      expect(sources[0].label).toBe(`codex:${sessionId.slice(0, 12)}`);
      expect(sources[0].codexRollout).toBe(rolloutPath);
      expect(sources[0].title).toBe('codex session title');
    } finally {
      restore();
    }
  });
});

describe('codex reader', () => {
  it('readCodexThoughts parses primary output_text thoughts', async () => {
    const home = mktemp('ts-codex2-');
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const sessionId = '0f1e2d3c-4b5a-6789-abcd-ef0123456789';
    const rolloutPath = makeCodexSession(home, ws, sessionId);
    const thoughts = await readCodexThoughts(rolloutPath, sessionId);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].sessionId).toBe(sessionId);
    expect(thoughts[0].messageId).toBe('msg_1');
    expect(thoughts[0].timeCreated).toBe('2026-01-01T00:00:01Z');
    expect(thoughts[0].text).toBe('codex thought one');
  });
});

describe('antigravity sessions', () => {
  it('listAntigravitySessions finds transcript by uuid id, filtered by workspace mention', () => {
    const home = mktemp('ts-ant-');
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const restore = guardEnv('ANTIGRAVITY_DATA_DIR', 'OPENCODE_DATA_DIR', 'CODEX_HOME');
    const id = '11112222-3333-4444-5555-666677778888';
    try {
      const transcriptPath = makeAntigravitySession(home, ws, id);
      const sessions = listAntigravitySessions(home, ws);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(id);
      expect(sessions[0].transcriptPath).toBe(transcriptPath);
      expect(sessions[0].title).toBe('Fix the widget crash');
      const other = listAntigravitySessions(home, 'C:\\unrelated\\ws');
      expect(other).toEqual([]);
    } finally {
      restore();
    }
  });

  it('readAntigravityThoughts returns PLANNER_RESPONSE thoughts', () => {
    const home = mktemp('ts-ant2-');
    const ws = path.join(home, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const id = '11112222-3333-4444-5555-666677778888';
    const transcriptPath = makeAntigravitySession(home, ws, id);
    const thoughts = readAntigravityThoughts(transcriptPath, id);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].sessionId).toBe(id);
    expect(thoughts[0].messageId).toBe('pr-3');
    expect(thoughts[0].timeCreated).toBe('2026-01-01T00:00:02Z');
    expect(thoughts[0].text).toBe('the crash is in widget.ts line 12');
  });
});

describe('detectThoughtSources', () => {
  it('combines claude jsonl and opencode sessions', () => {
    const home = mktemp('ts-detect-');
    const ws = path.join(home, 'proj');
    fs.mkdirSync(ws, { recursive: true });
    const slug = ws.replace(/[:\\/]/g, '-').toLowerCase();
    const dir = path.join(home, '.claude', 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc-session.jsonl'), '{}\n', 'utf8');
    const { dbPath } = makeOpencodeDb(mktemp('ts-detect-oc-'), ws);
    const saved = process.env.OPENCODE_DATA_DIR;
    process.env.OPENCODE_DATA_DIR = dbPath;
    try {
      const sources = detectThoughtSources({ workspaceRoot: ws, homeDir: home });
      expect(sources.some(s => s.kind === 'claude' && s.label === 'claude:abc-session')).toBe(true);
      expect(sources.some(s => s.kind === 'opencode' && s.label === 'opencode:ses_test123')).toBe(true);
    } finally {
      if (saved !== undefined) process.env.OPENCODE_DATA_DIR = saved;
      else delete process.env.OPENCODE_DATA_DIR;
    }
  });

  it('config override replaces auto-detection', () => {
    const sources = detectThoughtSources({
      workspaceRoot: 'C:\\proj',
      config: { claude: ['C:\\a.jsonl'], opencode: ['ses_zz'] },
      homeDir: mktemp('ts-detect2-'),
    });
    expect(sources.map(s => s.label)).toEqual(['claude:a', 'opencode:ses_zz']);
    expect(sources[0].claudeJsonl).toBe('C:\\a.jsonl');
  });
});

describe('workspace-path boundaries', () => {
  it('containsWorkspacePath avoids false positive substrings when prefix characters match', () => {
    expect(containsWorkspacePath('/prefix/otherapp/file.ts', '/app')).toBe(false);
    expect(containsWorkspacePath('navigate to /app/file.ts now', '/app')).toBe(true);
    expect(containsWorkspacePath('in "/app" dir', '/app')).toBe(true);
    expect(containsWorkspacePath('C:\\work\\otherproj\\file.ts', 'C:\\proj')).toBe(false);
    expect(containsWorkspacePath('C:\\proj\\src\\index.ts', 'C:\\proj')).toBe(true);
  });

  it('isSameOrNestedWorkspacePath handles root and nested paths securely', () => {
    expect(isSameOrNestedWorkspacePath('/app', '/app')).toBe(true);
    expect(isSameOrNestedWorkspacePath('/app/sub/dir', '/app')).toBe(true);
    expect(isSameOrNestedWorkspacePath('/app2', '/app')).toBe(false);
    expect(isSameOrNestedWorkspacePath('', '/app')).toBe(false);
  });
});
