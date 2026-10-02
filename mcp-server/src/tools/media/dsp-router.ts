import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import type { MediaEffect } from './types.js';

/**
 * Builds FFmpeg audio filter string from an array of MediaEffects.
 * Supported types: pitch, pan, tempo, reverb, eq
 */
/**
 * FFmpeg atempo filter strictly requires values between 0.5 and 2.0.
 * For tempo/pitch compensation outside this range, chain multiple atempo filters.
 */
export function formatAtempoChain(factor: number): string {
  let val = Math.max(0.05, Math.min(20.0, factor));
  const chain: string[] = [];
  while (val > 2.0) {
    chain.push('atempo=2.0');
    val /= 2.0;
  }
  while (val < 0.5) {
    chain.push('atempo=0.5');
    val /= 0.5;
  }
  chain.push(`atempo=${val.toFixed(4)}`);
  return chain.join(',');
}

export function buildAudioDspFilter(effects: MediaEffect[]): string {
  const filters: string[] = [];

  for (const eff of effects) {
    switch (eff.type) {
      case 'pitch': {
        // Pitch shift via asetrate and atempo compensation
        // semitones: +12 = 1 octave up (speed 2x), -12 = 1 octave down (speed 0.5x)
        const semitones = Number(eff.params.semitones ?? eff.params.shift ?? 0);
        if (semitones !== 0) {
          const ratio = Math.pow(2, semitones / 12);
          const sampleRate = Number(eff.params.sampleRate ?? 24000);
          const newRate = Math.round(sampleRate * ratio);
          // asetrate changes pitch and speed; atempo chain restores original speed
          const tempoComp = 1 / ratio;
          filters.push(`asetrate=${newRate},${formatAtempoChain(tempoComp)}`);
        }
        break;
      }

      case 'pan': {
        // Stereo panning: pan value from -1.0 (full left) to +1.0 (full right), 0 = center
        const pan = Math.max(-1, Math.min(1, Number(eff.params.pan ?? 0)));
        const leftGain = (0.5 * (1 - pan)).toFixed(2);
        const rightGain = (0.5 * (1 + pan)).toFixed(2);
        filters.push(`pan=stereo|c0=${leftGain}*c0+${leftGain}*c1|c1=${rightGain}*c0+${rightGain}*c1`);
        break;
      }

      case 'tempo': {
        // Tempo warp without pitch change: speed factor
        const factor = Number(eff.params.factor ?? eff.params.speed ?? 1.0);
        if (!isNaN(factor) && factor !== 1.0) {
          filters.push(formatAtempoChain(factor));
        }
        break;
      }

      case 'reverb': {
        // Reverb/echo simulation using aecho filter
        const inGain = Number(eff.params.inGain ?? 0.8);
        const outGain = Number(eff.params.outGain ?? 0.9);
        const delays = String(eff.params.delays ?? '60');
        const decays = String(eff.params.decays ?? '0.4');
        filters.push(`aecho=${inGain}:${outGain}:${delays}:${decays}`);
        break;
      }

      case 'eq': {
        // 3-band parametric EQ (bass, mid, treble gains in dB)
        const bass = Number(eff.params.bass ?? 0);
        const mid = Number(eff.params.mid ?? 0);
        const treble = Number(eff.params.treble ?? 0);
        if (bass !== 0) filters.push(`bass=g=${bass}`);
        if (mid !== 0) filters.push(`equalizer=f=1000:t=q:w=1:g=${mid}`);
        if (treble !== 0) filters.push(`treble=g=${treble}`);
        break;
      }
    }
  }

  return filters.join(',');
}

/**
 * Builds FFmpeg video filter string from an array of MediaEffects.
 * Supported types: speed_ramp, lut, zoompan, glitch
 */
