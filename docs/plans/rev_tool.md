# reverse_tool and movie_tool extensions: revised plan (v2)

Status: revision of the original plan, which is kept unchanged as `rev_tool.v1-original.md`.
Every change below is backed by the web and arXiv research recorded in `v1.1.2-research-papers.md`;
the defects found in the original are listed in `v1.1.2-fixes.md` (section "Research findings").

Target release: v1.1.2, developed as small branches off `v1.1.2`.

## 0. Ground rules

1. **Memory budget:** peak GPU memory <= 6 GB VRAM, and every feature has a CPU-only fallback. A feature that cannot meet this ships disabled, behind an explicit opt-in.
2. **Licences:** prefer MIT, Apache-2.0 and BSD for code and weights. Weights that are non-commercial, research-only or gated are never bundled or downloaded silently; the user opts in after seeing the licence text. Every model download records its licence in the manifest.
3. **Honesty:** no tool returns a number it did not compute. When a backend is missing, the answer is `not_available` with the reason, never a placeholder.
4. **Authorization:** analysis of third-party artifacts requires `authorization: 'ctf' | 'lab' | 'consent'`, the same framing `cyber_tool run_action` already uses.
5. **No evasion work:** nothing in this plan bypasses bot protection, DRM or access controls.
6. **Measure before claiming:** published VRAM figures are rare. No document claims a memory number until it has been measured on a 6 GB card; until then it is labelled an estimate.

## 1. Scope decisions (what changed from v1)

| v1 proposal | Decision | Reason |
|---|---|---|
| Proxy to `rea-agents` with invented tool names | **Keep, redesigned** (section 2) | package is real, but tool names, evidence terms and handshake in v1 were wrong |
| `scan_github` via `new GithubRepoScanner({token}).scan()` | **Replace** with `GithubRepoClient.understand()` (exists since 24d88e4) | the v1 API does not exist; the client already returns manifests, dependencies, skills and MCP files |
| Demucs separation + HPSS + spectral gating inside `reverse_tool` | **Move to `movie_tool`** as `separate_stems` / `smooth_stems`, Demucs-only, HPSS dropped | belongs with the media pipeline; HPSS API unconfirmed |
| Hand-written GGUF parser | **Replace** with the official `gguf` package | v1 parser had wrong type sizes and array handling |
| `reverse_training_data` returning fixed numbers | **Remove**; add `probe_memorization` | fabricated output; real metrics are defensible and cheap |
| AnyAngle / TripoSplat / Qwen-Image-2.1 pipeline | **Defer**; ship depth-based pseudo-3D parallax instead | exceeds 6 GB and CPU limits; Qwen Research License is not commercial-safe |
| `layer extraction` of quantized tensors to safetensors | **Keep for float tensors; dequantize with a label for quantized** | safetensors has no block-quant dtype |

## 2. reverse_tool: REA proxy

### Contract

```
runReverseTool({ action, target, authorization, options })
```

Actions (v1.1.2 first release): `status`, `list_capabilities`, `analyze_artifact`, `analyze_javascript`, `get_evidence`, `scan_github`, `inspect_gguf`, `probe_memorization`.
`analyze_binary` and `analyze_website` follow once the proxy is proven. `extract_layer` and `analyze_layer` land with `inspect_gguf` (section 4).

### Proxy design (corrections from research)

