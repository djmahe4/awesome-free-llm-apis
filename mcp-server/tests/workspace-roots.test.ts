import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  splitRoots,
  isInsideRoot,
  isInsideRoots,
  resolvePathWithinRoots,
  pathParamWithinRoots,
  relativeSegmentError,
} from '../src/utils/workspace-roots.js';

describe('workspace-roots', () => {
  const prevWorkspaceRoots = process.env.WORKSPACE_ROOTS;

  afterEach(() => {
    if (prevWorkspaceRoots === undefined) delete process.env.WORKSPACE_ROOTS;
    else process.env.WORKSPACE_ROOTS = prevWorkspaceRoots;
  });

  describe('splitRoots', () => {
    it('splits on commas and colons, trims, and drops empties', () => {
      expect(splitRoots(' /a ,  ,,  b/c : ')).toEqual([path.resolve('/a'), path.resolve('b/c')]);
    });

    it('resolves relative entries against cwd and returns [] for unset', () => {
      expect(splitRoots(undefined)).toEqual([]);
      expect(splitRoots('')).toEqual([]);
      expect(splitRoots('x')).toEqual([path.resolve(process.cwd(), 'x')]);
    });
  });

  describe('isInsideRoot / isInsideRoots', () => {
    it('accepts the root itself and nested paths', () => {
      expect(isInsideRoot('/a', '/a')).toBe(true);
      expect(isInsideRoot('/a/b/c', '/a')).toBe(true);
    });

    it('rejects traversal and prefix-sibling paths', () => {
      expect(isInsideRoot('/etc/passwd', '/a')).toBe(false);
      expect(isInsideRoot('/ab', '/a')).toBe(false);
      expect(isInsideRoots('/ab', ['/a'])).toBe(false);
      expect(isInsideRoots('/a/b', ['/x', '/a'])).toBe(true);
    });
  });

  describe('resolvePathWithinRoots', () => {
    let outside: string;
    let root: string;

    beforeAll(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-out-'));
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-in-'));
    });

    afterAll(() => {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('resolves relative paths inside the server cwd', () => {
      expect(resolvePathWithinRoots('package.json')).toBe(path.resolve(process.cwd(), 'package.json'));
    });

    it('rejects absolute paths outside the allowed roots', () => {
      process.env.WORKSPACE_ROOTS = '';
      expect(resolvePathWithinRoots(path.join(outside, 'secret.mp4'))).toBeNull();
    });

    it('allows roots listed in WORKSPACE_ROOTS', () => {
      process.env.WORKSPACE_ROOTS = root;
      expect(resolvePathWithinRoots(path.join(root, 'clip.mp4'))).toBe(path.join(root, 'clip.mp4'));
    });

    it('rejects a symlinked component that escapes the allowed roots', () => {
      process.env.WORKSPACE_ROOTS = root;
      const link = path.join(root, 'escape');
      fs.symlinkSync(outside, link, 'dir');
      try {
        expect(resolvePathWithinRoots(path.join(link, 'secret.mp4'))).toBeNull();
      } finally {
        fs.rmSync(link, { force: true });
      }
    });
  });

  describe('pathParamWithinRoots', () => {
    it('passes absent values through', () => {
      expect(pathParamWithinRoots(undefined, 'projectDir')).toBeNull();
      expect(pathParamWithinRoots(null, 'projectDir')).toBeNull();
      expect(pathParamWithinRoots('', 'projectDir')).toBeNull();
      expect(pathParamWithinRoots('   ', 'projectDir')).toBeNull();
    });

    it('rejects non-string values', () => {
      expect(pathParamWithinRoots(42, 'projectDir')).toMatch(/must be a string/);
      expect(pathParamWithinRoots({ a: 1 }, 'projectDir')).toMatch(/must be a string/);
    });

    it('rejects null bytes and paths outside the allowed roots', () => {
      expect(pathParamWithinRoots('a\0b', 'projectDir')).toMatch(/invalid character/);
      expect(pathParamWithinRoots('/etc', 'projectDir')).toMatch(/outside the allowed roots/);
      expect(pathParamWithinRoots('projects/ok', 'projectDir')).toBeNull();
    });
  });

  describe('relativeSegmentError', () => {
    it('accepts plain names and absent values', () => {
      expect(relativeSegmentError('my-project', 'projectId')).toBeNull();
      expect(relativeSegmentError(undefined, 'projectId')).toBeNull();
      expect(relativeSegmentError('', 'projectId')).toBeNull();
    });

    it('rejects traversal and path separators', () => {
      expect(relativeSegmentError('../etc', 'projectId')).toMatch(/plain name/);
      expect(relativeSegmentError('a/b', 'projectId')).toMatch(/plain name/);
      expect(relativeSegmentError('a\\b', 'projectId')).toMatch(/plain name/);
      expect(relativeSegmentError('..', 'projectId')).toMatch(/plain name/);
      expect(relativeSegmentError(7, 'projectId')).toMatch(/must be a string/);
    });
  });
});
