# ML Studio Learning Workbench Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the ML Learning Studio (`panel-ml-learning`) from static scratchpads into a fully interactive, educational ML lab featuring pure-NumPy scientific scene augmentations (min/max/avg pooling, Gaussian smoothing, Laplacian sharpening), reverse Vision-Language image synthesis inspired by Qwen2.5-VL feature attribution, real multi-stem audio separation, and interactive OCR token spatial grounding—all built on lightweight, CPU-capable, open-source technology.

**Architecture:** 
- A lightweight Python backend engine tier (`scene_augmentation.py`, `vlm_reverse_generator.py`, `ocr_engine.py`) exposed via `mcp-server/src/tools/reverse-tool.ts` and dispatched via `/api/tools/call`.
- A responsive, educational frontend layer in `mcp-server/dashboard/partials/13b-ml-learning.html` and `mcp-server/dashboard/js/12-ml-learning.js`, featuring interactive side-by-side canvas comparators, kernel heatmaps, interactive bounding overlays, and "What This Teaches" pedagogical modules.
- Strict resource bounds: zero-GPU requirements (100% CPU-compatible via pure NumPy/PIL/Web Audio), zero paid APIs, sub-100ms response targets, commit every 2 features and push.

**Tech Stack:** TypeScript (Node.js/ESM), Python 3.11 (pure NumPy, PIL, SciPy/PyMuPDF), Vitest, HTML5 Canvas, Web Audio API, SVG DAG rendering.

---

## Plan Structure & Commit Rhythm

Commits occur strictly every **2 tasks**, followed immediately by pushing to `origin/feat/ml-studio-learning-workbench`:

- **Wave 1 (Tasks 1 & 2)**: Scene Augmentation & Pooling Kernel Lab -> **Commit 1 & 2 + Push**
- **Wave 2 (Tasks 3 & 4)**: Reverse VLM Image Synthesis & Attribution Studio -> **Commit 3 & 4 + Push**
- **Wave 3 (Tasks 5 & 6)**: Demucs / Spectral Audio Stem Separation Workbench -> **Commit 5 & 6 + Push**
- **Wave 4 (Tasks 7 & 8)**: Interactive OCR Bounding & Token Decision Studio -> **Commit 7 & 8 + Push**

---

### Task 1: Scene Augmentation Engine (Backend & Tool Action)

**Files:**
- Create: `mcp-server/scripts/scene_augmentation.py`
- Modify: `mcp-server/src/tools/reverse-tool.ts:100-120`, `mcp-server/src/tools/reverse-tool.ts:750-810`
- Test: `mcp-server/tests/scene-augmentation.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/scene-augmentation.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('Scene Augmentation & Pooling Engine', () => {
  const framePath = path.resolve(__dirname, 'fixtures/media/frames/frame_0050.jpg');

  it('performs scientific min-pooling transformation on image', async () => {
    const res = await handleReverseTool({
      action: 'augment_scene',
      target: framePath,
      authorization: 'lab',
      options: {
        operation: 'min_pool',
        kernel_size: 3,
        stride: 2,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.operation).toBe('min_pool');
    expect(data.output_shape).toBeDefined();
    expect(data.output_base64).toMatch(/^data:image\/png;base64,/);
    expect(data.metrics.entropy_change).toBeTypeOf('number');
    expect(data.metrics.spatial_variance_ratio).toBeTypeOf('number');
    expect(data.kernel_matrix).toBeDefined();
    expect(data.learning_notes).toContain('Min-pooling');
  });

  it('performs Laplacian edge sharpening transformation', async () => {
    const res = await handleReverseTool({
      action: 'augment_scene',
      target: framePath,
      authorization: 'lab',
      options: {
        operation: 'laplacian_sharpen',
        intensity: 0.8,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.operation).toBe('laplacian_sharpen');
    expect(data.output_base64).toBeDefined();
    expect(data.metrics.gradient_energy).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/scene-augmentation.test.ts`
Expected: FAIL with unrecognized action `augment_scene`.

**Step 3: Implement minimal code to make test pass**

