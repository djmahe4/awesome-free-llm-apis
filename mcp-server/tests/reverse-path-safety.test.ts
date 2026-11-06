import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { validateSafePath, PathSafetyError } from '../src/reverse/path-safety.js';

describe('validateSafePath Confinement & Safety', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-test-')));
  });

  afterEach(() => {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('allows valid existing file inside workspace', () => {
    const filePath = path.join(tmpWorkspace, 'sample.js');
    fs.writeFileSync(filePath, 'console.log("hello");', 'utf-8');

    const result = validateSafePath(filePath, { workspaceRoot: tmpWorkspace });
    expect(result.safe).toBe(true);
    expect(result.canonicalPath).toBe(path.resolve(filePath));
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('resolves relative path within workspace', () => {
    const filePath = path.join(tmpWorkspace, 'sub', 'app.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const x = 1;', 'utf-8');

    const result = validateSafePath('sub/app.ts', { workspaceRoot: tmpWorkspace });
    expect(result.safe).toBe(true);
    expect(result.canonicalPath).toBe(path.resolve(filePath));
  });

  it('rejects directory traversal escaping workspace (throws PathSafetyError with code "traversal")', () => {
    expect(() => {
      validateSafePath('../../../etc/passwd', { workspaceRoot: tmpWorkspace });
    }).toThrow(PathSafetyError);

    try {
      validateSafePath('../../../etc/passwd', { workspaceRoot: tmpWorkspace });
    } catch (e: any) {
      expect(e.code).toBe('traversal');
      expect(e.message).toContain('escapes workspace root');
    }
  });

  it('rejects non-existent targets (code "not_found")', () => {
    const missing = path.join(tmpWorkspace, 'does-not-exist.js');
    try {
      validateSafePath(missing, { workspaceRoot: tmpWorkspace });
      expect.fail('Should have thrown');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('not_found');
    }
  });

  it('rejects symlinks when allowSymlinks is false (code "symlink")', () => {
    const targetFile = path.join(tmpWorkspace, 'target.js');
    fs.writeFileSync(targetFile, 'content', 'utf-8');
    const symlinkPath = path.join(tmpWorkspace, 'link.js');
    try {
      fs.symlinkSync(targetFile, symlinkPath);
    } catch {
      // Skip symlink creation if OS privileges disallow (e.g. non-admin Windows)
      return;
    }

    try {
      validateSafePath(symlinkPath, { workspaceRoot: tmpWorkspace, allowSymlinks: false });
      expect.fail('Should have rejected symlink');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('symlink');
      expect(e.message).toContain('Symlinks are not allowed');
    }
  });

  it('rejects directory target (code "is_directory")', () => {
    const subDir = path.join(tmpWorkspace, 'subdir');
    fs.mkdirSync(subDir);

    try {
      validateSafePath(subDir, { workspaceRoot: tmpWorkspace });
      expect.fail('Should have rejected directory');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('is_directory');
    }
  });

  it('rejects empty/whitespace path (code "not_found")', () => {
    try {
      validateSafePath('', { workspaceRoot: tmpWorkspace });
      expect.fail('Should have rejected empty path');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('not_found');
    }

    try {
      validateSafePath('   ', { workspaceRoot: tmpWorkspace });
      expect.fail('Should have rejected whitespace path');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('not_found');
    }
  });

  it('enforces maxSizeBytes cap (code "oversize")', () => {
    const bigFile = path.join(tmpWorkspace, 'large.bin');
    fs.writeFileSync(bigFile, Buffer.alloc(1024 * 1024)); // 1MB

    try {
      validateSafePath(bigFile, { workspaceRoot: tmpWorkspace, maxSizeBytes: 512 * 1024 }); // 512KB cap
      expect.fail('Should have rejected oversize file');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('oversize');
      expect(e.message).toContain('exceeds maximum allowed size');
    }
  });

  it('enforces allowedExtensions whitelist (code "invalid_extension")', () => {
    const wrongExt = path.join(tmpWorkspace, 'notes.txt');
    fs.writeFileSync(wrongExt, 'text', 'utf-8');

    try {
      validateSafePath(wrongExt, {
        workspaceRoot: tmpWorkspace,
        allowedExtensions: ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'],
      });
      expect.fail('Should have rejected invalid extension');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('invalid_extension');
    }
  });

  it('normalizes allowedExtensions without leading dots', () => {
    const validFile = path.join(tmpWorkspace, 'index.ts');
    fs.writeFileSync(validFile, 'export {};', 'utf-8');

    const result = validateSafePath(validFile, {
      workspaceRoot: tmpWorkspace,
      allowedExtensions: ['js', 'ts'],
    });
    expect(result.safe).toBe(true);
    expect(result.extension).toBe('.ts');
  });

  it('resolves and verifies canonical path and containment', () => {
    const subDir = path.join(tmpWorkspace, 'nested', 'deep');
    fs.mkdirSync(subDir, { recursive: true });
    const target = path.join(subDir, 'file.js');
    fs.writeFileSync(target, 'console.log(1);', 'utf-8');

    const relativeInput = path.join('nested', 'deep', '..', 'deep', 'file.js');
    const result = validateSafePath(relativeInput, { workspaceRoot: tmpWorkspace });

    expect(result.canonicalPath).toBe(fs.realpathSync(target));
    expect(result.relativePath).toBe(path.relative(fs.realpathSync(tmpWorkspace), fs.realpathSync(target)));
  });

  it('rejects null byte in path (code "traversal")', () => {
    try {
      validateSafePath('safe\0file.js', { workspaceRoot: tmpWorkspace });
      expect.fail('Should have rejected null byte');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('traversal');
      expect(e.message).toContain('null byte');
    }
  });

  it('allows file named "..config.json" without false-flagging traversal', () => {
    const filePath = path.join(tmpWorkspace, '..config.json');
    fs.writeFileSync(filePath, '{"key": "value"}', 'utf-8');

    const result = validateSafePath('..config.json', { workspaceRoot: tmpWorkspace });
    expect(result.safe).toBe(true);
    expect(result.canonicalPath).toBe(path.resolve(filePath));
  });

  it('handles dangling symlinks when allowSymlinks is true (code "not_found")', () => {
    const missingTarget = path.join(tmpWorkspace, 'does-not-exist.js');
    const symlinkPath = path.join(tmpWorkspace, 'dangling.js');
    try {
      fs.symlinkSync(missingTarget, symlinkPath);
    } catch {
      return; // Skip if OS privileges disallow symlinks
    }

    try {
      validateSafePath(symlinkPath, { workspaceRoot: tmpWorkspace, allowSymlinks: true });
      expect.fail('Should have rejected dangling symlink');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('not_found');
      expect(e.message).toContain('broken or does not exist');
    }
  });

  it('rejects symlink escaping workspace even when allowSymlinks is true (code "traversal")', () => {
    const outsideTarget = path.join(os.tmpdir(), 'outside-target.js');
    fs.writeFileSync(outsideTarget, 'console.log("outside");', 'utf-8');
    const symlinkPath = path.join(tmpWorkspace, 'escape-link.js');

    try {
      fs.symlinkSync(outsideTarget, symlinkPath);
    } catch {
      fs.rmSync(outsideTarget, { force: true });
      return; // Skip if OS privileges disallow symlinks
    }

    try {
      validateSafePath(symlinkPath, { workspaceRoot: tmpWorkspace, allowSymlinks: true });
      expect.fail('Should have rejected escaping symlink');
    } catch (e: any) {
      if (e.name === 'AssertionError') throw e;
      expect(e).toBeInstanceOf(PathSafetyError);
      expect(e.code).toBe('traversal');
      expect(e.message).toContain('escapes workspace root');
    } finally {
      fs.rmSync(outsideTarget, { force: true });
    }
  });

  it('allows extensionless files when allowedExtensions includes ""', () => {
    const binFile = path.join(tmpWorkspace, 'mybinary');
    fs.writeFileSync(binFile, '#!/bin/sh\necho hi', 'utf-8');

    const result = validateSafePath(binFile, {
      workspaceRoot: tmpWorkspace,
      allowedExtensions: ['', '.sh'],
    });
    expect(result.safe).toBe(true);
    expect(result.extension).toBe('');
  });
});
