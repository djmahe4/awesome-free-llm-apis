/**
 * T8 — general project-bridge mechanism for `cyber_tool` `run_action`.
 *
 * A project declares named bridges in `<workspaceRoot>/.free-llm-mcp/bridges.json`:
 *
 * ```json
 * { "bridges": { "katana": { "command": ["python3", "cli/cyber_bridge.py"], "cwd": "." } } }
 * ```
 *
 * Nothing here is cyber-specific: any project folder (or several, each with
 * its own config) can declare any number of servers/bridges and run_action
 * will spawn the selected one as a subprocess — argv array only (no shell) —
 * feed it `{actionName, target, args, authorization}` on stdin and parse ONE
 * JSON object from stdout (the bridge's Finding).
 *
 * Trust model: bridges.json is a capability token. Whoever can write the
 * project's config decides what may be spawned from that workspace root;
 * the only structural checks enforced here are shape validation and that a
 * bridge's cwd stays inside workspaceRoot.
 *
 * Every failure throws an `Error` with an operator-facing message — the
 * `run_action` caller converts it to `{success:false, error}` (never throws
 * out of cyberTool).
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { splitRoots, isInsideRoot as insideRoot, real } from '../utils/workspace-roots.js';

export interface BridgeEntry {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface BridgesConfig {
  bridges: Record<string, BridgeEntry>;
}

/** Hard cap on a bridge subprocess — dispatch-style tools should be fast. */
export const BRIDGE_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 1_024 * 1_024;
const MAX_STDERR_CHARS = 8_192;

export function bridgesConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.free-llm-mcp', 'bridges.json');
}

function tail(text: string, max = 500): string {
  const t = (text || '').trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

export function bridgeWorkspaceRoots(): string[] {
  return splitRoots(process.env.BRIDGE_WORKSPACE_ROOTS);
}

export function assertBridgeWorkspaceRootAllowed(workspaceRoot: string): void {
  const realResolved = real(path.resolve(workspaceRoot));
  const roots = bridgeWorkspaceRoots().map(real);
  if (roots.length > 0) {
    if (roots.some(root => realResolved === root || insideRoot(realResolved, root))) return;
    throw new Error(`workspace_root '${workspaceRoot}' is not permitted — BRIDGE_WORKSPACE_ROOTS allows: ${roots.join(', ')}`);
  }
  const serverRoot = real(path.resolve(process.cwd()));
  if (realResolved === serverRoot || insideRoot(realResolved, serverRoot)) return;
  throw new Error(`workspace_root '${workspaceRoot}' is outside the server working directory (${path.resolve(process.cwd())}) — set BRIDGE_WORKSPACE_ROOTS to the project folder(s) whose bridges.json may run`);
}

async function selectBridge(workspaceRoot: string, bridgeName?: string): Promise<{ name: string; entry: BridgeEntry }> {
  const configPath = bridgesConfigPath(workspaceRoot);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(`No bridges.json found at ${configPath} — declare project bridges in .free-llm-mcp/bridges.json`);
    }
    throw new Error(`Cannot read bridges.json at ${configPath}: ${err?.message ?? err}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Invalid JSON in bridges.json (${configPath}): ${err?.message ?? err}`);
  }

  const bridges = (parsed as BridgesConfig)?.bridges;
  if (!bridges || typeof bridges !== 'object' || Array.isArray(bridges) || Object.keys(bridges).length === 0) {
    throw new Error(`bridges.json (${configPath}) must declare a non-empty "bridges" object`);
  }
  const names = Object.keys(bridges);

  let name = bridgeName;
  if (!name) {
    if (names.length !== 1) {
      throw new Error(`Multiple bridges declared [${names.join(', ')}] — pass 'bridge' explicitly to run_action`);
    }
    [name] = names;
  }
  const entry = bridges[name];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Unknown bridge '${name}' in bridges.json (${configPath}) — declared bridges: [${names.join(', ')}]`);
  }
  if (!Array.isArray(entry.command) || entry.command.length === 0 || entry.command.some(c => typeof c !== 'string' || !c)) {
    throw new Error(`Bridge '${name}' must declare "command" as a non-empty list of strings in ${configPath}`);
  }

  // cwd (default: workspaceRoot) must stay inside the workspace root even
  // though the config itself is trusted — a traversal cwd is almost always
  // a mistake, and it is the one shape check that costs nothing.
  const cwd = path.resolve(workspaceRoot, entry.cwd ?? '.');
  const rel = path.relative(path.resolve(workspaceRoot), cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Bridge '${name}' cwd '${entry.cwd}' escapes the workspace root — cwd must stay inside ${workspaceRoot} (${configPath})`);
  }

  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)
      || Object.values(entry.env).some(v => typeof v !== 'string')) {
      throw new Error(`Bridge '${name}' env must be a mapping of string values in ${configPath}`);
    }
  }

  return { name, entry: { ...entry, cwd } };
}

const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'NO_COLOR'];

export function buildBridgeEnv(entry: BridgeEntry): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  return { ...env, ...(entry.env ?? {}) };
}

function buildArgv(entry: BridgeEntry): { file: string; args: string[] } {
  const [cmd0, ...rest] = entry.command;
  const cwd = entry.cwd ?? process.cwd();
  // Absolute and ./relative paths resolve against the bridge cwd; bare
  // names (python3, node, …) go through PATH untouched.
  const file = cmd0.startsWith('/') ? cmd0 : cmd0.startsWith('.') ? path.resolve(cwd, cmd0) : cmd0;
  return { file, args: rest };
}

/**
 * Spawn the selected (or single declared) bridge and return its parsed JSON.
 * Throws `Error` on every failure mode — caller maps it to `{success:false}`.
 */
export async function runProjectBridge(opts: {
  workspaceRoot: string;
  bridge?: string;
  actionName: string;
  target: string;
  args?: Record<string, unknown>;
  authorization: string;
}): Promise<{ bridge: string; finding: unknown }> {
  assertBridgeWorkspaceRootAllowed(opts.workspaceRoot);
  const { name, entry } = await selectBridge(opts.workspaceRoot, opts.bridge);
  const { file, args } = buildArgv(entry);
  const payload = JSON.stringify({
    actionName: opts.actionName,
    target: opts.target,
    args: opts.args ?? {},
    authorization: opts.authorization,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const child = spawn(file, args, { cwd: entry.cwd, env: buildBridgeEnv(entry), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => reject(new Error(`Bridge '${name}' timed out after ${BRIDGE_TIMEOUT_MS}ms`)));
    }, BRIDGE_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += d.toString('utf-8');
      else child.kill('SIGKILL');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += d.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done(() => reject(new Error(`Bridge '${name}' failed to spawn (${file}): ${err.message}`)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(() => {
        if (code !== 0) {
          reject(new Error(`Bridge '${name}' exited with code ${code}: ${tail(stderr || stdout)}`));
          return;
        }
        let finding: unknown;
        try {
          finding = JSON.parse(stdout.trim());
        } catch {
          reject(new Error(`Bridge '${name}' did not print a JSON object on stdout: ${tail(stdout)}`));
          return;
        }
        if (finding === null || typeof finding !== 'object') {
          reject(new Error(`Bridge '${name}' printed non-object JSON: ${tail(stdout)}`));
          return;
        }
        resolve({ bridge: name, finding });
      });
    });

    child.stdin.on('error', () => { /* bridge exited before stdin closed */ });
    child.stdin.write(payload);
    child.stdin.end();
  });
}