1. Create `mcp-server/scripts/scene_augmentation.py`:
Implement pure NumPy transformations:
- `min_pool(arr, k=3, s=2)`: morphological erosion equivalent simulating minimum receptive field activation.
- `max_pool(arr, k=3, s=2)`: standard CNN max-pooling layer simulation capturing dominant salient features.
- `avg_pool(arr, k=3, s=2)`: spatial downsampling averaging local neighborhood values.
- `gaussian_smooth(arr, sigma=1.5, k=5)`: discrete Gaussian blur kernel modeling low-pass feature filtration.
- `laplacian_sharpen(arr, alpha=0.5)`: high-pass 2nd-order derivative kernel emphasizing edge boundaries.
- `bilateral_approx(arr, radius=3, sigma_color=25.0, sigma_space=2.0)`: edge-preserving smoothing.
- `hist_equalize(arr)`: dynamic contrast stretching across RGB channels.
Compute mathematical metrics:
- Shannon entropy change $\Delta H = H_{out} - H_{in}$
- Spatial variance ratio $\sigma^2_{out} / \sigma^2_{in}$
- Gradient energy $E = \sum |\nabla I|^2$
Encode output to PNG base64 and output JSON.

2. Register `augment_scene` in `mcp-server/src/tools/reverse-tool.ts`:
- Add `'augment_scene'` to `ReverseToolAction` and `isModelAction`.
- Dispatch to `scene_augmentation.py` with arguments `--file`, `--operation`, `--kernel-size`, `--stride`, `--intensity`.

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/scene-augmentation.test.ts`
Expected: PASS (2 tests passed).

**Step 5: Code Check**

Ensure type annotations and clean error handling in `scene_augmentation.py`.

---

### Task 2: Interactive Augmentation & Kernel Lab in ML Studio Frontend

**Files:**
- Modify: `mcp-server/dashboard/partials/13b-ml-learning.html`
- Modify: `mcp-server/dashboard/js/12-ml-learning.js`

**Step 1: Write HTML markup for Augmentation Lab**

In `13b-ml-learning.html`, replace the placeholder in section 7 or add a dedicated "Augmentation Lab" subpanel:
- Preset buttons: `Min-Pooling`, `Max-Pooling`, `Avg-Pooling`, `Gaussian Smooth`, `Laplacian Sharpen`, `Bilateral Smooth`, `Hist Equalization`.
- Interactive Split-Canvas comparator: Left shows original image, right shows augmented result with a draggable vertical divider.
- Kernel Filter Matrix visualizer: 2D numeric grid displaying weights (e.g. $[[0,-1,0], [-1,5,-1], [0,-1,0]]$ for Laplacian).
- Dynamic Metrics HUD: Live readouts of Entropy Change ($\Delta H$), Variance Ratio, and Gradient Energy.
- Pedagogical "What This Teaches" card explaining:
  - How CNNs utilize pooling for translation invariance and downsampling.
  - How sharpening acts as a spatial high-pass filter revealing feature edges.
  - The computational difference between Min-pooling (dark feature preservation) and Max-pooling (bright feature preservation).

**Step 2: Wire JS dispatch & canvas rendering**

In `12-ml-learning.js`:
- Add handler for `#ml-augment-run-btn` that reads the active image path and selected transform.
- Calls `/api/tools/call` with `{ tool: 'reverse_tool', params: { action: 'augment_scene', target: imagePath, authorization: 'lab', options: { operation, kernel_size, stride, intensity } } }`.
- Draws before & after images to the split canvas.
- Renders the interactive divider with mouse/touch drag handlers.
- Updates the kernel matrix grid and metrics badge.

**Step 3: Assemble & Verify Build**

Run:
```bash
npm --prefix mcp-server run assemble:index
npm --prefix mcp-server run build
npm --prefix mcp-server test -- tests/dashboard-index-drift.test.ts
```
Expected: PASS with 0 drift.

**Step 4: Commit & Push Checkpoint 1 (Tasks 1 & 2)**

```bash
git add mcp-server/scripts/scene_augmentation.py mcp-server/src/tools/reverse-tool.ts mcp-server/tests/scene-augmentation.test.ts
git commit -m "feat(ml-studio): add scientific scene augmentation and pooling engine"
git add mcp-server/dashboard/partials/13b-ml-learning.html mcp-server/dashboard/js/12-ml-learning.js mcp-server/dashboard/index.html
git commit -m "feat(ml-studio): add interactive augmentation lab with split-view comparator and kernel visualizer"
git push origin feat/ml-studio-learning-workbench
```

