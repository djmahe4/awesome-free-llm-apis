# `movie_tool` [v1.1.1]

**Purpose:** Autonomous multi-lane timeline manifest media compiler and Vibe Movie Engine. Manages multi-modal media asset generation across audio, speech/TTS, video, music, lyrics, story, and SEO metadata with reversible timeline mutations and effect stacks.

**Input:**
```typescript
interface MovieToolInput {
  action: 'create_timeline' | 'add_clip' | 'remove_clip' | 'apply_effect' | 'render_timeline' | 'undo' | 'get_manifest';
  timelineId?: string;
  manifest?: TimelineManifest;
  params?: {
    prompt?: string;
    mediaType?: 'video' | 'audio' | 'music' | 'tts' | 'image';
    duration?: number;
    startTime?: number;
    provider?: string;
    model?: string;
    aspectRatio?: '16:9' | '9:16' | '1:1';
    voice?: string;
    style?: string;
    tags?: string[];
    effectType?: 'dsp' | 'pitch' | 'tempo' | 'volume' | 'filter' | 'remix';
    effectParams?: Record<string, any>;
    clipId?: string;
    effectId?: string;
  };
  sessionId?: string;
  workspaceRoot?: string;
}
```

**Output:**
```typescript
interface MovieToolResult {
  success: boolean;
  timelineId: string;
  manifest: TimelineManifest;
  actionTaken: string;
  mediaUrl?: string;
  localPath?: string;
  metadata?: Record<string, any>;
  error?: string;
}
```

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
