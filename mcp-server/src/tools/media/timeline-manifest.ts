import fs from 'fs-extra';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TimelineManifest, TimelineArtifact, TrackLane, ArtifactStatus, MediaEffect } from './types.js';

export class TimelineManifestStore {
  private manifestPath: string;

  constructor(private projectDir: string) {
    this.manifestPath = path.join(projectDir, 'timeline_manifest.json');
  }

  public async init(projectId: string, sessionId: string): Promise<TimelineManifest> {
    const manifest: TimelineManifest = {
      projectId,
      sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tracks: {
        video: [],
        vfx: [],
        bgm: [],
        bgm_drums: [],
        bgm_bass: [],
        bgm_melody: [],
        vocal: [],
        song: []
      },
      totalDuration_ms: 0
    };
    await fs.ensureDir(this.projectDir);
    await fs.writeJSON(this.manifestPath, manifest, { spaces: 2 });
    return manifest;
  }

  public async load(): Promise<TimelineManifest> {
    if (!await fs.pathExists(this.manifestPath)) {
      throw new Error(`Manifest not found at ${this.manifestPath}`);
    }
    return fs.readJSON(this.manifestPath);
  }

  /**
   * Generates a collision-free artifact name within the project.
   * If custom name provided (e.g. "intro_vfx"), ensures uniqueness by appending "_v2", "_v3" if taken.
   */
  private resolveUniqueName(manifest: TimelineManifest, requestedName?: string, track: string = 'layer'): string {
    const existingNames = new Set<string>();
    for (const lane of Object.values(manifest.tracks)) {
      for (const a of lane) {
        if (a.name) existingNames.add(a.name.toLowerCase());
      }
    }

    const baseName = (requestedName || `${track}_artifact`)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');

    if (!existingNames.has(baseName)) {
      return baseName;
    }

    let version = 2;
    while (existingNames.has(`${baseName}_v${version}`)) {
      version++;
    }
    return `${baseName}_v${version}`;
  }

  private deconflict(lane: TimelineArtifact[], start_ms: number, end_ms: number): { start_ms: number; end_ms: number } {
    const duration = end_ms - start_ms;
    const sorted = [...lane].sort((a, b) => a.start_ms - b.start_ms);
    let s = start_ms;
    for (const a of sorted) {
      if (s < a.end_ms && s + duration > a.start_ms) {
        s = a.end_ms;
      }
    }
    return { start_ms: s, end_ms: s + duration };
  }

  public async addArtifact(
    input: Omit<TimelineArtifact, 'artifactId' | 'name'> & {
      start_ms: number;
      end_ms: number;
      name?: string;
    }
  ): Promise<TimelineArtifact> {
    const manifest = await this.load();
    if (!manifest.tracks[input.track]) {
      manifest.tracks[input.track] = [];
    }
    const lane = manifest.tracks[input.track];

    // Check if intentional layer overlap is enabled (e.g. VFX blending, multi-layer audio)
    let finalStart = input.start_ms;
    let finalEnd = input.end_ms;
    if (!input.allowOverlap) {
      const deconf = this.deconflict(lane, input.start_ms, input.end_ms);
      finalStart = deconf.start_ms;
      finalEnd = deconf.end_ms;
    }

    const uniqueName = this.resolveUniqueName(manifest, input.name, input.track);

    const artifact: TimelineArtifact = {
      ...input,
      artifactId: randomUUID(),
      name: uniqueName,
      start_ms: finalStart,
      end_ms: finalEnd
    };

    lane.push(artifact);
    manifest.tracks[input.track] = lane;
    manifest.updatedAt = Date.now();

    let maxDuration = 0;
    for (const trackArtifacts of Object.values(manifest.tracks)) {
      for (const a of trackArtifacts) {
        if (a.end_ms > maxDuration) {
          maxDuration = a.end_ms;
        }
      }
    }
    manifest.totalDuration_ms = maxDuration;

    await fs.writeJSON(this.manifestPath, manifest, { spaces: 2 });
    return artifact;
  }

  public async updateArtifactStatus(
    artifactId: string,
    status: ArtifactStatus,
    artifactPath?: string
  ): Promise<void> {
    const manifest = await this.load();
    let found = false;
    for (const lane of Object.values(manifest.tracks)) {
      const a = lane.find((x) => x.artifactId === artifactId);
      if (a) {
        a.status = status;
        if (artifactPath) a.artifact_path = artifactPath;
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`Artifact ${artifactId} not found in manifest`);
    }
    manifest.updatedAt = Date.now();
    await fs.writeJSON(this.manifestPath, manifest, { spaces: 2 });
  }

