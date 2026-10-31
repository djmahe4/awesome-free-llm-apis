import os from 'node:os';
import path from 'node:path';

/**
 * Base directory that holds `.free-llm-mcp`: FREE_LLM_MCP_HOME when set, else the user's home.
 * Resolved on every call so tests that change the env var after import are honoured.
 *
 * Under vitest, falling back to the real home directory would let tests write into the user's
 * live `~/.free-llm-mcp`, so that case throws instead (tests/setup.ts sets FREE_LLM_MCP_HOME).
 */
export function getMcpHome(): string {
  const fromEnv = process.env.FREE_LLM_MCP_HOME;
  if (fromEnv) return fromEnv;
  if (process.env.VITEST) {
    throw new Error(
      'Refusing to resolve the real home directory under vitest: FREE_LLM_MCP_HOME is unset. ' +
      'Set it to a temporary directory (tests/setup.ts does this for the shared sandbox).',
    );
  }
  return os.homedir();
}

/** `<home>/.free-llm-mcp` */
export function getMcpDir(): string {
  return path.join(getMcpHome(), '.free-llm-mcp');
}

/**
 * Makes a caller-supplied session id safe to use as one path segment: letters, digits, `_`, `.`
 * and `-` only, no leading dot, no `..`, at most 64 characters, never empty.
 */
export function sanitizeSessionId(id: string): string {
  let s = String(id ?? '').replace(/[^\w.-]+/g, '_').replace(/\.{2,}/g, '_').replace(/^[._-]+/, '');
  s = s.slice(0, 64);
  return s || 'session';
}
