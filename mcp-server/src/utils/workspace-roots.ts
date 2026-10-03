import path from 'node:path';
import fs from 'node:fs';

export function splitRoots(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,:]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => path.resolve(s));
}

export function isInsideRoot(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isInsideRoots(target: string, roots: string[]): boolean {
  return roots.some(root => isInsideRoot(target, root));
}

export function resolveWithin(root: string, relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath.includes('\0')) return null;
  const rootReal = real(path.resolve(root));
  const full = path.resolve(rootReal, relPath);
  if (!isInsideRoot(full, rootReal)) return null;
  if (!isInsideRoot(real(full), rootReal)) return null;
  return full;
}

function real(p: string): string {
  let current = p;
  const tailSegments: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return tailSegments.length ? path.join(fs.realpathSync(current), ...tailSegments) : fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      tailSegments.unshift(path.basename(current));
      current = parent;
    }
  }
  return p;
}

/**
 * Roots the HTTP dashboard may read or write: the server working directory plus
 * anything listed in WORKSPACE_ROOTS (comma/colon separated). Symlinks are
 * resolved before comparison so a link inside an allowed root cannot point out.
 */
export function allowedWorkspaceRoots(): string[] {
  return [path.resolve(process.cwd()), ...splitRoots(process.env.WORKSPACE_ROOTS)].map(real);
}

/**
 * Resolve a caller-supplied path (absolute, or relative to cwd) and return it
 * only when it lands inside the allowed roots — otherwise null.
 */
export function resolvePathWithinRoots(raw: string): string | null {
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(process.cwd(), raw);
  return isInsideRoots(real(resolved), allowedWorkspaceRoots()) ? resolved : null;
}

/**
 * Guard for a caller-supplied path parameter (projectDir, workspace, file, …).
 * Returns an error message when the value is present but unusable, null otherwise.
 */
export function pathParamWithinRoots(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return `${label} must be a string`;
  const v = value.trim();
  if (!v) return null;
  if (v.includes('\0')) return `${label} contains an invalid character`;
  if (!resolvePathWithinRoots(v)) return `${label} is outside the allowed roots (WORKSPACE_ROOTS)`;
  return null;
}

/**
 * Guard for a caller-supplied id that gets joined into a path
 * (path.resolve(cwd, 'projects', id)) — must be a plain name segment.
 */
export function relativeSegmentError(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return `${label} must be a string`;
  const v = value.trim();
  if (!v) return null;
  if (v.includes('\0') || v.includes('/') || v.includes('\\') || v === '.' || v === '..') {
    return `${label} must be a plain name (no path separators)`;
  }
  return null;
}
