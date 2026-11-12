# Deep Research Report: Object-Aware Augmentation via Boundary-Aware Segmentation and 2.5D/3D Parallax Transforms

**Target System:** `awesome-free-llm-apis` — `reverse_tool` & `movie_tool` Learning Engine
**References:**
- `docs/plans/rev_tool.md` (§0 Ground Rules, §5.2 `animate_still`, §7 Phases 6-7)
- `docs/plans/rev_tool.v1-original.md` (Semantic Entity Extraction, SlimSAM, Depth Anything V2)
- Academic Foundations: Depth Anything V2 (Yang et al., 2024), Segment Anything in High Quality (HQ-SAM, 2023), 3D Photography using Context-aware Layered Depth Inpainting (Shih et al., IEEE CVPR).

---

## Executive Summary

While global kernel transformations (min-pooling, max-pooling, Gaussian smoothing, and Laplacian edge filtering implemented in Task 1) demonstrate fundamental convolutional signal properties, applying them monolithically across an entire image degrades semantic boundaries:
1. **Edge Bleeding:** Background texture bleeds into salient foreground subjects during pooling and smoothing operations.
2. **Rubber-Sheet Smearing:** Warping an image using a single monolithic depth map stretches foreground boundaries across distant background pixels, causing severe tearing ("flying pixel artifacts").

This report is a design proposal, not a measured or fully implemented pipeline. Current code uses local Depth Anything V2 Small only when `DEPTH_ANYTHING_MODEL_PATH` is configured, OpenCV GrabCut for explicit-bbox masking, and a depth-guided inverse warp. Model inference is CPU-only today. Missing weights return `not_available`; heuristic depth requires explicit opt-in. No 6 GB VRAM, 100% CPU fallback, or reconstruction-quality guarantee is claimed.

---

## 1. Problem Formulation: Global vs. Object-Aware Augmentations

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Monolithic 2D Pipeline                          │
│                                                                        │
│  Input Image ────► [Global Min/Max Pooling] ────► Blurred Boundaries   │
│              ────► [Monolithic Depth Warp]  ────► Edge Smearing/Tearing│
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                     Object-Aware 3D Pipeline                           │
│                                                                        │
│  Input Image ──┬──► [SlimSAM/MobileSAM] ──► Alpha Matte M_fg           │
│                ├──► [Depth Anything V2] ──► Depth Field D(x, y)        │
│                │                                                       │
│                ▼                                                       │
│  Layer Decomposition ──► [Foreground Layer + Boundary Band]            │
│                      ──► [Background Inpainting (Telea/LaMa)]          │
│                                                                        │
│                ▼                                                       │
│  Layered Parallax Warp ──► Camera Extrinsics [R | t]                   │
│                        ──► Multi-Plane Homography H_k                  │
│                        ──► Zero-Tear 2.5D/3D Novel View Synthesis      │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1 The Rubber-Sheet Boundary Problem
Relative-depth values are not metric distances. Treating them as a continuous surface can still stretch foreground colors into background pixels during image warping.

### 1.2 The Object-Aware Solution: Layered Depth Representation (LDR)
By segmenting the salient entity into a distinct binary mask $M_{fg}$, the scene is decomposed into:
1. **Foreground Entity Layer ($L_{fg}$):** $I(x, y) \odot M_{fg}(x, y)$ positioned at average depth $\bar{d}_{fg}$.
2. **Disocclusion Inpainted Background Layer ($L_{bg}$):** Synthesizes the hidden texture *behind* the foreground object using fast Telea inpainting or LaMa.
3. **Boundary Alpha Transition ($B_{band}$):** Morphological dilation band $(M_{fg} \oplus K_3) \setminus (M_{fg} \ominus K_3)$ preventing fringe halos.

---

## 2. Technical Component Architecture

### 2.1 Component 1: Lightweight Semantic Segmentation
Candidate shortlist only. No candidate is integrated. Parameter counts, weight sizes, licenses, VRAM, and latency are omitted until verified against exact model revisions and measured locally.

| Candidate | Current status |
|---|---|
| **Zigeng/SlimSAM-uniform** | Not integrated; verify code and weight licenses before use. |
| **MobileSAM** | Not integrated; verify code and weight licenses before use. |
| **BiRefNet-general-lite** | Not integrated; verify code and weight licenses before use. |
| *SAM-2 Large* | Excluded; no license or memory claim made here. |

The current implementation uses a caller-supplied bounding box and OpenCV GrabCut where available. It does not load these segmentation candidates or connect YOLO detections to segmentation.

### 2.2 Component 2: Relative Depth Estimation
`Depth Anything V2 Small` is loaded only from a user-configured local checkpoint. Verify its license against the exact checkpoint revision before deployment.
- **Input:** The image is capped to a 2048-pixel long edge before the Hugging Face image processor applies checkpoint-configured preprocessing. No fixed 518-pixel or 392-pixel input size is guaranteed.
- **Output:** Relative depth is normalized per image using the 1st and 99th percentiles. It is not metric depth and does not represent physical near/far planes.
- **Quantization:** ONNX FP16 / INT8 conversion is not implemented or benchmarked in this project.

