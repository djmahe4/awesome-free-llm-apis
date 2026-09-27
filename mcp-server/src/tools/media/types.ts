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
}

export interface TimelineManifest {
  projectId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  tracks: Record<string, TimelineArtifact[]>;
  totalDuration_ms: number;
}