  public async updateArtifactBounds(
    artifactId: string,
    start_ms: number,
    end_ms: number
  ): Promise<TimelineArtifact> {
    const manifest = await this.load();
    let target: TimelineArtifact | undefined;
    for (const lane of Object.values(manifest.tracks)) {
      const a = lane.find((x) => x.artifactId === artifactId);
      if (a) {
        a.start_ms = start_ms;
        a.end_ms = end_ms;
        target = a;
        break;
      }
    }
    if (!target) {
      throw new Error(`Artifact ${artifactId} not found in manifest`);
    }

    let maxDuration = 0;
    for (const trackArtifacts of Object.values(manifest.tracks)) {
      for (const a of trackArtifacts) {
        if (a.end_ms > maxDuration) {
          maxDuration = a.end_ms;
        }
      }
    }
    manifest.totalDuration_ms = maxDuration;
    manifest.updatedAt = Date.now();
    await fs.writeJSON(this.manifestPath, manifest, { spaces: 2 });
    return target;
  }

  public async approveArtifact(artifactId: string): Promise<void> {
    const manifest = await this.load();
    let found = false;
    for (const lane of Object.values(manifest.tracks)) {
      const a = lane.find((x) => x.artifactId === artifactId);
      if (a) {
        a.status = 'approved';
        a.approved_at = Date.now();
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`Artifact ${artifactId} not found in manifest`);
    }
    manifest.updatedAt = Date.now();
    await fs.writeJSON(this.manifestPath, manifest, { spaces: 2 });
  }

  public async addEffectToArtifact(artifactId: string, effect: MediaEffect): Promise<TimelineArtifact> {
    const manifest = await this.load();
    let target: TimelineArtifact | undefined;

    for (const lane of Object.values(manifest.tracks)) {
      const a = lane.find((x) => x.artifactId === artifactId);
      if (a) {
        target = a;
        break;
      }
    }

    if (!target) {
      throw new Error(`Artifact ${artifactId} not found in manifest`);
    }

    if (!target.effects) {
      target.effects = [];
    }
    if (!target._original_path && target.artifact_path) {
      target._original_path = target.artifact_path;
    }
    if (!target._path_history) {
      target._path_history = target.artifact_path ? [{ effectId: 'initial', path: target.artifact_path }] : [];
    }

    target.effects.push(effect);
    manifest.updatedAt = Date.now();
    await fs.writeJSON(this.manifestPath, manifest, { spaces: 2 });
    return target;
  }

  public async recordArtifactRemixPath(artifactId: string, newPath: string, effectId?: string): Promise<TimelineArtifact> {
    const manifest = await this.load();
    let target: TimelineArtifact | undefined;

    for (const lane of Object.values(manifest.tracks)) {
      const a = lane.find((x) => x.artifactId === artifactId);
      if (a) {
        target = a;
        break;
      }
    }

    if (!target) {
      throw new Error(`Artifact ${artifactId} not found in manifest`);
    }

    if (!target._original_path && target.artifact_path) {
      target._original_path = target.artifact_path;
    }
    if (!target._path_history) {
      target._path_history = target._original_path ? [{ effectId: 'initial', path: target._original_path }] : [];
    }

    target.artifact_path = newPath;
    target._path_history.push({ effectId, path: newPath });
    manifest.updatedAt = Date.now();
    await fs.writeJSON(this.manifestPath, manifest, { spaces: 2 });
    return target;
  }

  public async undoLastEffect(artifactId: string): Promise<{ artifact: TimelineArtifact; undoneEffect: MediaEffect }> {
    const manifest = await this.load();
    let target: TimelineArtifact | undefined;

    for (const lane of Object.values(manifest.tracks)) {
      const a = lane.find((x) => x.artifactId === artifactId);
      if (a) {
        target = a;
        break;
      }
    }

    if (!target) {
      throw new Error(`Artifact ${artifactId} not found in manifest`);
    }

    if (!target.effects || target.effects.length === 0) {
      throw new Error(`No effects to undo on artifact ${artifactId}`);
    }

    const undoneEffect = target.effects.pop()!;

    // Revert path history internally only if this specific effect recorded a remix path
    if (target._path_history && target._path_history.length > 0) {
      const lastEntry = target._path_history[target._path_history.length - 1];
      const lastEffectId = typeof lastEntry === 'object' && lastEntry !== null ? lastEntry.effectId : undefined;

      // Only pop path history if the top entry belongs to this undone effect
      if (lastEffectId === undoneEffect.id) {
        target._path_history.pop();
        const prev = target._path_history[target._path_history.length - 1];
        if (prev) {
          target.artifact_path = typeof prev === 'string' ? prev : prev.path;
        } else if (target._original_path) {
          target.artifact_path = target._original_path;
        }
      }
    }

    if (target.effects.length === 0 && target._original_path) {
      target.artifact_path = target._original_path;
      if (target._path_history) {
        target._path_history = [{ effectId: 'initial', path: target._original_path }];
      }
    }

    manifest.updatedAt = Date.now();
    await fs.writeJSON(this.manifestPath, manifest, { spaces: 2 });
    return { artifact: target, undoneEffect };
  }
}