### 2.3 Component 3: Disocclusion Inpainting
When the foreground layer translates by $\Delta x = f \cdot \frac{t_x}{Z}$, it reveals background pixels previously obscured.
- **Method A (CPU):** OpenCV Telea is used for filling the selected object footprint. Prior timing figures were unsupported and are withdrawn; measure on representative images.
- **Method B (not implemented):** LaMa remains an optional research candidate. Verify exact weight licence, local-only loading, memory, and quality before integration.

### 2.4 Component 4: Boundary-Aware 2.5D Homography Warping
For each depth plane $k \in \{1, \dots, N\}$, the projective homography $H_k$ mapping source pixel coordinates $(u, v, 1)^T$ to novel camera coordinates $(u', v', 1)^T$ is:

$$H_k = K \left( R - \frac{t \cdot n_k^T}{d_k} \right) K^{-1}$$

Where:
- $K = \begin{bmatrix} f_x & 0 & c_x \\ 0 & f_y & c_y \\ 0 & 0 & 1 \end{bmatrix}$ is the camera intrinsic matrix.
- $R = R_z(\text{roll}) R_y(\text{pan}) R_x(\text{tilt})$ is the 3D rotation matrix.
- $t = [t_x, t_y, t_z]^T$ represents horizontal dolly, vertical crane, and zoom translation.
- $n_k = [0, 0, 1]^T$ is the plane normal vector, and $d_k$ is the quantized depth value.

This is a theoretical plane-warp reference, not the current implementation. Current renderer uses depth-quantized inverse remapping; no FPS claim is made.

---

## 3. Comparative Benchmark: Resource & Compute Budget

No reproducible project measurements or hardware logs are available for these stages. Values previously shown here were unsupported estimates and are withdrawn:

| Stage | Backend / Engine | Peak VRAM | Host RAM | CPU latency | 6 GB GPU latency |
|---|---|---:|---:|---:|---:|
| Segmentation | Local mask backend | Not measured | Not measured | Not measured | Not measured |
| Depth estimation | Depth Anything V2 Small, local checkpoint | Not measured | Not measured | Not measured | Not measured |
| Inpainting | OpenCV Telea | Not measured | Not measured | Not measured | Not measured |
| Warp/composite | NumPy/OpenCV | Not measured | Not measured | Not measured | Not measured |
| End-to-end | Current branch implementation | Not measured | Not measured | Not measured | Not measured |

Do not infer performance or budget compliance from model parameter count or weight-file size. Record hardware, model revision, input dimensions, peak RSS/VRAM, warmup policy, and repeated latency samples before making a budget claim.

### 3.1 Current sample and backend status

- Audio sample `Je pense à toi.m4a`: ffprobe reports AAC, stereo, 44.1 kHz, 295.056 s, 4,775,958 bytes. The configured Python 3.11 script correctly returns `not_available` because no local Demucs `htdemucs` checkpoint is configured. This is not an audio-separation quality benchmark; no stems were generated, so SDR/SIR/SAR or listening evaluation cannot be claimed.
- Depth Anything V2 Small weights are not cached/configured. Default model mode returns `not_available`; the test suite exercises heuristic mode only when explicitly requested. No ML-depth latency/VRAM or object reconstruction quality was measured.
- Base64 previews are presentation data, not evaluation evidence. Output PNG/WAV/GIF artifacts must be persisted and inspected; audio quality needs a real separation run and an objective/listening comparison against the original.

## 4. Retrospective Wiring Plan: Connecting to Existing Codebase

The architecture aligns directly with existing structures in `mcp-server`:

### 4.1 Integration with YOLO Detection / Pose (`torch_nn_engine.py`)
A caller-supplied object bounding box can be connected to an object mask. No YOLO-to-segmentation integration is currently implemented; no domain-specific preset is assumed.

### 4.2 Current ML Studio Dashboard wiring

The depth panel uploads a caller-selected image through `/api/upload`, then invokes `reverse_tool` action `run_depth_parallax`. It renders the returned preview and displays the persisted output path. Default mode requires local Depth Anything V2 Small weights. Heuristic depth is a separate, unchecked opt-in. Audio dispatch requires an ownership/licence attestation and consumes persisted WAV stem paths; it does not synthesize previews.

---

## 5. Summary & Actionable Recommendations

1. **Keep 2D Kernel Augmentations Fast & Independent:** Task 1 (`scene_augmentation.py`) serves as the foundational educational lab for linear spatial convolutions (pooling, smoothing, sharpening).
2. **Layer Object-Awareness on Top:** Rather than replacing Task 1, object-aware augmentation and 3D parallax represent the natural progression into multi-modal spatial reasoning (Phase 7 in `rev_tool.md`).
3. **Hardware claim:** None. Measure the selected local model, image size, and render path on target hardware before asserting VRAM, RAM, latency, or compatibility.