---

### Task 3: Reverse Vision-Language Image Generation Engine (Backend & Tool Action)

**Files:**
- Create: `mcp-server/scripts/vlm_reverse_generator.py`
- Modify: `mcp-server/src/tools/reverse-tool.ts:100-130`, `mcp-server/src/tools/reverse-tool.ts:750-830`
- Test: `mcp-server/tests/vlm-reverse-generator.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/vlm-reverse-generator.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('VLM Reverse Image Synthesis & Attribution Engine', () => {
  it('generates synthetic image from text prompt via reverse feature projection', async () => {
    const res = await handleReverseTool({
      action: 'reverse_vlm_generate',
      target: 'synthetic_vlm_engine',
      authorization: 'lab',
      options: {
        prompt: 'soccer player striking ball into top corner goal',
        mode: 'feature_attribution',
        resolution: 256,
        seed: 42,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.output_base64).toMatch(/^data:image\/png;base64,/);
    expect(data.tokens).toContain('soccer');
    expect(data.token_attributions).toBeDefined();
    expect(data.spatial_patches).toBeDefined();
    expect(Array.isArray(data.latent_energy_map)).toBe(true);
    expect(data.learning_notes).toContain('Vision-Language');
  });

  it('produces class activation prototype map for semantic concepts', async () => {
    const res = await handleReverseTool({
      action: 'reverse_vlm_generate',
      target: 'synthetic_vlm_engine',
      authorization: 'lab',
      options: {
        prompt: 'referee blowing whistle pitch boundary',
        mode: 'prototype_activation',
        resolution: 128,
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.output_base64).toBeDefined();
    expect(data.metrics.peak_saliency).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/vlm-reverse-generator.test.ts`
Expected: FAIL with unrecognized action `reverse_vlm_generate`.

**Step 3: Implement minimal code to make test pass**

1. Create `mcp-server/scripts/vlm_reverse_generator.py`:
- Lightweight, zero-heavy-dependency model inspired by Qwen2.5-VL feature reverse projection:
  - Tokenizer decomposes prompt into semantic tokens (entity, action, location/background).
  - Spatial Patch Grid: $16 \times 16$ or $32 \times 32$ latent patches.
  - Cross-attention synthesis: Maps token embeddings into spatial coordinate Gaussian energy wells (e.g. "player" $\to$ center-left centroid, "ball" $\to$ lower-mid centroid, "goal" $\to$ upper-right centroid).
  - Inverse discrete cosine transform (IDCT) / wave harmonic synthesis generates realistic textured RGB visual representations without multi-gigabyte weights.
  - Computes spatial attention entropy, peak saliency coordinates, and token attribution scores.
- Emits clean JSON with PNG base64, patch activations, and pedagogical breakdown.

2. Register `reverse_vlm_generate` in `mcp-server/src/tools/reverse-tool.ts`:
- Add `'reverse_vlm_generate'` to `ReverseToolAction` and `isModelAction`.
- Route to `vlm_reverse_generator.py`.

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/vlm-reverse-generator.test.ts`
Expected: PASS (2 tests passed).

---

### Task 4: VLM Reverse Generation & Semantic Studio UI in Frontend

**Files:**
- Modify: `mcp-server/dashboard/partials/13b-ml-learning.html`
- Modify: `mcp-server/dashboard/js/12-ml-learning.js`

**Step 1: Write HTML markup for Reverse VLM Studio**

In `13b-ml-learning.html`:
- Replace the static TTS/scratchpad tab with "VLM Reverse Image Synthesis & Attribution Studio".
- Prompt Input bar with preset pills:
  - *"Soccer striker shooting penalty kick toward upper corner"*
  - *"Goalkeeper diving across goal line to save ball"*
  - *"Referee gesturing with yellow card near midfield line"*
- Mode selector: `Feature Attribution Map`, `Class Prototype Synthesis`, `Patch Attention Energy`.
- Two-column visual layout:
  - Left: Synthesized High-Resolution Image Canvas.
  - Right: $16 \times 16$ Interactive Cross-Attention Latent Patch Heatmap with token correlation hover.
- "Send to Augmentation Lab" one-click action button that pipes the generated image directly into Task 2's augmentation pipeline!
- Pedagogical "What This Teaches" card explaining:
  - How modern Vision-Language Models (like Qwen2.5-VL) project textual token vectors into 2D continuous spatial latent space.
  - The inverse problem: generating images from feature activations vs classifying images into tokens.

**Step 2: Wire JS interactions**

In `12-ml-learning.js`:
- Add dispatch handler for `#ml-vlm-generate-btn`.
- Calls `/api/tools/call` with `{ action: 'reverse_vlm_generate', options: { prompt, mode, resolution } }`.
- Renders the synthesized image and cross-attention heatmap on side-by-side canvases.
- Wires the "Send to Augmentation Lab" button to populate the Augmentation Lab's image input and trigger a min/max pool on the generated image.

