import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { runMovieTool } from '../src/tools/movie-tool.js';

describe('movie_tool actions', () => {
  const tmpProjectDir = path.join(os.tmpdir(), `test_proj_${Date.now()}`);

  it('initializes timeline, retrieves tracks, and adds external media artifact', async () => {
    const initRes = await runMovieTool({
      action: 'init_project',
      projectId: 'test_audit_proj',
      premise: 'Cyberpunk short',
      projectDir: tmpProjectDir
    });
    if (!initRes.success) console.error('INIT ERROR:', initRes.error);
    expect(initRes.success).toBe(true);

    const getRes = await runMovieTool({
      action: 'get_timeline',
      projectId: 'test_audit_proj',
      projectDir: tmpProjectDir
    });
    expect(getRes.success).toBe(true);
    expect(getRes.data.tracks).toBeDefined();

    const addRes = await runMovieTool({
      action: 'add_artifact',
      projectId: 'test_audit_proj',
      projectDir: tmpProjectDir,
      track: 'video',
      start_ms: 0,
      end_ms: 5000,
      label: 'Opening Shot',
      artifact_path: 'https://example.com/opening.mp4'
    });
    expect(addRes.success).toBe(true);
    expect(addRes.data.track).toBe('video');
    expect(addRes.data.artifact_path).toBe('https://example.com/opening.mp4');
  });

  it('rejects an artifact_path outside the allowed roots before any write', async () => {
    const res = await runMovieTool({
      action: 'add_artifact',
      projectId: 'test_audit_proj',
      projectDir: tmpProjectDir,
      track: 'video',
      start_ms: 0,
      end_ms: 1000,
      label: 'Escape attempt',
      artifact_path: '/etc/passwd'
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/artifact_path is outside the allowed roots/);
  });
});