export function buildVideoFxFilter(effects: MediaEffect[]): string {
  const filters: string[] = [];

  for (const eff of effects) {
    switch (eff.type) {
      case 'speed_ramp': {
        // Video playback speed warp (e.g., 2x fast, 0.5x slowmo)
        const speed = Math.max(0.25, Math.min(4.0, Number(eff.params.speed ?? 1.0)));
        if (speed !== 1.0) {
          filters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
        }
        break;
      }

      case 'lut': {
        // Color grading or basic contrast/brightness adjustment
        const contrast = Number(eff.params.contrast ?? 1.0);
        const brightness = Number(eff.params.brightness ?? 0.0);
        const saturation = Number(eff.params.saturation ?? 1.0);
        filters.push(`eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation}`);
        break;
      }

      case 'zoompan': {
        // Ken burns slow zoom or pan
        const zoomRate = Number(eff.params.zoomRate ?? 0.0015);
        const maxZoom = Number(eff.params.maxZoom ?? 1.25);
        const duration = Number(eff.params.frames ?? 125);
        filters.push(`zoompan=z='min(zoom+${zoomRate},${maxZoom})':d=${duration}:s=1280x720`);
        break;
      }

      case 'glitch': {
        // Chromatic noise and RGB shift
        const noise = Number(eff.params.noise ?? 20);
        filters.push(`noise=alls=${noise}:allf=t+u`);
        break;
      }
    }
  }

  return filters.join(',');
}

/**
 * Applies MediaEffects using local FFmpeg CLI.
 * Returns outputPath on success or original inputPath if no filters/ffmpeg unavailable.
 */
export async function applyMediaEffects(
  inputPath: string,
  outputPath: string,
  effects: MediaEffect[]
): Promise<string> {
  if (!effects || effects.length === 0) return inputPath;

  const audioFilter = buildAudioDspFilter(effects);
  const videoFilter = buildVideoFxFilter(effects);

  if (!audioFilter && !videoFilter) return inputPath;

  if (!fs.existsSync(inputPath)) {
    return inputPath;
  }

  await fs.ensureDir(path.dirname(outputPath));

  return new Promise((resolve, reject) => {
    const args: string[] = ['-y', '-i', inputPath];

    if (videoFilter) {
      args.push('-vf', videoFilter);
    }
    if (audioFilter) {
      args.push('-af', audioFilter);
    }

    args.push(outputPath);

    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        console.error(`[DSP Error] FFmpeg exited with code ${code}: ${stderr.slice(-300)}`);
        reject(new Error(`FFmpeg failed with code ${code}: ${stderr.slice(-200) || 'unknown error'}`));
      }
    });

    proc.on('error', (err) => {
      console.error(`[DSP Error] FFmpeg spawn error: ${err.message}`);
      reject(new Error(`FFmpeg binary not available in PATH: ${err.message}`));
    });
  });
}

export const AUDIO_EFFECT_TYPES: MediaEffect['type'][] = ['pitch', 'pan', 'tempo', 'reverb', 'eq'];
export const VIDEO_EFFECT_TYPES: MediaEffect['type'][] = ['speed_ramp', 'lut', 'zoompan', 'glitch'];

export function getRandomParamForType(type: MediaEffect['type']): Record<string, any> {
  switch (type) {
    case 'pitch': {
      const shifts = [-7, -5, -4, -2, 2, 4, 5, 7];
      const semitones = shifts[Math.floor(Math.random() * shifts.length)];
      return { semitones, sampleRate: 24000 };
    }
    case 'pan': {
      const pans = [-0.75, -0.5, 0.5, 0.75];
      return { pan: pans[Math.floor(Math.random() * pans.length)] };
    }
    case 'tempo': {
      const tempos = [0.85, 0.9, 1.15, 1.25];
      return { factor: tempos[Math.floor(Math.random() * tempos.length)] };
    }
    case 'reverb': {
      return { inGain: 0.8, outGain: 0.9, delays: '60', decays: '0.4' };
    }
    case 'eq': {
      return { bass: 4, mid: -2, treble: 3 };
    }
    case 'speed_ramp': {
      const speeds = [0.75, 1.25, 1.5];
      return { speed: speeds[Math.floor(Math.random() * speeds.length)] };
    }
    case 'lut': {
      return { contrast: 1.2, brightness: 0.05, saturation: 1.3 };
    }
    case 'zoompan': {
      return { zoomRate: 0.002, maxZoom: 1.2, frames: 125 };
    }
    case 'glitch': {
      return { noise: 25 };
    }
    default:
      return {};
  }
}

