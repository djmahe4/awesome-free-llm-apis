import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSkillPrompt } from '../src/tools/load-skill-prompt.js';
import fetch from 'node-fetch';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Mock node-fetch
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

const mockedFetch = fetch as any;

describe('load_skill_prompt', () => {
  const mockIndex = [
    { id: 'skill-1', name: 'Skill One', description: 'Description one', path: 'skills/skill-1' },
    { id: 'skill-2', name: 'Skill Two', description: 'Description two', path: 'skills/skill-2' },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');
    
    // Default mock for fetchJson (index)
    mockedFetch.mockImplementation(async (url: string) => {
      if (url.includes('skills.json')) {
        return {
          ok: true,
          json: async () => mockIndex,
        };
      }
      return { ok: false, status: 404 };
    });

    // Mock fs methods using spyOn
    vi.spyOn(fs, 'stat').mockRejectedValue(new Error('File not found'));
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined as any);
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(mockIndex));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('searches skills by keywords', async () => {
    const result = await loadSkillPrompt({
      type: 'search',
      keywords: ['one'],
    });

    expect(result.success).toBe(true);
    expect(result.skills).toContainEqual({ name: 'Skill One', description: 'Description one' });
  });

  it('handles fetch errors gracefully', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await loadSkillPrompt({
      type: 'search',
      keywords: ['test'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });

  it('uses workspaceDir if provided', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    const workspaceDir = path.normalize('/custom/workspace');
    await loadSkillPrompt({
      type: 'search',
      keywords: ['test'],
      workspaceDir,
    });

    expect(mkdirSpy).toHaveBeenCalledWith(
      expect.stringContaining(workspaceDir),
      { recursive: true }
    );
  });

  it('loads a bundled Hermes skill (e.g. humanizer) first when type is load without explicit source', async () => {
    const result = await loadSkillPrompt({
      type: 'load',
      name: 'humanizer',
    });

    expect(result.success).toBe(true);
    expect(result.skill).toBe('humanizer');
    expect(result.prompt).toBeDefined();
    expect(result.prompt).toContain('Humanizer: Remove AI Writing Patterns');
  });

  it('loads Hermes skill when skill parameter is used instead of name', async () => {
    const result = await loadSkillPrompt({
      type: 'load',
      skill: 'humanizer',
    });

    expect(result.success).toBe(true);
    expect(result.skill).toBe('humanizer');
    expect(result.prompt).toBeDefined();
    expect(result.prompt).toContain('Humanizer: Remove AI Writing Patterns');
  });
});
