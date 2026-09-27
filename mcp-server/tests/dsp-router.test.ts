import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import {
  buildAudioDspFilter,
  buildVideoFxFilter,
  normalizeOrRandomizeEffect,
  AUDIO_EFFECT_TYPES,
  VIDEO_EFFECT_TYPES
} from '../src/tools/media/dsp-router.js';
import { TimelineManifestStore } from '../src/tools/media/timeline-manifest.js';
import { runMovieTool } from '../src/tools/movie-tool.js';

const TEST_DIR = path.resolve('tests/fixtures/dsp_router_test');

describe('DSP Router & Remix Plugins', () => {
  beforeEach(async () => {
    await fs.ensureDir(TEST_DIR);
  });

  afterEach(async () => {
    await fs.remove(TEST_DIR);
  });

  describe('buildAudioDspFilter', () => {
    it('generates pitch shift filter with atempo compensation', () => {
      const filter = buildAudioDspFilter([
        { id: '1', type: 'pitch', params: { semitones: 4, sampleRate: 24000 } }
      ]);
      expect(filter).toContain('asetrate=30238');
      expect(filter).toContain('atempo=0.7937');
    });

    it('chains multiple atempo filters for extreme pitch shift beyond 12 semitones', () => {
      // semitones +16: ratio = 2.5198, tempoComp = 0.3968 < 0.5
      const filter = buildAudioDspFilter([
        { id: '1', type: 'pitch', params: { semitones: 16, sampleRate: 24000 } }
      ]);
      expect(filter).toContain('atempo=0.5,atempo=0.7937');
    });

    it('generates stereo pan filter', () => {
      const filter = buildAudioDspFilter([
        { id: '2', type: 'pan', params: { pan: -0.5 } }
      ]);
      expect(filter).toContain('pan=stereo');
      expect(filter).toContain('c0=0.75*c0+0.75*c1');
      expect(filter).toContain('c1=0.25*c0+0.25*c1');
    });

    it('generates tempo factor filter without pitch change', () => {
      const filter = buildAudioDspFilter([
        { id: '3', type: 'tempo', params: { factor: 1.25 } }
      ]);
      expect(filter).toBe('atempo=1.2500');
    });

    it('chains multiple atempo filters for extreme tempo factor > 2.0', () => {
      const filter = buildAudioDspFilter([
        { id: '3b', type: 'tempo', params: { factor: 3.0 } }
      ]);
      expect(filter).toBe('atempo=2.0,atempo=1.5000');
    });

    it('generates reverb echo filter', () => {
      const filter = buildAudioDspFilter([
        { id: '4', type: 'reverb', params: { inGain: 0.8, outGain: 0.9, delays: '60', decays: '0.4' } }
      ]);
      expect(filter).toBe('aecho=0.8:0.9:60:0.4');
    });

    it('generates 3-band parametric eq filter', () => {
      const filter = buildAudioDspFilter([
        { id: '5', type: 'eq', params: { bass: 6, mid: -3, treble: 4 } }
      ]);
      expect(filter).toContain('bass=g=6');
      expect(filter).toContain('equalizer=f=1000:t=q:w=1:g=-3');
      expect(filter).toContain('treble=g=4');
    });

    it('chains multiple audio filters with comma separators', () => {
      const filter = buildAudioDspFilter([
        { id: '1', type: 'pitch', params: { semitones: 2, sampleRate: 24000 } },
        { id: '2', type: 'reverb', params: { inGain: 0.8, outGain: 0.9, delays: '50', decays: '0.3' } }
      ]);
      expect(filter).toContain('asetrate=');
      expect(filter).toContain(',aecho=0.8:0.9:50:0.3');
    });
  });

  describe('buildVideoFxFilter', () => {
    it('generates speed ramp setpts filter', () => {
      const filter = buildVideoFxFilter([
        { id: '1', type: 'speed_ramp', params: { speed: 2.0 } }
      ]);
      expect(filter).toBe('setpts=0.5000*PTS');
    });

    it('generates color grading LUT filter', () => {
      const filter = buildVideoFxFilter([
        { id: '2', type: 'lut', params: { contrast: 1.3, brightness: 0.05, saturation: 1.2 } }
      ]);
      expect(filter).toBe('eq=contrast=1.3:brightness=0.05:saturation=1.2');
    });

    it('generates zoompan Ken Burns filter', () => {
      const filter = buildVideoFxFilter([
        { id: '3', type: 'zoompan', params: { zoomRate: 0.002, maxZoom: 1.3, frames: 100 } }
      ]);
      expect(filter).toContain('zoompan=z=\'min(zoom+0.002,1.3)\':d=100:s=1280x720');
    });

    it('generates glitch noise filter', () => {
      const filter = buildVideoFxFilter([
        { id: '4', type: 'glitch', params: { noise: 30 } }
      ]);
      expect(filter).toBe('noise=alls=30:allf=t+u');
    });
  });

  describe('normalizeOrRandomizeEffect (Prioritize user input / fallback to random)', () => {
    it('preserves valid user input if provided', () => {
      const userInput = {
        type: 'pitch' as const,
        params: { semitones: 5 }
      };
      const result = normalizeOrRandomizeEffect(userInput, 'vocal');
      expect(result.wasRandomized).toBe(false);
      expect(result.effect.type).toBe('pitch');
      expect(result.effect.params.semitones).toBe(5);
    });

    it('randomizes parameters when user provides empty params', () => {
      const userInput = {
        type: 'pitch' as const,
        params: {}
      };
      const result = normalizeOrRandomizeEffect(userInput, 'vocal');
      expect(result.wasRandomized).toBe(true);
      expect(result.effect.type).toBe('pitch');
      expect(typeof result.effect.params.semitones).toBe('number');
      expect(result.effect.params.semitones).not.toBe(0);
    });

    it('randomizes type and params when user provides completely invalid effect', () => {
      const resultAudio = normalizeOrRandomizeEffect({ type: 'unknown_type' }, 'bgm');
      expect(resultAudio.wasRandomized).toBe(true);
      expect(AUDIO_EFFECT_TYPES).toContain(resultAudio.effect.type);

      const resultVideo = normalizeOrRandomizeEffect(null, 'video');
      expect(resultVideo.wasRandomized).toBe(true);
      expect(VIDEO_EFFECT_TYPES).toContain(resultVideo.effect.type);
    });
  });

  describe('Movie Tool apply_effect & undo_effect with user abstraction', () => {
    it('applies effect, hides internal path history, and supports undo', async () => {
      const store = new TimelineManifestStore(TEST_DIR);
      await store.init('proj_dsp', 'session_dsp');
      const artifact = await store.addArtifact({
        track: 'bgm',
        start_ms: 0,
        end_ms: 10000,
        name: 'bgm_theme',
        label: 'BGM Theme',
        engine: 'musicgen',
        model: 'medium',
        artifact_path: path.join(TEST_DIR, 'dummy.wav'),
        status: 'approved',
        metadata: {},
        proposed_by: 'director'
      });

      // Apply first effect (without rendering ffmpeg by setting remix: false)
      const applyRes1 = await runMovieTool({
        action: 'apply_effect',
        projectId: 'proj_dsp',
        projectDir: TEST_DIR,
        artifactId: artifact.artifactId,
        remix: false,
        effect: {
          id: 'eff_1',
          type: 'tempo',
          params: { factor: 1.2 }
        }
      });

      expect(applyRes1.success).toBe(true);
      expect(applyRes1.data.effect.type).toBe('tempo');
      expect(applyRes1.data.canUndo).toBe(true);
      // Verify internal plumbing is abstracted away
      expect(applyRes1.data.artifact._original_path).toBeUndefined();
      expect(applyRes1.data.artifact._path_history).toBeUndefined();
      expect(applyRes1.data.artifact.effects).toHaveLength(1);

      // Apply second effect
      const applyRes2 = await runMovieTool({
        action: 'apply_effect',
        projectId: 'proj_dsp',
        projectDir: TEST_DIR,
        artifactId: artifact.artifactId,
        remix: false,
        effect: {
          id: 'eff_2',
          type: 'reverb',
          params: { inGain: 0.8, outGain: 0.9, delays: '50', decays: '0.3' }
        }
      });

      expect(applyRes2.success).toBe(true);
      expect(applyRes2.data.artifact.effects).toHaveLength(2);

      // Undo last effect
      const undoRes1 = await runMovieTool({
        action: 'undo_effect',
        projectId: 'proj_dsp',
        projectDir: TEST_DIR,
        artifactId: artifact.artifactId
      });

      expect(undoRes1.success).toBe(true);
      expect(undoRes1.data.undoneEffect.type).toBe('reverb');
      expect(undoRes1.data.remainingEffects).toHaveLength(1);
      expect(undoRes1.data.remainingEffects[0].type).toBe('tempo');
      expect(undoRes1.data.canUndo).toBe(true);
      // Abstraction check
      expect(undoRes1.data.artifact._original_path).toBeUndefined();
      expect(undoRes1.data.artifact._path_history).toBeUndefined();

      // Undo another effect
      const undoRes2 = await runMovieTool({
        action: 'undo_effect',
        projectId: 'proj_dsp',
        projectDir: TEST_DIR,
        artifactId: artifact.artifactId
      });
      expect(undoRes2.success).toBe(true);
      expect(undoRes2.data.undoneEffect.type).toBe('tempo');
      expect(undoRes2.data.remainingEffects).toHaveLength(0);
      expect(undoRes2.data.canUndo).toBe(false);

      // Attempting undo with no effects left returns error
      const undoRes3 = await runMovieTool({
        action: 'undo_effect',
        projectId: 'proj_dsp',
        projectDir: TEST_DIR,
        artifactId: artifact.artifactId
      });
      expect(undoRes3.success).toBe(false);
      expect(undoRes3.error).toContain('No effects to undo');
    });
  });
});