/**
 * Validates and prioritizes user input for MediaEffect.
 * If user input is missing or invalid, randomizes appropriate edits.
 */
export function normalizeOrRandomizeEffect(
  inputEffect?: any,
  track?: string
): { effect: MediaEffect; wasRandomized: boolean } {
  const isVideoTrack = track === 'video' || track === 'vfx';
  const allowedTypes = isVideoTrack ? VIDEO_EFFECT_TYPES : AUDIO_EFFECT_TYPES;

  let type: MediaEffect['type'] | undefined;
  let params: Record<string, any> = {};
  let wasRandomized = false;

  if (inputEffect && typeof inputEffect === 'object') {
    if (
      typeof inputEffect.type === 'string' &&
      (AUDIO_EFFECT_TYPES.includes(inputEffect.type as any) || VIDEO_EFFECT_TYPES.includes(inputEffect.type as any))
    ) {
      type = inputEffect.type as MediaEffect['type'];
    }
    if (inputEffect.params && typeof inputEffect.params === 'object') {
      params = { ...inputEffect.params };
    }
  }

  // If type invalid or missing, choose a random type appropriate for the track
  if (!type) {
    type = allowedTypes[Math.floor(Math.random() * allowedTypes.length)];
    wasRandomized = true;
  }

  // Validate parameters for chosen type
  let hasValidParams = false;
  switch (type) {
    case 'pitch': {
      const semitones = Number(params.semitones ?? params.shift);
      if (!isNaN(semitones) && semitones !== 0) hasValidParams = true;
      break;
    }
    case 'pan': {
      const pan = Number(params.pan);
      if (!isNaN(pan) && pan >= -1 && pan <= 1) hasValidParams = true;
      break;
    }
    case 'tempo': {
      const factor = Number(params.factor ?? params.speed);
      if (!isNaN(factor) && factor >= 0.5 && factor <= 2.0 && factor !== 1.0) hasValidParams = true;
      break;
    }
    case 'reverb': {
      if (params.delays || params.inGain || params.outGain) hasValidParams = true;
      break;
    }
    case 'eq': {
      const b = Number(params.bass);
      const m = Number(params.mid);
      const t = Number(params.treble);
      if ((!isNaN(b) && b !== 0) || (!isNaN(m) && m !== 0) || (!isNaN(t) && t !== 0)) hasValidParams = true;
      break;
    }
    case 'speed_ramp': {
      const speed = Number(params.speed);
      if (!isNaN(speed) && speed > 0 && speed !== 1.0) hasValidParams = true;
      break;
    }
    case 'lut': {
      if (params.contrast !== undefined || params.brightness !== undefined || params.saturation !== undefined) {
        hasValidParams = true;
      }
      break;
    }
    case 'zoompan': {
      if (params.zoomRate !== undefined || params.maxZoom !== undefined) {
        hasValidParams = true;
      }
      break;
    }
    case 'glitch': {
      const noise = Number(params.noise);
      if (!isNaN(noise) && noise > 0) hasValidParams = true;
      break;
    }
  }

  if (!hasValidParams) {
    params = getRandomParamForType(type);
    wasRandomized = true;
  }

  const id = inputEffect?.id || `eff_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    effect: {
      id,
      type,
      params,
      start_offset_ms: inputEffect?.start_offset_ms,
      duration_ms: inputEffect?.duration_ms
    },
    wasRandomized
  };
}
