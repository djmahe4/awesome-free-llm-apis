import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import { TimelineManifestStore } from '../src/tools/media/timeline-manifest.js';

const TEST_DIR = path.resolve('tests/fixtures/timeline_test');

describe('TimelineManifestStore', () => {
  beforeEach(async () => {
    await fs.ensureDir(TEST_DIR);
  });

  afterEach(async () => {
    await fs.remove(TEST_DIR);
  });

  it('initializes empty manifest with all track lanes', async () => {
    const store = new TimelineManifestStore(TEST_DIR);
    const manifest = await store.init('ep_01', 'sess_abc');
    expect(manifest.projectId).toBe('ep_01');
    expect(manifest.tracks.video).toHaveLength(0);
    expect(manifest.tracks.bgm).toHaveLength(0);
    expect(manifest.tracks.vocal).toHaveLength(0);
    expect(manifest.tracks.song).toHaveLength(0);
    expect(manifest.totalDuration_ms).toBe(0);
  });

  it('adds artifact with deconfliction — no overlap on same track', async () => {
    const store = new TimelineManifestStore(TEST_DIR);
    await store.init('ep_01', 'sess_abc');

    const a1 = await store.addArtifact({
      track: 'bgm',
      start_ms: 0,
      end_ms: 30000,
      label: 'Intro BGM',
      engine: 'MusicGen',
      model: 'facebook/MusicGen',
      artifact_path: '/tmp/bgm.wav',
      status: 'generated',
      metadata: {},
      proposed_by: 'director'
    });
    expect(a1.start_ms).toBe(0);
    expect(a1.end_ms).toBe(30000);

    const a2 = await store.addArtifact({
      track: 'bgm',
      start_ms: 15000,
      end_ms: 45000,
      label: 'Bridge BGM',
      engine: 'MusicGen',
      model: 'facebook/MusicGen',
      artifact_path: '/tmp/bgm2.wav',
      status: 'pending',
      metadata: {},
      proposed_by: 'director'
    });
    expect(a2.start_ms).toBe(30000);
    expect(a2.end_ms).toBe(60000);
  });

  it('allows parallel artifacts on different tracks without conflict', async () => {
    const store = new TimelineManifestStore(TEST_DIR);
    await store.init('ep_01', 'sess_abc');

    await store.addArtifact({
      track: 'bgm',
      start_ms: 0,
      end_ms: 30000,
      label: 'Intro BGM',
      engine: 'MusicGen',
      model: 'facebook/MusicGen',
      artifact_path: '/tmp/bgm.wav',
      status: 'generated',
      metadata: {},
      proposed_by: 'director'
    });

    const vocal = await store.addArtifact({
      track: 'vocal',
      start_ms: 2000,
      end_ms: 5500,
      label: 'Line 1 Narration',
      engine: 'Kokoro-82M',
      model: 'kokoro-onnx/Kokoro-82M',
      artifact_path: '/tmp/voc.wav',
      status: 'generated',
      metadata: {},
      proposed_by: 'user'
    });
    expect(vocal.start_ms).toBe(2000);
    expect(vocal.end_ms).toBe(5500);
  });

  it('computes totalDuration_ms as max end_ms across all tracks', async () => {
    const store = new TimelineManifestStore(TEST_DIR);
    await store.init('ep_01', 'sess_abc');

    await store.addArtifact({
      track: 'bgm',
      start_ms: 0,
      end_ms: 30000,
      label: 'BGM',
      engine: 'MusicGen',
      model: 'facebook/MusicGen',
      artifact_path: '/tmp/bgm.wav',
      status: 'generated',
      metadata: {},
      proposed_by: 'director'
    });

    await store.addArtifact({
      track: 'song',
      start_ms: 45000,
      end_ms: 90000,
      label: 'Outro Song',
      engine: 'MusicGen',
      model: 'facebook/MusicGen',
      artifact_path: '/tmp/song.wav',
      status: 'pending',
      metadata: {},
      proposed_by: 'director'
    });

    const manifest = await store.load();
    expect(manifest.totalDuration_ms).toBe(90000);
  });

  it('avoids naming collisions by appending _v2 suffix to duplicate custom names', async () => {
    const store = new TimelineManifestStore(TEST_DIR);
    await store.init('ep_01', 'sess_abc');

    const art1 = await store.addArtifact({
      name: 'cinematic_overlay',
      track: 'vfx',
      start_ms: 0,
      end_ms: 5000,
      label: 'Overlay Layer 1',
      engine: 'LUT',
      model: 'lut3d',
      artifact_path: '/tmp/lut1.cube',
      status: 'generated',
      metadata: {},
      proposed_by: 'user'
    });
    expect(art1.name).toBe('cinematic_overlay');

    const art2 = await store.addArtifact({
      name: 'cinematic_overlay',
      track: 'vfx',
      start_ms: 5000,
      end_ms: 10000,
      label: 'Overlay Layer 2',
      engine: 'LUT',
      model: 'lut3d',
      artifact_path: '/tmp/lut2.cube',
      status: 'generated',
      metadata: {},
      proposed_by: 'user'
    });
    expect(art2.name).toBe('cinematic_overlay_v2');
  });

  it('permits intentional timestamp overlap on same lane when allowOverlap is true', async () => {
    const store = new TimelineManifestStore(TEST_DIR);
    await store.init('ep_01', 'sess_abc');

    const vfx1 = await store.addArtifact({
      track: 'vfx',
      start_ms: 0,
      end_ms: 10000,
      label: 'LUT Base',
      engine: 'LUT',
      model: 'lut3d',
      artifact_path: '/tmp/base.cube',
      status: 'approved',
      metadata: {},
      proposed_by: 'user'
    });

    // Add overlapping VFX layer (e.g. particle overlay) with allowOverlap
    const vfx2 = await store.addArtifact({
      track: 'vfx',
      start_ms: 2000,
      end_ms: 8000,
      allowOverlap: true,
      label: 'Particle Fog',
      engine: 'Overlay',
      model: 'alpha_blend',
      artifact_path: '/tmp/fog.mov',
      status: 'pending',
      metadata: {},
      proposed_by: 'user'
    });

    expect(vfx2.start_ms).toBe(2000);
    expect(vfx2.end_ms).toBe(8000);
  });
});