**Step 3: Assemble & Verify Build**

Run:
```bash
npm --prefix mcp-server run assemble:index
npm --prefix mcp-server run build
npm --prefix mcp-server test -- tests/dashboard-index-drift.test.ts tests/vlm-reverse-generator.test.ts
```
Expected: PASS.

**Step 4: Commit & Push Checkpoint 2 (Tasks 3 & 4)**

```bash
git add mcp-server/scripts/vlm_reverse_generator.py mcp-server/src/tools/reverse-tool.ts mcp-server/tests/vlm-reverse-generator.test.ts
git commit -m "feat(ml-studio): add reverse VLM image generation and semantic attribution engine"
git add mcp-server/dashboard/partials/13b-ml-learning.html mcp-server/dashboard/js/12-ml-learning.js mcp-server/dashboard/index.html
git commit -m "feat(ml-studio): add interactive VLM reverse image synthesis studio with latent patch inspector"
git push origin feat/ml-studio-learning-workbench
```

---

### Task 5: Audio Stem Separation & Spectral Decomposition Engine

**Files:**
- Create: `mcp-server/scripts/audio_separator.py`
- Modify: `mcp-server/src/tools/reverse-tool.ts:100-130`, `mcp-server/src/tools/reverse-tool.ts:750-840`
- Test: `mcp-server/tests/audio-stems.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/audio-stems.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('Audio Stem Separation & Spectral Decomposition Engine', () => {
  const audioSample = path.resolve(__dirname, 'fixtures/media/audio/sample_match_audio.wav');

  it('separates audio into 4 stems with spectral metrics', async () => {
    const res = await handleReverseTool({
      action: 'separate_audio_stems',
      target: audioSample,
      authorization: 'lab',
      options: {
        method: 'spectral_multiband',
        stems: ['vocals', 'drums', 'bass', 'other'],
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(data.stems).toBeDefined();
    expect(data.stems.vocals).toBeDefined();
    expect(data.stems.drums).toBeDefined();
    expect(data.stems.bass).toBeDefined();
    expect(data.stems.other).toBeDefined();
    expect(data.stems.vocals.rms_power).toBeTypeOf('number');
    expect(data.stems.vocals.spectral_centroid).toBeTypeOf('number');
    expect(data.learning_notes).toContain('STFT');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/audio-stems.test.ts`
Expected: FAIL with unrecognized action `separate_audio_stems`.

**Step 3: Implement minimal code to make test pass**

1. Create `mcp-server/scripts/audio_separator.py`:
- Checks if Demucs (`htdemucs`) is available; if yes, uses CPU Demucs inference.
- Provides a fast, deterministic pure-NumPy STFT (Short-Time Fourier Transform) multi-band spectral decomposition fallback:
  - Low band (< 250 Hz) $\to$ Bass stem
  - Mid band (250 Hz - 3.5 kHz) with transient attack detection $\to$ Drums stem
  - Formant frequency band (1 kHz - 4 kHz) with harmonicity ratio $\to$ Vocals stem
  - Residual high/diffuse band $\to$ Other / Ambience stem
- Computes RMS power, spectral centroid, zero-crossing rate, and creates base64 WAV snippets for each stem.
- Returns comprehensive pedagogical learning notes on time-frequency masking.

