import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromeCandidates, resolveChromeExecutable, npxInvocation } from '../src/browser/DevToolsClient.js';
import { profileDirFor } from '../src/browser/BrowserSession.js';

describe('chromeCandidates (platform + env aware)', () => {
  it('honors CHROME_PATH first on Windows and finds standard install roots', () => {
    const env = {
      CHROME_PATH: 'D:\\browsers\\chrome.exe',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    } as NodeJS.ProcessEnv;
    const list = chromeCandidates({ platform: 'win32', env });
    expect(list[0]).toBe('D:\\browsers\\chrome.exe');
    expect(list).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(list).toContain('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    expect(list).toContain('C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
    expect(list.some((p) => p.endsWith('msedge.exe'))).toBe(true);
    expect(list.some((p) => p.endsWith('chrome.exe'))).toBe(true);
  });

  it('expands %VAR% and strips quotes in Windows paths', () => {
    const env = {
      CHROME_PATH: '"%LOCALAPPDATA%\\Google\\Chrome\\chrome.exe"',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    } as NodeJS.ProcessEnv;
    const list = chromeCandidates({ platform: 'win32', env });
    expect(list[0]).toBe('C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\chrome.exe');
  });

  it('keeps the linux candidate set and never mixes in Windows paths', () => {
    const list = chromeCandidates({ platform: 'linux', env: {} as NodeJS.ProcessEnv });
    expect(list).toContain('/usr/bin/chromium');
    expect(list).toContain('/usr/bin/google-chrome');
    expect(list).toContain('/opt/google/chrome/chrome');
    expect(list.some((p) => p.endsWith('.exe'))).toBe(false);
    expect(list.some((p) => p.includes('Program Files'))).toBe(false);
  });

  it('returns macOS app-bundle paths on darwin', () => {
    const list = chromeCandidates({ platform: 'darwin', env: { HOME: '/Users/dev' } as NodeJS.ProcessEnv });
    expect(list).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(list).toContain('/Users/dev/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });
});

describe('resolveChromeExecutable', () => {
  it('returns an existing executable from CHROME_PATH regardless of platform', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chrome-cand-'));
    const exe = path.join(dir, 'chrome-stub');
    await fsp.writeFile(exe, '#!/bin/sh\n', { mode: 0o755 });
    try {
      const resolved = await resolveChromeExecutable({ platform: 'win32', env: { CHROME_PATH: exe } as NodeJS.ProcessEnv });
      expect(resolved).toBe(exe);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('skips a non-executable CHROME_PATH on unix-like platforms (X_OK enforced)', async () => {
    if (process.platform === 'win32') return; // Windows fs does not support POSIX X_OK bit checks
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chrome-noexec-'));
    const exe = path.join(dir, 'chrome-stub');
    await fsp.writeFile(exe, 'not executable\n', { mode: 0o644 });
    try {
      // darwin candidates do not exist on the test host, so only CHROME_PATH is probed.
      const resolved = await resolveChromeExecutable({ platform: 'darwin', env: { CHROME_PATH: exe, HOME: '/nonexistent-home' } as NodeJS.ProcessEnv });
      expect(resolved).toBeUndefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('returns undefined when no candidate exists (Windows probe with no installs)', async () => {
    if (process.platform === 'win32') {
      const { access } = await import('node:fs/promises');
      try {
        await access('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
        return; // Host has real Chrome installed, so fallback probe will locate it
      } catch {
        // proceed
      }
    }
    const resolved = await resolveChromeExecutable({
      platform: 'win32',
      env: {} as NodeJS.ProcessEnv, // no PROGRAMFILES/LOCALAPPDATA/CHROME_PATH — only hardcoded C:\ paths, absent on the test host
    });
    expect(resolved).toBeUndefined();
  });
});

describe('npxInvocation (Windows cannot spawn .cmd without a shell)', () => {
  it('uses plain npx on non-Windows platforms', () => {
    expect(npxInvocation({ platform: 'linux' })).toEqual({ command: 'npx', args: [] });
    expect(npxInvocation({ platform: 'darwin' })).toEqual({ command: 'npx', args: [] });
  });

  it('runs npm npx-cli.js under the current node binary on Windows when present', () => {
    const execPath = 'C:\\Program Files\\nodejs\\node.exe';
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';
    const result = npxInvocation({
      platform: 'win32',
      execPath,
      env: {} as NodeJS.ProcessEnv,
      exists: (p) => p === cli,
    });
    expect(result).toEqual({ command: execPath, args: [cli] });
  });

  it('falls back to npm_execpath npx-cli.js when set', () => {
    const cli = 'D:\\tooling\\npm\\bin\\npx-cli.js';
    const result = npxInvocation({
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      env: { npm_execpath: cli } as NodeJS.ProcessEnv,
      exists: (p) => p === cli,
    });
    expect(result).toEqual({ command: 'C:\\node\\node.exe', args: [cli] });
  });

  it('falls back to npx.cmd only when no CLI script can be found', () => {
    const result = npxInvocation({
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      env: {} as NodeJS.ProcessEnv,
      exists: () => false,
    });
    expect(result).toEqual({ command: 'npx.cmd', args: [] });
  });
});

describe('profileDirFor (env-driven, Windows-safe)', () => {
  it('explicit userDataDir wins over everything', () => {
    expect(
      profileDirFor('session_a', {
        userDataDir: '/exact/dir',
        env: { WIKI_BROWSER_PROFILE_DIR: '/base' } as NodeJS.ProcessEnv,
        tmpdir: '/tmp',
      })
    ).toBe('/exact/dir');
  });

  it('uses WIKI_BROWSER_PROFILE_DIR as the base when set (no CLI args needed)', () => {
    expect(
      profileDirFor('session_a', {
        env: { WIKI_BROWSER_PROFILE_DIR: '/custom/profiles' } as NodeJS.ProcessEnv,
        tmpdir: '/tmp',
      })
    ).toBe(path.join('/custom/profiles', 'session_a'));
  });

  it('falls back to CHROME_USER_DATA_DIR as the base', () => {
    expect(
      profileDirFor('session_a', {
        env: { CHROME_USER_DATA_DIR: '/chrome/data' } as NodeJS.ProcessEnv,
        tmpdir: '/tmp',
      })
    ).toBe(path.join('/chrome/data', 'session_a'));
  });

  it('prefers WIKI_BROWSER_PROFILE_DIR over CHROME_USER_DATA_DIR', () => {
    expect(
      profileDirFor('session_a', {
        env: {
          WIKI_BROWSER_PROFILE_DIR: '/primary',
          CHROME_USER_DATA_DIR: '/secondary',
        } as NodeJS.ProcessEnv,
        tmpdir: '/tmp',
      })
    ).toBe(path.join('/primary', 'session_a'));
  });

  it('expands %VAR% and strips quotes from the env base dir', () => {
    expect(
      profileDirFor('session_a', {
        env: {
          WIKI_BROWSER_PROFILE_DIR: '"%ROOT%/wiki-profiles"',
          ROOT: '/data',
        } as NodeJS.ProcessEnv,
        tmpdir: '/tmp',
      })
    ).toBe(path.join('/data/wiki-profiles', 'session_a'));
  });

  it('defaults to <tmpdir>/wiki-browser-profiles (previous behavior, env-free)', () => {
    expect(profileDirFor('session_browser', { tmpdir: '/tmp' })).toBe(
      path.join('/tmp', 'wiki-browser-profiles', 'session_browser')
    );
  });

  it('sanitizes URLs and query strings to a single safe path segment', () => {
    const dir = profileDirFor('session_https://example.com/x?y=1', { tmpdir: '/tmp' });
    const segment = path.basename(dir);
    expect(segment).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(dir.startsWith(path.join('/tmp', 'wiki-browser-profiles') + path.sep)).toBe(true);
  });

  it('escapes Windows reserved device names', () => {
    expect(path.basename(profileDirFor('con', { tmpdir: '/tmp' }))).toBe('s_con');
    expect(path.basename(profileDirFor('nul', { tmpdir: '/tmp' }))).toBe('s_nul');
    expect(path.basename(profileDirFor('COM3', { tmpdir: '/tmp' }))).toBe('s_COM3');
    expect(path.basename(profileDirFor('con.txt', { tmpdir: '/tmp' }))).toBe('s_con.txt');
    expect(path.basename(profileDirFor('nul.profile', { tmpdir: '/tmp' }))).toBe('s_nul.profile');
    expect(path.basename(profileDirFor('aux.json', { tmpdir: '/tmp' }))).toBe('s_aux.json');
  });

  it('caps the segment at 64 chars and never produces an empty segment', () => {
    const segment = path.basename(profileDirFor('x'.repeat(200), { tmpdir: '/tmp' }));
    expect(segment.length).toBe(64);
    expect(path.basename(profileDirFor('///', { tmpdir: '/tmp' }))).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
