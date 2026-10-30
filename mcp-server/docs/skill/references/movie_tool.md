# `movie_tool` [v1.1.1]

**Purpose:** Autonomous multi-lane timeline manifest media compiler and Vibe Movie Engine. Manages multi-modal media asset generation across audio, speech/TTS, video, music, lyrics, story, and SEO metadata with reversible timeline mutations and effect stacks.

**Input** (the schema in `src/mcp/index.ts` is the source of truth):
```typescript
interface MovieToolInput {
  action: 'init_project' | 'get_timeline' | 'propose_slots' | 'add_artifact' | 'approve_artifact' | 'reroll_artifact'
        | 'generate_assets' | 'generate_story' | 'update_artifact_bounds' | 'apply_effect' | 'undo_effect' | 'compile_timeline';
  projectId?: string;        // project folder is projects/<projectId> unless projectDir is given
  projectDir?: string;
  sessionId?: string;        // stored in the project manifest (init_project)
  premise?: string;          // story premise or scene description
  prompt?: string;           // generation prompt (generate_assets, generate_story)
  track?: 'video' | 'vfx' | 'bgm' | 'bgm_drums' | 'bgm_bass' | 'bgm_melody' | 'vocal' | 'song' | 'script' | 'dialogue';
  start_ms?: number; end_ms?: number; duration_ms?: number;
  artifactId?: string; label?: string; name?: string; artifact_path?: string;
  engine?: string; model?: string; effect?: string; remix?: boolean; allowOverlap?: boolean;
  metadata?: Record<string, any>;   // width, height, emotion, tempo_bpm, voice, tone, scene, characters
}
```

**What each action needs** (errors come back as `{ success: false, error }`; each requirement below is checked against the handler source by `tests/dashboard-showfor-hypotheses.test.ts`, and the dashboard playground shows only the inputs of the chosen action):

| action | required | optional |
|---|---|---|
| `init_project` | `projectId`, `premise` | `sessionId` |
| `get_timeline` | none | none |
| `propose_slots` | `premise` | `duration_ms` (default 15000), `track` |
| `add_artifact` | `track`, `start_ms`, `end_ms` | `name`, `label`, `allowOverlap`, `engine`, `model`, `artifact_path`, `metadata` |
| `update_artifact_bounds` | `artifactId`, `start_ms`, `end_ms` | none |
| `approve_artifact` | `artifactId` | none |
| `reroll_artifact` | `artifactId` | none |
| `generate_assets` | `track`, `prompt` | `engine`, `model`, `apiKey`, `hfToken`, `duration_ms`, `metadata`, `artifact_path` |
| `generate_story` | `premise` or `prompt` | `model`, `apiKey`, `metadata` |
| `apply_effect` | `artifactId` | `effect` (a random one is used when missing or invalid), `track`, `remix` |
| `undo_effect` | `artifactId` | `remix` |
| `compile_timeline` | none up front; errors if no video clip has an `artifact_path` or ffmpeg is missing | none |

**Output:** `{ success: boolean, error?: string, ... }` plus an action-specific payload (the project manifest, the artifact, or the compiled file path).

---

### Timeline Manifest Architecture (`src/tools/media/timeline-manifest.ts`)
- **JSON Schema Strict Validation**: Every clip has an isolated track index, timestamp window (`startTime`, `duration`), asset URI, and reversible `effects[]` stack.
- **Transactional History & Reversible Undos**: Correlates `_path_history` to `effectId` and preserves `_original_path` to prevent destroying valid clip remixes during dry-runs or failed undos.
- **Audio DSP Router**: Chains `atempo` and pitch filters smoothly for extreme audio adjustments without distortion.

---

### Multi-Lane Media Routers (`src/tools/media/`)
1. **Audio / TTS Router (`audio-router.ts`)**:
   - Routes speech synthesis to **Kokoro ONNX** (local/serverless) and **Pollinations TTS**.
   - Supports voice customization, language codes, and speed controls.
2. **Video Generation Router (`video-router.ts`)**:
   - Dispatches prompts to text-to-video models: **Wan-2.2**, **CogVideoX**, and **LTX-Video**.
   - Handles aspect ratio (`16:9`, `9:16`) and motion duration frames.
3. **Music & Instruments Router (`music-router.ts`)**:
   - Generates background scores and ambient soundscapes via **MusicGen** and **Lyria**.
4. **Lyrics & Story Router (`lyrics-router.ts`, `story-router.ts`)**:
   - Generates rhyming song verses and scene scripts tailored to emotional arcs.
5. **SEO & Metadata Router (`seo-router.ts`)**:
   - Generates YouTube/TikTok/Reels titles, descriptions, hashtags, and SRT subtitle timings.

---

### Registered Providers & Model Isolation
- **AionLabs**: Creative storytelling and roleplaying provider (`aion-3.5`, `aion-3.0`, `aion-rp-llama-3.1-8b`).
- **Pollinations**: Media generation endpoints for audio, images, and video.
- **Roleplaying Model Isolation**: Strictly prevents creative RP models from leaking into general coding, planning, or reasoning pipelines.
