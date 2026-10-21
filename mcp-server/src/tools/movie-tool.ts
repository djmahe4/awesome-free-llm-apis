import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import fetch from 'node-fetch';
import { TimelineManifestStore } from './media/timeline-manifest.js';
import { buildKeyframeUrl, generateMotionClip, type MotionEngine } from './media/video-router.js';
import { buildMusicPrompt, generateBgm } from './media/music-router.js';
import { formatLyricsPrompt } from './media/lyrics-router.js';
import { buildSeoPrompt } from './media/seo-router.js';
import { synthesizeSpeechLocal } from './media/audio-router.js';
import { generateStoryScript } from './media/story-router.js';
import { applyMediaEffects, normalizeOrRandomizeEffect } from './media/dsp-router.js';
import { toPublicArtifact, type TrackLane, type MediaEffect } from './media/types.js';
import { pathParamWithinRoots, resolvePathWithinRoots, relativeSegmentError } from '../utils/workspace-roots.js';

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
    | 'update_artifact_bounds'
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
  const artifactPathGuard = pathParamWithinRoots(input.artifact_path, 'artifact_path');
  if (artifactPathGuard) {
    return { success: false, error: artifactPathGuard };
  }
  const projectDirGuard = pathParamWithinRoots(input.projectDir, 'projectDir');
  if (projectDirGuard) {
    return { success: false, error: projectDirGuard };
  }
  const projectIdGuard = relativeSegmentError(input.projectId, 'projectId');
  if (projectIdGuard) {
    return { success: false, error: projectIdGuard };
  }
  const rawProjectDir = input.projectDir || path.resolve(process.cwd(), 'projects', input.projectId || 'default');
  const projectDir = resolvePathWithinRoots(rawProjectDir);
  if (!projectDir) {
    return { success: false, error: 'projectDir is outside the allowed roots (WORKSPACE_ROOTS)' };
  }
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
          // With an engine (wan2.2, wan2.1, ltx, …) the video track renders a real
          // motion clip via Pollinations/HF; without one it stays a keyframe image URL.
          if (input.engine) {
            const engine = input.engine as MotionEngine;
            let keyframePath = '';
            if (engine !== 'wan2.2') {
              // Image-to-video spaces need a local keyframe file to upload.
              const kfUrl = buildKeyframeUrl({
                prompt: input.prompt,
                model: (input.model as any) || undefined,
                apiKey: input.apiKey || process.env.POLLINATIONS_API_KEY
              });
              keyframePath = path.join(projectDir, `keyframe_${Date.now()}.png`);
              await downloadMedia(kfUrl, keyframePath);
            }
            const raw = await generateMotionClip(keyframePath, input.prompt, engine, input.hfToken || process.env.HF_TOKEN);
            const motionUrl = typeof raw === 'string' ? raw : (raw as any)?.url;
            if (!motionUrl || !/^https?:\/\//.test(motionUrl)) {
              return { success: false, error: `motion engine ${engine} returned no video URL: ${String(motionUrl).slice(0, 200)}` };
            }
            const dest = path.join(projectDir, `motion_${Date.now()}.mp4`);
            const bytes = await downloadMedia(motionUrl, dest);
            return {
              success: true,
              data: { type: 'motion_path', engine, path: dest, bytes, duration_s: Math.round((input.duration_ms || 5000) / 1000) }
            };
          }
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

    case 'update_artifact_bounds': {
      if (!input.artifactId || input.start_ms === undefined || input.end_ms === undefined) {
        return { success: false, error: 'artifactId, start_ms, and end_ms required for update_artifact_bounds' };
      }
      try {
        const updated = await store.updateArtifactBounds(input.artifactId, input.start_ms, input.end_ms);
        return { success: true, data: toPublicArtifact(updated) };
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
        const allArtifacts = Object.values(manifest.tracks).flat();
        const clips = (manifest.tracks.video || [])
          .filter((a: any) => typeof a.artifact_path === 'string' && a.artifact_path.trim().length > 0 && a.end_ms > a.start_ms)
          .sort((a: any, b: any) => a.start_ms - b.start_ms);
        if (clips.length === 0) {
          return { success: false, error: 'compile_timeline: no video-track clips with an artifact_path (add_artifact first)' };
        }
        const ffmpeg = resolveFfmpeg();
        if (!ffmpeg) {
          return { success: false, error: 'compile_timeline: ffmpeg not found — install ffmpeg or set FFMPEG_PATH in .env' };
        }
        await fsp.mkdir(projectDir, { recursive: true });
        const skipped: string[] = [];
        const inputs: { file: string; ms: number; loop: boolean; tmp?: string }[] = [];
        for (const clip of clips) {
          const resolved = resolvePathWithinRoots(clip.artifact_path);
          if (!resolved || !fs.existsSync(resolved)) {
            skipped.push(`${clip.label || clip.artifactId}: missing file ${clip.artifact_path}`);
            continue;
          }
          const ms = clip.end_ms - clip.start_ms;
          const ext = path.extname(resolved).toLowerCase();
          if (ext === '.pdf') {
            const png = rasterizePdfPage(resolved, projectDir);
            if (!png) {
              skipped.push(`${clip.label || clip.artifactId}: PDF rasterization unavailable (ImageMagick/gs not found)`);
              continue;
            }
            inputs.push({ file: png, ms, loop: true, tmp: png });
          } else if (FFMPEG_IMAGE_EXTS.has(ext)) {
            inputs.push({ file: resolved, ms, loop: true });
          } else if (FFMPEG_VIDEO_EXTS.has(ext)) {
            inputs.push({ file: resolved, ms, loop: false });
          } else {
            skipped.push(`${clip.label || clip.artifactId}: unsupported media type '${ext}'`);
          }
        }
        if (inputs.length === 0) {
          return { success: false, error: `compile_timeline: nothing renderable — ${skipped.join('; ')}` };
        }
        const outputVideo = path.join(projectDir, `compiled_${manifest.projectId}_${Date.now()}.mp4`);
        const args = ['-y'];
        for (const inp of inputs) {
          if (inp.loop) args.push('-loop', '1');
          args.push('-t', (inp.ms / 1000).toFixed(3), '-i', inp.file);
        }
        const vf = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=12';
        const filterParts = inputs.map((_, i) => `[${i}:v]${vf}[v${i}]`);
        filterParts.push(`${inputs.map((_, i) => `[v${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0[v]`);
        args.push(
          '-filter_complex', filterParts.join(';'),
          '-map', '[v]', '-an',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
          outputVideo
        );
        const { code, out } = await runFfmpeg(ffmpeg, args);
        for (const inp of inputs) {
          if (inp.tmp) await fsp.rm(inp.tmp, { force: true }).catch(() => {});
        }
        if (code !== 0 || !fs.existsSync(outputVideo) || fs.statSync(outputVideo).size === 0) {
          return { success: false, error: `compile_timeline: ffmpeg failed (exit ${code}): ${out.slice(-600)}` };
        }
        const renderedDuration_ms = inputs.reduce((sum, i) => sum + i.ms, 0);
        return {
          success: true,
          data: {
            projectId: manifest.projectId,
            totalDuration_ms: manifest.totalDuration_ms,
            artifactCount: allArtifacts.length,
            renderedClips: inputs.length,
            renderedDuration_ms,
            skipped,
            compiledPath: outputVideo,
            status: 'compiled',
            written: true
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

const FFMPEG_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const FFMPEG_VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv']);

/** Locate ffmpeg: FFMPEG_PATH env override first, then PATH probe. */
function resolveFfmpeg(): string | null {
  const custom = process.env.FFMPEG_PATH?.trim();
  if (custom) {
    try {
      fs.accessSync(custom, fs.constants.X_OK);
      return custom;
    } catch {
      /* fall through to PATH */
    }
  }
  try {
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000 }).status === 0) return 'ffmpeg';
  } catch {
    /* not installed */
  }
  return null;
}

/** Rasterize the first PDF page to PNG via ImageMagick (magick/convert). Returns null when unavailable. */
function rasterizePdfPage(pdfPath: string, outDir: string): string | null {
  const out = path.join(outDir, `pdfpage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  const tools = [process.env.MAGICK_PATH?.trim(), 'magick', 'convert'].filter(Boolean) as string[];
  for (const tool of tools) {
    try {
      const r = spawnSync(tool, ['-density', '96', `${pdfPath}[0]`, out], { stdio: 'ignore', timeout: 30_000 });
      if (r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 512) return out;
    } catch {
      /* try next tool */
    }
  }
  return null;
}

/** Run ffmpeg with a hard timeout; resolves { code, out } (out capped at ~120KB). */
function runFfmpeg(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (code: number) => {
      if (!settled) {
        settled = true;
        resolve({ code, out });
      }
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, out: String(err) });
      return;
    }
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      finish(-2);
    }, 120_000);
    const cap = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 120_000) out = out.slice(-60_000);
    };
    proc.stdout?.on('data', cap);
    proc.stderr?.on('data', cap);
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ code: -1, out: String(err) });
    });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      finish(code ?? -1);
    });
  });
}

/** Download a remote media URL to dest (180s cap). Returns byte length. */
async function downloadMedia(url: string, dest: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(url, { signal: controller.signal as any });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      let detail = body;
      try {
        const parsed = JSON.parse(body);
        detail = parsed?.error?.message || parsed?.error || body;
      } catch { /* keep raw body */ }
      throw new Error(`media fetch failed (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
    }
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`media fetch returned an error payload: ${body}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) throw new Error(`media fetch returned only ${buf.length} bytes`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    return buf.length;
  } finally {
    clearTimeout(timer);
  }
}
