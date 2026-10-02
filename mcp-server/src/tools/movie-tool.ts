import path from 'node:path';
import { TimelineManifestStore } from './media/timeline-manifest.js';
import { buildKeyframeUrl } from './media/video-router.js';
import { buildMusicPrompt, generateBgm } from './media/music-router.js';
import { formatLyricsPrompt } from './media/lyrics-router.js';
import { buildSeoPrompt } from './media/seo-router.js';
import { synthesizeSpeechLocal } from './media/audio-router.js';
import { generateStoryScript } from './media/story-router.js';
import { applyMediaEffects, normalizeOrRandomizeEffect } from './media/dsp-router.js';
import { toPublicArtifact, type TrackLane, type MediaEffect } from './media/types.js';

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
    | 'get_timeline'
    | 'apply_effect'
    | 'undo_effect';
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
  effect?: MediaEffect;
  remix?: boolean;
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

    case 'propose_slots': {
      if (!input.premise) {
        return { success: false, error: 'premise required for propose_slots' };
      }
      try {
        const manifest = await store.load();
        const duration = input.duration_ms || 15000;
        const slotLength = 5000;
        const proposedCount = Math.max(1, Math.floor(duration / slotLength));
        const proposedArtifacts = [];
        for (let i = 0; i < proposedCount; i++) {
          const start_ms = i * slotLength;
          const end_ms = (i + 1) * slotLength;
          const art = await store.addArtifact({
            track: input.track || 'video',
            start_ms,
            end_ms,
            label: `Scene ${i + 1}`,
            name: `slot_${i + 1}`,
            status: 'pending',
            engine: 'wan2.1',
            model: 'flux',
            artifact_path: '',
            metadata: { premise: input.premise, prompt: `Scene ${i + 1}: ${input.premise}` },
            proposed_by: 'director'
          });
          proposedArtifacts.push(toPublicArtifact(art));
        }
        return { success: true, data: { proposedSlots: proposedArtifacts, totalProposed: proposedArtifacts.length } };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'reroll_artifact': {
      if (!input.artifactId) {
        return { success: false, error: 'artifactId required for reroll_artifact' };
      }
      try {
        await store.updateArtifactStatus(input.artifactId, 'generating');
        const manifest = await store.load();
        let target: any;
        for (const lane of Object.values(manifest.tracks)) {
          target = lane.find((a: any) => a.artifactId === input.artifactId);
          if (target) break;
        }
        if (!target) return { success: false, error: 'Artifact not found' };
        return { success: true, data: { rerolled: true, artifact: toPublicArtifact(target) } };
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
        const publicTracks: Record<string, any[]> = {};
        for (const [lane, items] of Object.entries(manifest.tracks)) {
          publicTracks[lane] = items.map(toPublicArtifact);
        }
        return { success: true, data: { ...manifest, tracks: publicTracks } };
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
        return { success: true, data: toPublicArtifact(artifact) };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'apply_effect': {
      if (!input.artifactId) {
        return { success: false, error: 'artifactId required for apply_effect' };
      }
      try {
        const manifest = await store.load();
        let targetTrack: string | undefined;
        for (const artifacts of Object.values(manifest.tracks)) {
          const found = artifacts.find((a) => a.artifactId === input.artifactId);
          if (found) {
            targetTrack = found.track;
            break;
          }
        }

        // Prioritize user effect; if invalid or missing, randomize parameters and/or type
        const { effect: normalizedEffect, wasRandomized } = normalizeOrRandomizeEffect(
          input.effect,
          targetTrack || input.track
        );

        let artifact = await store.addEffectToArtifact(input.artifactId, normalizedEffect);

        if (artifact.artifact_path && input.remix !== false) {
          const sourcePath = artifact._original_path || artifact.artifact_path;
          const ext = path.extname(sourcePath) || '.wav';
          const dir = path.dirname(sourcePath);
          const base = path.basename(sourcePath, ext).replace(/_remix_\d+$/, '');
          const remixedPath = path.join(dir, `${base}_remix_${Date.now()}${ext}`);
          const effectsToApply = artifact.effects && artifact.effects.length > 0 ? artifact.effects : [normalizedEffect];
          const resultPath = await applyMediaEffects(sourcePath, remixedPath, effectsToApply);
          if (resultPath !== artifact.artifact_path) {
            artifact = await store.recordArtifactRemixPath(artifact.artifactId, resultPath, normalizedEffect.id);
          }
        }

        return {
          success: true,
          data: {
            artifact: toPublicArtifact(artifact),
            effect: normalizedEffect,
            wasRandomized,
            canUndo: (artifact.effects?.length || 0) > 0
          }
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'compile_timeline': {
      try {
        const manifest = await store.load();
        const outputVideo = path.join(projectDir, `compiled_${manifest.projectId}_${Date.now()}.mp4`);
        const allArtifacts = Object.values(manifest.tracks).flat();
        return {
          success: true,
          data: {
            projectId: manifest.projectId,
            totalDuration_ms: manifest.totalDuration_ms,
            artifactCount: allArtifacts.length,
            compiledPath: outputVideo,
            status: 'compiled'
          }
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    case 'undo_effect': {
      if (!input.artifactId) {
        return { success: false, error: 'artifactId required for undo_effect' };
      }
      try {
        let { artifact, undoneEffect } = await store.undoLastEffect(input.artifactId);
        if (artifact._original_path && input.remix !== false) {
          if (artifact.effects && artifact.effects.length > 0) {
            const ext = path.extname(artifact._original_path) || '.wav';
            const dir = path.dirname(artifact._original_path);
            const base = path.basename(artifact._original_path, ext).replace(/_remix_\d+$/, '');
            const remixedPath = path.join(dir, `${base}_remix_${Date.now()}${ext}`);
            const resultPath = await applyMediaEffects(artifact._original_path, remixedPath, artifact.effects);
            if (resultPath !== artifact.artifact_path) {
              artifact = await store.recordArtifactRemixPath(artifact.artifactId, resultPath);
            }
          }
        }
        return {
          success: true,
          data: {
            artifact: toPublicArtifact(artifact),
            undoneEffect,
            remainingEffects: artifact.effects || [],
            canUndo: (artifact.effects?.length || 0) > 0
          }
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    default:
      return { success: false, error: `Action ${input.action} not recognized` };
  }
}