- **Install:** pin an exact `rea-agents` version, installed once into a private directory from a committed lockfile with `npm ci --ignore-scripts`, then run its `mcp` entry directly. No `@latest`, no per-call `npx`. Verify `npm view rea-agents@<ver> scripts dependencies dist.integrity` before pinning. Requires Node >= 22.19 (not 23 or 25); `status` reports unsupported Node versions.
- **Handshake:** `initialize` (protocol version, empty capabilities, client info), wait for the response, send `notifications/initialized`, then `tools/list`. Per-request timeouts with `notifications/cancelled`.
- **Tool discovery:** call `tools/list` at runtime and allowlist from the result. Do not hardcode tool names. Candidate read-only names seen in the docs: `inspect_artifact`, `analyze_javascript_application`, `binary_overview`, `get_evidence_bundle`, `list_unknowns`.
- **Session:** one long-lived MCP session per target, because retained evidence references are only valid on the same connection.
- **Caps and shutdown:** own timeout and output cap (REA's response limit is `REA_MCP_MAX_RESPONSE_BYTES`; the 4 MiB figure in v1 applies only to its updater commands). Shutdown order: close stdin, wait, SIGTERM, SIGKILL; on Windows `taskkill /pid N /T /F`, on Unix a detached process group.
- **Never expose** `rea setup` (rewrites agent configs) or `rea mcp --http` (no auth or TLS).
- **First provider:** `analyze-javascript-application <abs path> --json`, which needs no native engine. Native providers (Ghidra, Hopper, IDA) are discovered by REA itself and reported by `list_capabilities`.

### Evidence output

Use REA's real fields instead of the v1 terms: `evidence_id`, `normalized_result`, `analysis_profile`, `coverage` (`scope`, `status: complete | unknown`), `limitations`, and the `list_unknowns` ledger. Preserve `_meta.provenance.untrusted_content`. Every result the tool returns carries `{source, sha256, tool, trusted: false}`.

### Threat model (applies to every action)

- All engine output is hostile data: strip control, zero-width and bidi characters, cap string lengths, flag long base64. Delimiters are a hint, not a control.
- Allowlist tools per task; read-only by default. Mutating, execution, network and file-write tools need human approval through the harness policy.
- Pin tool schemas by hash; tool output can never change tool descriptions.
- Never execute analysed samples. Engine runs with no network, read-only, unprivileged, CPU/RAM/time limits, no environment secrets, no host mounts.
- Path confinement: canonicalize into the configured workspace, do not follow symlinks.
- Do not chain untrusted output into egress tools. Log every call with provenance.

## 3. GitHub inventory

`scan_github` is a thin action over `GithubRepoClient.understand(owner, repo)` and `PackageRegistryClient.enrich`: repository metadata, default branch, manifests, dependencies with registry descriptions, skills count, MCP files, README install and usage blocks. It already reports `rate_limited` and `could_not_verify` honestly. Added work: optional `GITHUB_TOKEN` (host-scoped, never logged), a short TTL cache, and release-asset discovery (`.asar`, ELF/PE/Mach-O, `.gguf`, firmware) that feeds `analyze_artifact` as candidate targets. Discovery only lists assets; downloading one needs explicit user approval and a size cap.

## 4. Model introspection (GGUF) and memorization probing

### inspect_gguf / extract_layer / analyze_layer

- Use the official `gguf` Python package (MIT) in a thin subprocess script; no hand-rolled parser.
- Path safety: resolve inside an allowlisted models root, `.gguf` suffix plus magic check, size and tensor-count caps, output only to a fixed directory with sanitized names (tensor names may contain `/` or `..`).
- `extract_layer`: float tensors (F32, F16, BF16) are written bit-exact; quantized tensors are dequantized and the safetensors metadata says `dequantized: true` plus the original quant type. Large tensors are capped or processed by rows.
- `analyze_layer`: chunked statistics over memory-mapped slices in float64 (count, mean, std, zero fraction with a stated threshold, NaN/Inf counts, Frobenius norm). Spectral fits are not offered for quantized tensors.

### probe_memorization (replaces reverse_training_data)

- **Inputs:** a local GGUF model and user-supplied candidate texts, plus an optional control set of non-members.
- **Metrics:** per-text NLL and perplexity, Min-k% (k = 20), Min-k%++ (needs full logits), zlib ratio, optional reference-model ratio, and an exact-suffix match test only when the true continuation is supplied.
- **Memory:** Q4_K_M GGUF 3B-7B (about 2-4.4 GB, estimate), `n_ctx` <= 1024, CPU fallback, reference model loaded only after the target is freed.
- **Refusals:** fewer than about 200 members and 200 non-members matched on length and domain yields `insufficient_data`. Scores are never compared across quantizations. No "memorized" probability is returned unless calibrated on a labelled set.
- **Required caveat in every response:** "Scores indicate relative likelihood only. They are not proof of training membership. Published results show near-chance AUC (<0.6) on single-epoch pretrained LLMs once distribution shift is controlled."
- Gated by `authorization: 'consent'` plus `options.explicitConsentAck: true`.

## 5. movie_tool extensions

These extend `src/tools/media/` following the existing router conventions (`audio-router.ts`, `video-router.ts`, `types.ts`, `timeline-manifest.ts`), not a new top-level tool.

### 5.1 Audio stems: `separate_stems`, `smooth_stems`

- Engine: `htdemucs` (code MIT; weights licence to be confirmed from the model card, shown at install), pinned version, `-d cpu` or GPU, `--segment 7 --overlap 0.1`, `-j 1` on CPU. Long inputs are split into 30-60 s outer windows to bound RAM. CPU time is about 1.5x the track duration, so timeouts start at 15 minutes.
- Cache: key = sha256(file bytes) + model + version + flags; write to a temporary directory then atomic rename; a hit requires all expected stem files; concurrent identical requests share one run.
- Smoothing: `noisereduce` (MIT), non-stationary, `prop_decrease` 0.6-0.8, chunked. HPSS is dropped until the librosa API and a quality benefit are confirmed. The v1 spectral-gating formula is removed because it is not what `noisereduce` implements.
- Subprocess rules: arguments array, `shell: false`, input path validated and absolute, minimal environment (`TORCH_HOME`, `PATH`), output caps, input duration cap, resolve executables explicitly on Windows.
- Consent: the caller attests ownership or a licence for the audio; stems are derivative works; processing is local only.

### 5.2 Pseudo-3D camera moves: `animate_still`

Turns one image into N frames (24-120) along a camera path (pan, dolly, zoom, small orbit up to about 15-20 degrees).

1. Depth Anything V2 **Small** (Apache-2.0) at 518 px or lower, once per image.
2. Foreground mask with MobileSAM (or BiRefNet small), long side capped at 1024.
3. Split into 8-32 depth layers; fill disocclusions once (OpenCV Telea first, LaMa optional).
4. Render each frame by warping the cached layers, which is CPU-cheap; stream frames to disk or ffmpeg rather than holding them.
5. Optional: render every Nth keyframe and interpolate with RIFE, or FILM at 720p (4.5 GB peak, reported).
6. Assemble with an LGPL ffmpeg build or the user's system ffmpeg.

Camera schema (backend-agnostic, kept from v1): azimuth, elevation, distance, fov, pan, roll, plus a duration and frame count. Output is labelled "pseudo-3D parallax". Depth Anything V2 Base and Large (CC-BY-NC) are never downloaded by default.

Opt-in only, never default: AnyAngle / Qwen-Image-2.1 (needs a GPU above 6 GB( we can use quantized versions like `abenzerps/Qwen-Image-2.1-Uncensored-Quantized` loaded locally ollama via hf or other smaller models on permission from user, suggestion via llmfit ), Qwen Research License, bleeding-edge diffusers). Refused: video-diffusion models, Flash3D, Splatter Image, MINE, Marigold, Stable Virtual Camera.

## 5.3 Ai presenter workflow validation

ref: execute_skill and 'lanshu-create-ai-presenter-video' skill load as plugin and run with the `movie_tool` extensions. The skill is not bundled; it is a reference for the user to validate the workflow. The skill's README and Quickstart are updated to show the new `movie_tool` actions.

## 6. Test strategy (TDD, red first)

- **Unit, mocked:** proxy handshake order, timeout and cancellation, tool allowlist from a fake `tools/list`, output cap, provenance tagging; GGUF script against tiny generated fixtures (F32 and a quantized tensor); metric functions against hand-computed values; path-safety table (traversal, symlink, wrong suffix, oversize).
- **Contract:** every action enum in the MCP schema has a handler, a playground option and a Quickstart row (the pre-commit action check enforces this).
- **Subprocess:** fake child that emits partial lines, oversize output and hangs; assert tree-kill on each platform path.
- **Integration (opt-in, skipped in CI):** real `rea-agents` pinned version on a tiny JS bundle; real Demucs on a 5-second clip; real depth model on one image. Each records peak RSS and, when available, peak VRAM so the budget claims become measured.
- **Security:** injection strings in analysed output cannot change the tool list or trigger an approval-required tool.

## 7. Phases and branches

All branches are cut from `v1.1.2`, merged back when green, one concern each.

| Phase | Branch | Content |
|---|---|---|
| 0 | `fix/cyber-test-home-isolation` | done: `getMcpHome()`, ChatLogger, session id sanitizer |
| 1 | `feat/reverse-proxy-core` | proxy (handshake, caps, tree-kill), `status`, `list_capabilities`, threat-model tests |
| 2 | `feat/reverse-artifact-js` | `analyze_javascript`, `analyze_artifact`, evidence passthrough, provenance |
| 3 | `feat/reverse-github-assets` | `scan_github` over the existing client, token support, release-asset listing |
| 4 | `feat/reverse-gguf` | `inspect_gguf`, `extract_layer`, `analyze_layer` |
| 5 | `feat/reverse-probe-memorization` | `probe_memorization`, metric tests, refusal rules |
| 6 | `feat/movie-stems` | `separate_stems`, `smooth_stems`, cache, subprocess hardening |
| 7 | `feat/movie-animate-still` | `animate_still` (depth, mask, layers, warp, interpolation, ffmpeg) |
| 8 | `feat/reverse-native-providers` | `analyze_binary` / `analyze_website` once phases 1-3 are stable |
| 9 | `feat/harness-and-agent-validation` | agent harness tool run capability validation and ai agents integration support reterospection to follow up the agent thoughts properly without computational overhead[eg, passing thoughts during subtask keyword trigger or plan artifact review+coding agents setup(not execution, rather tasks.md allignment) via the coding_agents, antigravity one already added] (claude,antigravity,opencode etc). Coding agents with a collapsible dag memory would be a good option for this setup. |
| 10 | `feat/validate-subtool-schema` | in the frontend dashboard the subtools have different schema requirements based on which the other inputs could be hidden, which needs to be handled in the UI. Also tools and subtool workflows should be properly docuumented in the 'mcp-server/docs' outside of the 'skills/' |

Each phase updates `src/mcp/index.ts`, the dashboard playground and Quickstart, and `docs/skill/references/`, because the pre-commit check now fails when an action is missing from the frontend.

## 8. Risks

| Risk | Mitigation |
|---|---|
| `rea-agents` is new, fast-moving and has heavy dependencies | exact pin, lockfile with integrity, `--ignore-scripts`, update only by deliberate PR |
| Prompt injection through analysed content | threat-model section 2; allowlist is the main control |
| Model weights with unclear or non-commercial licences | licence shown and recorded at download; non-commercial weights need opt-in |
| Unmeasured VRAM claims | label as estimates; add measured peak-memory records to the opt-in integration tests |
| Windows process-tree orphaning | `taskkill /T /F` path with a dedicated test |
| Users read probe scores as proof | mandatory caveat, `insufficient_data` refusals, no probabilities without calibration |
| Copyrighted audio or images processed unlawfully | ownership attestation, local-only processing, no bundled samples |

## 9. Open questions for the maintainer

1. Pin which `rea-agents` version first, and is a private install directory acceptable for the server package?
2. Should `separate_stems` and `animate_still` ship in v1.1.2, or wait for v1.2 after measurements on a 6 GB card?
3. Is a quantized-tensor dequantize-and-label export acceptable, or should `extract_layer` refuse quantized tensors entirely?
4. Which model-licence policy applies: block non-commercial weights outright, or allow with an explicit opt-in?