2. Register `separate_audio_stems` in `mcp-server/src/tools/reverse-tool.ts`:
- Route to `audio_separator.py`.

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/audio-stems.test.ts`
Expected: PASS.

---

### Task 6: Real Demucs 4-Stem Workbench in ML Studio UI

**Files:**
- Modify: `mcp-server/dashboard/partials/13b-ml-learning.html`
- Modify: `mcp-server/dashboard/js/12-ml-learning.js`

**Step 1: Write HTML markup for Demucs 4-Stem Workbench**

In `13b-ml-learning.html`:
- Replace the static scratchpad in `ml-media-preset-demucs`:
  - Real Audio file input / test sample picker.
  - "Separate Stems" dispatch button.
  - 4 interactive stem channels: Vocals, Drums, Bass, Other.
  - Per-stem real-time HTML5 `<canvas>` waveform and frequency spectrum display.
  - Interactive Mute / Solo buttons and gain faders connected to Web Audio API.
  - Live Master Output visualizer.
  - Pedagogical "What This Teaches" card explaining:
    - How complex polyphonic acoustic mixtures are inverted back into constituent sources via masking.
    - U-Net convolutional skip connections across time and frequency dimensions.

**Step 2: Wire JS Web Audio API & dispatch**

In `12-ml-learning.js`:
- Add handler for `#ml-stem-dispatch-btn`.
- Calls `/api/tools/call` with action `separate_audio_stems`.
- Initializes `AudioContext` and loads each stem base64 into an `AudioBufferSourceNode` routed through dedicated `GainNode`s to the master output.
- Renders dynamic oscilloscope waveforms for each stem as audio plays.

**Step 3: Assemble & Verify Build**

Run:
```bash
npm --prefix mcp-server run assemble:index
npm --prefix mcp-server run build
npm --prefix mcp-server test -- tests/dashboard-index-drift.test.ts tests/audio-stems.test.ts
```
Expected: PASS.

**Step 4: Commit & Push Checkpoint 3 (Tasks 5 & 6)**

```bash
git add mcp-server/scripts/audio_separator.py mcp-server/src/tools/reverse-tool.ts mcp-server/tests/audio-stems.test.ts
git commit -m "feat(ml-studio): add multi-band audio stem separation and spectral decomposition engine"
git add mcp-server/dashboard/partials/13b-ml-learning.html mcp-server/dashboard/js/12-ml-learning.js mcp-server/dashboard/index.html
git commit -m "feat(ml-studio): add interactive 4-stem mixer with Web Audio playback and waveform visualizers"
git push origin feat/ml-studio-learning-workbench
```

---

### Task 7: OCR Token Bounding & Layout Inspection Engine

**Files:**
- Create: `mcp-server/scripts/ocr_engine.py`
- Modify: `mcp-server/src/tools/reverse-tool.ts:100-130`, `mcp-server/src/tools/reverse-tool.ts:750-840`
- Test: `mcp-server/tests/ocr-token-inspection.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/ocr-token-inspection.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { handleReverseTool } from '../src/tools/reverse-tool.js';

describe('OCR Token Bounding & Layout Engine', () => {
  const framePath = path.resolve(__dirname, 'fixtures/media/frames/frame_0050.jpg');

  it('detects text tokens and extracts spatial bounding coordinates', async () => {
    const res = await handleReverseTool({
      action: 'inspect_ocr_tokens',
      target: framePath,
      authorization: 'lab',
    });

    expect(res.success).toBe(true);
    const data = res.data as any;
    expect(Array.isArray(data.tokens)).toBe(true);
    expect(data.tokens.length).toBeGreaterThan(0);
    const first = data.tokens[0];
    expect(first.text).toBeTypeOf('string');
    expect(first.bbox).toHaveLength(4); // [x, y, w, h]
    expect(first.confidence).toBeGreaterThanOrEqual(0);
    expect(data.reading_order).toBeDefined();
    expect(data.layout_blocks).toBeDefined();
    expect(data.learning_notes).toContain('Spatial Grounding');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/ocr-token-inspection.test.ts`
Expected: FAIL with unrecognized action `inspect_ocr_tokens`.

**Step 3: Implement minimal code to make test pass**

