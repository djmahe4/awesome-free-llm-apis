import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import { runMovieTool } from '../src/tools/movie-tool.js';

const TEST_DIR = path.resolve('tests/fixtures/movie_tool_test');

describe('runMovieTool', () => {
  beforeEach(async () => {
    await fs.ensureDir(TEST_DIR);
  });

  afterEach(async () => {
    await fs.remove(TEST_DIR);
  });

  it('rejects init_project without projectId or premise', async () => {
    const res = await runMovieTool({ action: 'init_project' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('projectId and premise required');
  });

  it('rejects approve_artifact without artifactId', async () => {
    const res = await runMovieTool({ action: 'approve_artifact', projectId: 'test', projectDir: TEST_DIR });
    expect(res.success).toBe(false);
    expect(res.error).toContain('artifactId required');
  });

  it('rejects generate_assets without track or prompt', async () => {
    const res = await runMovieTool({ action: 'generate_assets', projectId: 'test', projectDir: TEST_DIR });
    expect(res.success).toBe(false);
    expect(res.error).toContain('track required');
  });

  it('initializes project and adds artifact to timeline manifest', async () => {
    const initRes = await runMovieTool({
      action: 'init_project',
      projectId: 'ep_test',
      premise: 'Space odyssey educational short',
      projectDir: TEST_DIR
    });
    expect(initRes.success).toBe(true);
    expect(initRes.data.projectId).toBe('ep_test');

    const addRes = await runMovieTool({
      action: 'add_artifact',
      projectId: 'ep_test',
      projectDir: TEST_DIR,
      track: 'video',
      start_ms: 0,
      end_ms: 5000,
      label: 'Hero space shot',
      engine: 'FLUX.1-schnell',
      model: 'flux'
    });
    expect(addRes.success).toBe(true);
    expect(addRes.data.start_ms).toBe(0);
    expect(addRes.data.end_ms).toBe(5000);
  });

  it('handles generate_story action with premise', async () => {
    const storyRes = await runMovieTool({
      action: 'generate_story',
      projectId: 'ep_test',
      projectDir: TEST_DIR,
      premise: 'A cyber hacker discovers a quantum anomaly in neo-Tokyo.',
      metadata: {
        tone: 'cyberpunk suspense',
        characters: [{ name: 'Kira', description: 'Rebel code-breaker' }]
      }
    });
    expect(storyRes.success).toBe(true);
    expect(typeof storyRes.data.script).toBe('string');
    expect(storyRes.data.script.length).toBeGreaterThan(0);
  });
});
