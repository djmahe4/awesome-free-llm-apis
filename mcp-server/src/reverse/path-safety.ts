import path from 'node:path';
import fs from 'node:fs';
import { getMcpHome } from '../utils/mcp-home.js';

export type PathSafetyErrorCode =
  | 'traversal'
  | 'not_found'
  | 'symlink'
  | 'oversize'
  | 'invalid_extension'
  | 'is_directory';

export class PathSafetyError extends Error {
  public readonly code: PathSafetyErrorCode;

  constructor(message: string, code: PathSafetyErrorCode) {
    super(message);
    this.name = 'PathSafetyError';
    this.code = code;
  }
}

export interface PathSafetyOptions {
  workspaceRoot?: string;
  allowedExtensions?: string[];
  maxSizeBytes?: number;
  allowSymlinks?: boolean;
}

export interface SafePathResult {
  safe: boolean;
  canonicalPath: string;
  relativePath: string;
  sizeBytes: number;
  extension: string;
}

/**
 * Validates that targetPath is confined within the allowed workspaceRoot,
 * is not a symlink (unless explicitly allowed), exists, does not exceed size limits,
 * and matches allowed extension rules. Integrates with getMcpHome() for home isolation.
 */
export function validateSafePath(targetPath: string, options: PathSafetyOptions = {}): SafePathResult {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new PathSafetyError('Target path cannot be empty', 'not_found');
  }

  if (targetPath.includes('\0')) {
    throw new PathSafetyError('Target path contains invalid null byte', 'traversal');
  }

  let defaultRoot: string;
  try {
    defaultRoot = process.cwd();
  } catch {
    defaultRoot = getMcpHome();
  }

  const workspaceRoot = path.resolve(options.workspaceRoot || defaultRoot);
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspaceRoot, targetPath);

  // 1. Boundary & Directory Traversal Check
  const relative = path.relative(workspaceRoot, resolvedPath);
  const escapes = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  if (escapes) {
    throw new PathSafetyError(
      `Target path "${targetPath}" escapes workspace root "${workspaceRoot}"`,
      'traversal'
    );
  }

  // 2. Existence & Canonicalization Check
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolvedPath);
  } catch {
    throw new PathSafetyError(`Target file "${targetPath}" does not exist`, 'not_found');
  }

  if (lstat.isSymbolicLink() && options.allowSymlinks !== true) {
    throw new PathSafetyError(
      `Symlinks are not allowed for security containment: "${targetPath}"`,
      'symlink'
    );
  }

  let canonicalTarget: string;
  let stat: fs.Stats;
  try {
    canonicalTarget = fs.realpathSync(resolvedPath);
    stat = fs.statSync(canonicalTarget);
  } catch (err: any) {
    throw new PathSafetyError(`Target file "${targetPath}" is broken or does not exist: ${err.message}`, 'not_found');
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(workspaceRoot);
  } catch {
    canonicalRoot = workspaceRoot;
  }

  const canonicalRel = path.relative(canonicalRoot, canonicalTarget);
  if (canonicalRel === '..' || canonicalRel.startsWith('..' + path.sep) || path.isAbsolute(canonicalRel)) {
    throw new PathSafetyError(
      `Target path "${targetPath}" escapes workspace root "${workspaceRoot}"`,
      'traversal'
    );
  }

  if (stat.isDirectory()) {
    throw new PathSafetyError(`Target "${targetPath}" is a directory, not a file`, 'is_directory');
  }

  // 3. Extension Check
  const ext = path.extname(canonicalTarget).toLowerCase();
  const resolvedExt = path.extname(resolvedPath).toLowerCase();
  if (options.allowedExtensions && options.allowedExtensions.length > 0) {
    const normalizedAllowed = options.allowedExtensions.map((e) =>
      !e || e === '' ? '' : (e.startsWith('.') ? e.toLowerCase() : '.' + e.toLowerCase())
    );
    if (!normalizedAllowed.includes(resolvedExt) || !normalizedAllowed.includes(ext)) {
      const displayExt = !normalizedAllowed.includes(resolvedExt) ? resolvedExt : ext;
      throw new PathSafetyError(
        `File extension "${displayExt}" is not permitted. Allowed: ${normalizedAllowed.join(', ')}`,
        'invalid_extension'
      );
    }
  }

  // 4. File Size Cap
  const maxBytes = options.maxSizeBytes ?? 50 * 1024 * 1024; // Default 50MB
  if (stat.size > maxBytes) {
    throw new PathSafetyError(
      `File size (${stat.size} bytes) exceeds maximum allowed size (${maxBytes} bytes)`,
      'oversize'
    );
  }

  return {
    safe: true,
    canonicalPath: canonicalTarget,
    relativePath: canonicalRel,
    sizeBytes: stat.size,
    extension: ext,
  };
}
