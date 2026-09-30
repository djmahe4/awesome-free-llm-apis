export type TrackLane =
  | 'video'
  | 'vfx'
  | 'bgm'
  | 'bgm_drums'
  | 'bgm_bass'
  | 'bgm_melody'
  | 'vocal'
  | 'song'
  | 'script'
  | 'dialogue'
  | (string & {});

export type ArtifactStatus = 'pending' | 'generating' | 'generated' | 'approved' | 'rejected';

export interface MediaEffect {
  id: string;
  type:
    | 'pitch'
    | 'pan'
    | 'tempo'
    | 'reverb'
    | 'eq'
    | 'speed_ramp'
    | 'lut'
    | 'zoompan'
    | 'glitch';
  params: Record<string, any>;
  start_offset_ms?: number;
  duration_ms?: number;
}

export interface TimelineArtifact {
  artifactId: string;
  name: string;              // Unique identifier/name within the project (e.g., 'scene_1_intro_vfx_v2')
  track: TrackLane;
  start_ms: number;
  end_ms: number;
  label: string;             // Human-readable display label
  engine: string;
  model: string;
  artifact_path: string;
  status: ArtifactStatus;
  metadata: Record<string, any>;
  proposed_by: 'director' | 'user';
  approved_at?: number;
  allowOverlap?: boolean;    // When true, allows layer blending/stacking on the same track
  effects?: MediaEffect[];   // Stacked DSP audio/video remix plugins
  _original_path?: string;   // Internal: Base media path before any DSP effects applied
  _path_history?: Array<string | PathHistoryEntry>;  // Internal: History of artifact_paths for undo support
}

export interface PathHistoryEntry {
  effectId?: string;
  path: string;
}

/**
 * Returns a clean, user-facing representation of the artifact with internal plumbing abstracted away.
 */
export function toPublicArtifact(artifact: TimelineArtifact): Omit<TimelineArtifact, '_original_path' | '_path_history'> {
  const { _original_path, _path_history, ...publicArtifact } = artifact;
  return publicArtifact;
}

export interface TimelineManifest {
  projectId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  tracks: Record<string, TimelineArtifact[]>;
  totalDuration_ms: number;
}