1. Create `mcp-server/scripts/ocr_engine.py`:
- Uses PyMuPDF (`fitz`) when inspecting PDF/document inputs for exact vector character glyph coordinates.
- Uses OpenCV/NumPy connected component text region detection + lightweight OCR heuristics on image inputs (with optional EasyOCR/Tesseract fallback if available).
- Computes:
  - Token coordinates `[x, y, w, h]` normalized and in pixel space.
  - Confidence scoring based on edge contrast and character aspect ratios.
  - Reading order reconstruction via Top-to-Bottom, Left-to-Right layout clustering.
  - Syntactic token classification (keyword, numeric score, label, entity).
- Emits structured JSON with tokens, layout hierarchy, and educational notes on spatial grounding in multi-modal LLMs.

2. Register `inspect_ocr_tokens` in `mcp-server/src/tools/reverse-tool.ts`:
- Route to `ocr_engine.py`.

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/ocr-token-inspection.test.ts`
Expected: PASS.

---

### Task 8: Interactive OCR Bounding & Token Decision Studio in ML Studio UI

**Files:**
- Modify: `mcp-server/dashboard/partials/13b-ml-learning.html`
- Modify: `mcp-server/dashboard/js/12-ml-learning.js`

**Step 1: Write HTML markup for OCR Decision Studio**

In `13b-ml-learning.html`:
- Replace the static scratchpad in `ml-media-preset-ocr`:
  - Image / document viewport with overlay `<canvas>` for interactive bounding boxes.
  - Token list sidebar displaying all recognized tokens with confidence meters.
  - Hover synchronization: Hovering over a token in the list highlights its box on the image canvas in cyan with coordinate tooltips; hovering over a bounding box on the image highlights the corresponding text row.
  - Layout hierarchy visualization: Color-coded grouping boxes showing paragraph/block groupings.
  - Pedagogical "What This Teaches" card explaining:
    - How Vision-Language Models (DocVQA, LayoutLM, Qwen-VL) fuse 2D bounding coordinates with token embeddings to comprehend documents and natural scenes.
    - The difference between linear 1D language modeling and 2D spatial cross-attention.

**Step 2: Wire JS interactions**

In `12-ml-learning.js`:
- Add dispatch handler for `#ml-ocr-inspect-btn`.
- Calls `/api/tools/call` with action `inspect_ocr_tokens`.
- Draws bounding boxes on the overlay canvas with color-coded confidence levels (green $>0.9$, amber $0.7-0.9$, red $<0.7$).
- Implements two-way hover synchronization between canvas coordinates and DOM list items.

**Step 3: Assemble & Verify Build**

Run:
```bash
npm --prefix mcp-server run assemble:index
npm --prefix mcp-server run build
npm --prefix mcp-server test -- tests/dashboard-index-drift.test.ts tests/ocr-token-inspection.test.ts
```
Expected: PASS.

**Step 4: Commit & Push Checkpoint 4 (Tasks 7 & 8)**

```bash
git add mcp-server/scripts/ocr_engine.py mcp-server/src/tools/reverse-tool.ts mcp-server/tests/ocr-token-inspection.test.ts
git commit -m "feat(ml-studio): add OCR token bounding and spatial layout inspection engine"
git add mcp-server/dashboard/partials/13b-ml-learning.html mcp-server/dashboard/js/12-ml-learning.js mcp-server/dashboard/index.html
git commit -m "feat(ml-studio): add interactive OCR token bounding studio with bidirectional hover grounding"
git push origin feat/ml-studio-learning-workbench
```

---

## Final Verification & Test Matrix

Run all tests across the entire reverse tool and ML studio suite:
```bash
npm --prefix mcp-server test -- \
  tests/dashboard-index-drift.test.ts \
  tests/torch-nn-engine.test.ts \
  tests/reverse-tool-models.test.ts \
  tests/weight-space-programming.test.ts \
  tests/training-reconstruction.test.ts \
  tests/scene-augmentation.test.ts \
  tests/vlm-reverse-generator.test.ts \
  tests/audio-stems.test.ts \
  tests/ocr-token-inspection.test.ts
```
Expected: 100% PASS (9 test files, >46 tests passing).
Verify git log has cleanly paired commits (2 tasks per commit) and remote `origin/feat/ml-studio-learning-workbench` is completely in sync.
