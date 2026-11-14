import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { antigravityBrainRoot, listAntigravitySessions } from './antigravity-reader.js';
import { codexSessionsRoot, listCodexSessions } from './codex-reader.js';
import { listOpencodeSessions, opencodeDbPath, openOpencodeDb } from './opencode-reader.js';
import { listZedSessions, openZedDb, scanZedThreadSchema, zedThreadsDbPath } from './zed-reader.js';

export type ThoughtSourceKind = 'claude' | 'opencode' | 'codex' | 'antigravity' | 'zed';

export interface ThoughtSource {
  kind: ThoughtSourceKind;
  label: string;
  claudeJsonl?: string;
  opencodeSessionId?: string;
  opencodeDb?: string;
  codexRollout?: string;
  antigravityTranscript?: string;
  zedDb?: string;
  zedSessionId?: string;
  title?: string;
  timeUpdated?: string;
}

export interface ThoughtSourcesConfig {
  claude?: string[];
  opencode?: string[];
  codex?: string[];
  antigravity?: string[];
  zed?: string[];
}

export interface DetectThoughtSourcesOpts {
  workspaceRoot: string;
  config?: ThoughtSourcesConfig;
  homeDir?: string;
}

function claudeProjectsDir(homeDir: string): string {
  return path.join(homeDir, '.claude', 'projects');
}

export function listClaudeJsonlSources(homeDir: string, workspaceRoot: string): string[] {
  const projectsDir = claudeProjectsDir(homeDir);
  const slug = workspaceRoot.replace(/[:\\/]/g, '-').toLowerCase();
  let out: Array<{ p: string; mtime: number }> = [];
  try {
    if (!fs.existsSync(projectsDir)) return [];
    for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirLower = dir.name.toLowerCase();
      if (!dirLower.includes(slug)) continue;
      const dirPath = path.join(projectsDir, dir.name);
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dirPath, f);
        try {
          out.push({ p: full, mtime: fs.statSync(full).mtimeMs });
        } catch { }
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(e => e.p);
}

export function listOpencodeSessionSources(homeDir: string, workspaceRoot: string): ThoughtSource[] {
  const dbPath = opencodeDbPath(homeDir);
  if (!fs.existsSync(dbPath)) return [];
  const db = openOpencodeDb(dbPath);
  if (!db) return [];
  try {
    return listOpencodeSessions(db, workspaceRoot).map(s => ({
      kind: 'opencode' as const,
      label: `opencode:${s.id.slice(0, 12)}`,
      opencodeSessionId: s.id,
      opencodeDb: dbPath,
      title: s.title,
      timeUpdated: s.timeUpdated,
    }));
  } catch {
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

export function listCodexSessionSources(homeDir: string, workspaceRoot: string): ThoughtSource[] {
  const sessionsRoot = codexSessionsRoot(homeDir);
  if (!fs.existsSync(sessionsRoot)) return [];
  try {
    return listCodexSessions(homeDir, workspaceRoot).map(s => ({
      kind: 'codex' as const,
      label: `codex:${s.id.slice(0, 12)}`,
      codexRollout: s.rolloutPath,
      title: s.title,
      timeUpdated: s.timeUpdated,
    }));
  } catch {
    return [];
  }
}

export function listAntigravitySessionSources(homeDir: string, workspaceRoot: string): ThoughtSource[] {
  try {
    return listAntigravitySessions(homeDir, workspaceRoot).map(s => ({
      kind: 'antigravity' as const,
      label: `antigravity:${s.id.slice(0, 12)}`,
      antigravityTranscript: s.transcriptPath,
      title: s.title,
      timeUpdated: s.timeUpdated,
    }));
  } catch {
    return [];
  }
}

export function listZedSessionSources(homeDir: string, workspaceRoot: string): ThoughtSource[] {
  const dbPath = zedThreadsDbPath(homeDir);
  if (!fs.existsSync(dbPath) || !scanZedThreadSchema(dbPath)) return [];
  const db = openZedDb(dbPath);
  if (!db) return [];
  try {
    return listZedSessions(db, workspaceRoot).map(session => ({
      kind: 'zed' as const,
      label: `zed:${session.id.slice(0, 12)}`,
      zedDb: dbPath,
      zedSessionId: session.id,
      title: session.title,
      timeUpdated: session.updatedAt,
    }));
  } catch {
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

export function detectThoughtSources(opts: DetectThoughtSourcesOpts): ThoughtSource[] {
  const homeDir = opts.homeDir ?? os.homedir();
  const sources: ThoughtSource[] = [];
  const claudeFiles = opts.config?.claude
    ?? listClaudeJsonlSources(homeDir, opts.workspaceRoot);
  for (const file of claudeFiles) {
    sources.push({
      kind: 'claude',
      label: `claude:${path.basename(file, '.jsonl').slice(0, 12)}`,
      claudeJsonl: file,
    });
  }
  const opencodeSessions = opts.config?.opencode?.length
    ? (opts.config.opencode.map(id => {
        const dbPath = opencodeDbPath(homeDir);
        return { kind: 'opencode' as const, label: `opencode:${id.slice(0, 12)}`, opencodeSessionId: id, opencodeDb: dbPath };
      }))
    : listOpencodeSessionSources(homeDir, opts.workspaceRoot);
  sources.push(...opencodeSessions);
  const codexSessions = opts.config?.codex?.length
    ? listCodexSessions(homeDir)
        .filter(s => opts.config?.codex?.includes(s.id))
        .map(s => ({
          kind: 'codex' as const,
          label: `codex:${s.id.slice(0, 12)}`,
          codexRollout: s.rolloutPath,
          title: s.title,
          timeUpdated: s.timeUpdated,
        }))
    : listCodexSessionSources(homeDir, opts.workspaceRoot);
  sources.push(...codexSessions);
  const antigravitySessions = opts.config?.antigravity?.length
    ? (opts.config.antigravity.map(id => {
        const transcriptPath = path.join(antigravityBrainRoot(homeDir), id, '.system_generated', 'logs', 'transcript.jsonl');
        return { kind: 'antigravity' as const, label: `antigravity:${id.slice(0, 12)}`, antigravityTranscript: transcriptPath, timeUpdated: undefined };
      }))
    : listAntigravitySessionSources(homeDir, opts.workspaceRoot);
  sources.push(...antigravitySessions);
  const zedSessions = opts.config?.zed?.length
    ? listZedSessionSources(homeDir, opts.workspaceRoot).filter(s => opts.config?.zed?.includes(s.zedSessionId ?? ''))
    : listZedSessionSources(homeDir, opts.workspaceRoot);
  sources.push(...zedSessions);
  return sources;
}
