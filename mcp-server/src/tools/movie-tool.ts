import path from 'node:path';
import { TimelineManifestStore } from './media/timeline-manifest.js';
import { buildKeyframeUrl, requestKeyframe, generateMotionClip } from './media/video-router.js';
import { buildMusicPrompt, generateBgm } from './media/music-router.js';
import { formatLyricsPrompt } from './media/lyrics-router.js';
import { buildSeoPrompt } from './media/seo-router.js';
import { synthesizeSpeechLocal } from './media/audio-router.js';
import { generateStoryScript } from './media/story-router.js';
import type { TrackLane } from './media/types.js';

export interface MovieToolInput {
  action:
    | 'init_project'
    | 'propose_slots'
    | 'add_artifact'
    | 'approve_artifact'
    | 'reroll_artifact'
    | 'generate_assets'
    | 'generate_story'
    | 'compile_timeline'
    | 'get_timeline';
  projectId?: string;
  premise?: string;
  sessionId?: string;
  projectDir?: string;
  track?: TrackLane;
  duration_ms?: number;
  artifactId?: string;
  start_ms?: number;
  end_ms?: number;
  label?: string;
  engine?: string;
  model?: string;
  artifact_path?: string;
  name?: string;
  allowOverlap?: boolean;
  prompt?: string;
  metadata?: Record<string, any>;
  apiKey?: string;
  hfToken?: string;
}

export interface MovieToolOutput {
  success: boolean;
  data?: any;
  error?: string;
}

export async function runMovieTool(input: MovieToolInput): Promise<MovieToolOutput> {
  const projectDir = input.projectDir || path.resolve(process.cwd(), 'projects', input.projectId || 'default');
  const store = new TimelineManifestStore(projectDir);

  switch (input.action) {
    case 'init_project': {
      if (!input.projectId || !input.premise) {
        return { success: false, error: 'projectId and premise required for init_project' };
      }
      try {
        const manifest = await store.init(input.projectId, input.sessionId || 'session_default');
        return { success: true, data: manifest };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'approve_artifact': {
      if (!input.artifactId) {
        return { success: false, error: 'artifactId required for approve_artifact' };
      }
      try {
        await store.approveArtifact(input.artifactId);
        return { success: true, data: { approved: true, artifactId: input.artifactId } };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'generate_assets': {
      if (!input.track) {
        return { success: false, error: 'track required for generate_assets' };
      }
      if (!input.prompt) {
        return { success: false, error: 'prompt required for generate_assets' };
      }
      try {
        if (input.track === 'video') {
          const url = buildKeyframeUrl({
            prompt: input.prompt,
            model: (input.model as any) || undefined,
            width: input.metadata?.width,
            height: input.metadata?.height,
            apiKey: input.apiKey || process.env.POLLINATIONS_API_KEY
          });
          return { success: true, data: { type: 'keyframe_url', url } };
        } else if (input.track === 'bgm') {
          const musicPrompt = buildMusicPrompt({
            emotion: input.metadata?.emotion || 'cinematic',
            tempo_bpm: input.metadata?.tempo_bpm || 120,
            duration_s: Math.round((input.duration_ms || 30000) / 1000)
          });
          const bgmPath = await generateBgm(musicPrompt, 'musicgen', input.hfToken || process.env.HF_TOKEN);
          return { success: true, data: { type: 'bgm_path', path: bgmPath } };
        } else if (input.track === 'vocal') {
          const out = input.artifact_path || path.join(projectDir, `vocal_${Date.now()}.wav`);
          const speechPath = await synthesizeSpeechLocal({
            text: input.prompt,
            voice: input.metadata?.voice,
            outputPath: out
          });
          return { success: true, data: { type: 'vocal_path', path: speechPath } };
        } else if (input.track === 'script' || input.track === 'dialogue') {
          const script = await generateStoryScript({
            premise: input.prompt,
            tone: input.metadata?.tone,
            scene: input.metadata?.scene,
            characters: input.metadata?.characters,
            model: input.model,
            apiKey: input.apiKey
          });
          return { success: true, data: { type: 'story_script', script } };
        }
        return { success: false, error: `Direct generation for track ${input.track} not yet supported` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'generate_story': {
      if (!input.prompt && !input.premise) {
        return { success: false, error: 'premise or prompt required for generate_story' };
      }
      try {
        const script = await generateStoryScript({
          premise: (input.premise || input.prompt)!,
          tone: input.metadata?.tone,
          scene: input.metadata?.scene,
          characters: input.metadata?.characters,
          model: input.model,
          apiKey: input.apiKey
        });
        return { success: true, data: { script } };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'get_timeline': {
      try {
        const manifest = await store.load();
        return { success: true, data: manifest };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'add_artifact': {
      if (!input.track || input.start_ms === undefined || input.end_ms === undefined) {
        return { success: false, error: 'track, start_ms, and end_ms required for add_artifact' };
      }
      try {
        const artifact = await store.addArtifact({
          track: input.track,
          start_ms: input.start_ms,
          end_ms: input.end_ms,
          name: input.name,
          allowOverlap: input.allowOverlap,
          label: input.label || 'Artifact',
          engine: input.engine || 'default',
          model: input.model || 'default',
          artifact_path: input.artifact_path || '',
          status: 'pending',
          metadata: input.metadata || {},
          proposed_by: 'user'
        });
        return { success: true, data: artifact };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    default:
      return { success: false, error: `Action ${input.action} not recognized` };
  }
}
