import path from 'node:path';

const UNIFORM_DECL_DIR = '.free-llm-mcp/harness';
const LEGACY_DECL_DIR = 'harness';
const LEGACY_DECL_EXT = /\.ya?ml$/i;
const BRIDGES_FILE = '.free-llm-mcp/bridges.json';

function relativeToWorkspace(workspaceRoot: string, filePath: string): string | null {
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, path.resolve(root, filePath)).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  return rel;
}

export function isProtectedWritePath(workspaceRoot: string, filePath: string): boolean {
  const rel = relativeToWorkspace(workspaceRoot, filePath);
  if (rel === null) return false;
  const relLower = rel.toLowerCase();
  if (relLower === BRIDGES_FILE) return true;
  if (relLower.startsWith(`${UNIFORM_DECL_DIR}/`)) return true;
  if (
    (relLower.startsWith(`${LEGACY_DECL_DIR}/`) || relLower === LEGACY_DECL_DIR) &&
    LEGACY_DECL_EXT.test(rel)
  ) {
    return true;
  }
  return false;
}

export function assertPatchPathAllowed(workspaceRoot: string, filePath: string): void {
  if (isProtectedWritePath(workspaceRoot, filePath)) {
    throw new Error(
      `[security] hard-deny: patch targets protected harness path '${filePath}' — harness policy declarations and the bridge capability file cannot be modified by agent patches`
    );
  }
}
