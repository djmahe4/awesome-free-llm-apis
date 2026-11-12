#!/usr/bin/env python3
"""VLM Reverse Image Synthesis & Attribution Engine.

A lightweight, zero-heavy-dependency model inspired by Qwen2.5-VL feature
reverse projection:

  1. A lexicon-driven tokenizer decomposes the prompt into semantic tokens
     (entity / action / object / structure / location / color categories).
  2. Each token embedding is projected into a 2D spatial latent energy well
     (category-specific centroid + Gaussian spread), forming a cross-attention
     patch grid (16x16 or 32x32 depending on resolution).
  3. Image synthesis runs the inverse path: harmonic superposition modulated
     by the latent energy map (an IDCT-flavored construction) produces a
     textured RGB image without any multi-gigabyte weights.
  4. Spatial attention entropy, peak saliency coordinates and per-token
     attribution scores are reported alongside the rendered PNG (base64).

Usage:
  python vlm_reverse_generator.py reverse_generate --prompt "..." \
      [--mode feature_attribution|prototype_activation|patch_attention_energy] \
      [--resolution 256] [--seed 42]
"""

import argparse
import base64
import io
import json
import math
import os
import sys
import time
import zlib

try:
    import numpy as np
except ImportError:
    sys.stderr.write("Error: NumPy is required for vlm_reverse_generator.py\n")
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("Error: Pillow is required for vlm_reverse_generator.py\n")
    sys.exit(1)

MODES = (
    "feature_attribution",
    "prototype_activation",
    "patch_attention_energy",
)

# token -> (category, centroid_u, centroid_v)  u/v in [0, 1]
LEXICON = {
    "player": ("entity", 0.35, 0.55),
    "striker": ("entity", 0.35, 0.52),
    "forward": ("entity", 0.4, 0.55),
    "soccer": ("sport", 0.5, 0.6),
    "football": ("sport", 0.5, 0.6),
    "striking": ("action", 0.42, 0.5),
    "shoot": ("action", 0.45, 0.48),
    "shooting": ("action", 0.45, 0.48),
    "kick": ("action", 0.48, 0.6),
    "ball": ("object", 0.5, 0.72),
    "goal": ("structure", 0.78, 0.3),
    "goalkeeper": ("entity", 0.75, 0.45),
    "diving": ("action", 0.72, 0.5),
    "save": ("action", 0.75, 0.42),
    "saving": ("action", 0.75, 0.42),
    "referee": ("entity", 0.3, 0.5),
    "gesturing": ("action", 0.3, 0.46),
    "blowing": ("action", 0.3, 0.42),
    "whistle": ("object", 0.28, 0.4),
    "card": ("object", 0.32, 0.46),
    "pitch": ("location", 0.5, 0.6),
    "boundary": ("location", 0.62, 0.35),
    "midfield": ("location", 0.5, 0.55),
    "line": ("structure", 0.6, 0.62),
    "corner": ("location", 0.86, 0.55),
    "penalty": ("event", 0.55, 0.5),
    "top": ("direction", 0.6, 0.25),
    "upper": ("direction", 0.6, 0.25),
    "yellow": ("color", 0.4, 0.5),
}

CATEGORY_SIGMA = {
    "entity": 0.09,
    "action": 0.12,
    "object": 0.07,
    "structure": 0.10,
    "location": 0.22,
    "event": 0.14,
    "direction": 0.18,
    "color": 0.25,
    "descriptor": 0.15,
    "sport": 0.16,
}
CATEGORY_AMP = {
    "entity": 1.0,
    "action": 0.8,
    "object": 0.9,
    "structure": 0.85,
    "location": 0.35,
    "event": 0.75,
    "direction": 0.3,
    "color": 0.3,
    "descriptor": 0.25,
    "sport": 0.5,
}
# category -> base RGB tint (0-255)
CATEGORY_COLOR = {
    "entity": (40, 200, 220),
    "action": (255, 150, 40),
    "object": (230, 70, 160),
    "structure": (70, 220, 90),
    "location": (60, 60, 255),
    "event": (255, 220, 60),
    "direction": (140, 140, 255),
    "color": (220, 220, 80),
    "descriptor": (150, 160, 170),
    "sport": (120, 255, 160),
}


def _token_rng(token, seed):
    """Deterministic per-token RNG derived from the token text itself."""
    h = zlib.crc32(token.encode("utf-8")) + (seed or 0)
    return np.random.default_rng(h & 0xFFFFFFFF)


def tokenize(prompt):
    """Lexicon-driven semantic tokenizer."""
    words = [w for w in prompt.lower().replace("-", " ").split() if any(c.isalpha() for c in w)]
    tokens = []
    for w in words:
        w = "".join(ch for ch in w if ch.isalnum())
        if not w:
            continue
        cat = LEXICON[w][0] if w in LEXICON else "descriptor"
        tokens.append((w, cat))
    return tokens


def well_info(token, category, token_index, seed):
    """Well parameters: (centroid_u, centroid_v, sigma, amp, category)."""
    rng = _token_rng(token, seed)
    if token in LEXICON:
        cat, cu, cv = LEXICON[token]
        cu += rng.uniform(-0.05, 0.05)
        cv += rng.uniform(-0.05, 0.05)
    else:
        cat = category
        cu = 0.25 + math.fmod(len(token) * 0.11, 0.6) + rng.uniform(-0.05, 0.05)
        cv = 0.3 + math.fmod(token_index * 0.09, 0.6) + rng.uniform(-0.05, 0.05)
    sigma = CATEGORY_SIGMA[cat] * rng.uniform(0.85, 1.15)
    amp = CATEGORY_AMP[cat] * rng.uniform(0.85, 1.15)
    return (min(max(cu, 0.05), 0.95), min(max(cv, 0.05), 0.95), sigma, amp, cat)


def token_wells(meta_list, G):
    """Per-token patch-field matrices (T, G, G) on a uniform patch grid."""
    yy = (np.arange(G, dtype=np.float32) + 0.5) / G
    xx = (np.arange(G, dtype=np.float32) + 0.5) / G
    ug, vg = np.meshgrid(xx, yy)
    wells = []
    for (_w, _cat, cu, cv, sigma, amp) in meta_list:
        du = ug - cu
        dv = vg - cv
        wells.append(amp * np.exp(-(du ** 2 + dv ** 2) / (2.0 * max(sigma, 0.02) ** 2)))
    return np.stack(wells, axis=0)


def normalize(a):
    lo = float(a.min())
    hi = float(a.max())
    if hi - lo < 1e-9:
        return np.zeros_like(a)
    return ((a - lo) / (hi - lo)).astype(np.float32)


def round4(x):
    return round(float(x), 4)


def round_nested(m):
    return [[round4(v) for v in row] for row in m]


def upsample_to(energy, res):
    """Bilinear-upsample a G x G latent map to res x res in [0, 1]."""
    normalized = np.clip(normalize(energy) * 255.0, 0, 255).astype(np.uint8)
    up = Image.fromarray(normalized).resize((res, res), Image.BILINEAR)
    return np.asarray(up, dtype=np.float32) / 255.0


def token_color(token, cat, seed, scale=1.0):
    """Per-token tinted RGB color with deterministic jitter."""
    base = np.array(CATEGORY_COLOR.get(cat, (150, 160, 170)), dtype=np.float32)
    jitter = np.array(
        [
            _token_rng(token + ":r", seed).uniform(-30, 30),
            _token_rng(token + ":g", seed).uniform(-30, 30),
            _token_rng(token + ":b", seed).uniform(-30, 30),
        ],
        dtype=np.float32,
    )
    return (base + jitter) * scale


def synthesize(meta_list, weights, energy, G, mode, resolution, seed):
    """Inverse projection: render a textured RGB image from the latent map."""
    res = resolution
    rng = np.random.default_rng(seed if seed is not None else 0)
    e_up = upsample_to(energy, res)

    ys, xs = np.mgrid[0:res, 0:res].astype(np.float32) / max(1, res - 1)
    base = np.stack(
        [
            38 + 55 * (1 - ys) + 30 * ys,
            50 + 40 * ys,
            92 + 95 * (1 - ys),
        ],
        axis=-1,
    ).astype(np.float32)
    img = base

    radials = []
    for (token, cat, cu, cv, sigma, amp) in meta_list:
        du = xs - cu
        dv = ys - cv
        rad = np.exp(-(du ** 2 + dv ** 2) / (2.0 * max(0.05, sigma * 1.3) ** 2))
        radials.append(rad)
        col = token_color(token, cat, seed)
        img = img + (amp * 0.9) * (col[None, None, :] * rad[:, :, None])

    if mode == "prototype_activation":
        cover = (
            np.stack([r * w for r, w in zip(radials, weights)])
            if radials
            else np.zeros((1, res, res), dtype=np.float32)
        )
        proto_idx = np.argmax(cover, axis=0)
        alpha = np.clip(cover.max(axis=0), 0, 1)
        proto_colors = [token_color(t[0], t[1], seed) for t in meta_list] or [
            np.array((150, 160, 170), np.float32)
        ]
        colorized = np.stack(
            [np.broadcast_to(c[None, None, :], (res, res, 3)).copy() for c in proto_colors],
            axis=0,
        )
        mixed = colorized[
            np.minimum(proto_idx, len(proto_colors) - 1),
            np.arange(res)[:, None],
            np.arange(res)[None, :],
        ]
        img = img * (1 - 0.7 * alpha[:, :, None]) + mixed * (0.7 * alpha[:, :, None])
    elif mode == "patch_attention_energy":
        fx = xs * G
        fy = ys * G
        line = (np.abs(fx - np.round(fx)) < 0.06) | (np.abs(fy - np.round(fy)) < 0.06)
        img = img * (1 - 0.45 * line.astype(np.float32))[:, :, None]
        img = img + (e_up[:, :, None] * np.array((255, 230, 120), np.float32)[None, None, :]) * 0.35
    else:  # feature_attribution: tinted ribbons linking weighted token centroids
        ordered = sorted(range(len(meta_list)), key=lambda i: weights[i], reverse=True)
        for a, b in zip(ordered, ordered[1:]):
            p0 = np.array([meta_list[a][2], meta_list[a][3]], np.float32)
            p1 = np.array([meta_list[b][2], meta_list[b][3]], np.float32)
            seg = p1 - p0
            den = max(1e-6, float(seg @ seg))
            axys = np.stack([xs, ys], axis=-1)
            tt = np.clip(np.einsum("hwc,c->hw", (axys - p0), seg) / den, 0.0, 1.0)
            proj = p0 + tt[:, :, None] * seg[None, None, :]
            dist = np.linalg.norm(axys - proj, axis=-1)
            thick = 2.0 + 5.0 * weights[a]
            mask = (dist < thick).astype(np.float32)
            col = token_color(meta_list[a][0], meta_list[a][1], seed)
            img = img + (col * 0.5 * weights[a])[None, None, :] * mask[:, :, None]

    edge = np.abs(
        np.roll(e_up, 1, 0) + np.roll(e_up, -1, 0) + np.roll(e_up, 1, 1) + np.roll(e_up, -1, 1)
        - 4 * e_up
    )
    edge = normalize(edge)
    harmonic = np.zeros((res, res), dtype=np.float32)
    for _ in range(5):
        fx_ = rng.uniform(0.5, 2.5)
        fy_ = rng.uniform(0.5, 2.5)
        phase = rng.uniform(0, 2 * math.pi)
        harmonic += np.sin(2 * math.pi * (fx_ * xs + fy_ * ys) + phase)
    harmonic *= 0.2 + 0.8 * edge
    img = img + harmonic[:, :, None] * np.array((26, 24, 30), np.float32)[None, None, :]
    img = img + rng.normal(0.0, 6.0, (res, res, 3)).astype(np.float32)
    img = np.clip(img, 0, 255).astype(np.uint8)

    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG")
    return buf.getvalue()


def reverse_generate(args):
    start_time = time.time()
    prompt = args.prompt or "synthetic visual scene"
    mode = args.mode
    resolution = max(64, min(int(args.resolution), 512))
    seed = args.seed

    raw_tokens = tokenize(prompt)
    meta = []
    for i, (w, cat) in enumerate(raw_tokens):
        cu, cv, sigma, amp, cat2 = well_info(w, cat, i, seed)
        meta.append((w, cat2, cu, cv, sigma, amp))
    if not meta:
        meta = [("scene", "descriptor", 0.5, 0.5, 0.15, 0.25)]

    amps = np.array([m[5] for m in meta], dtype=np.float32)
    weights = list(amps / max(1e-6, amps.sum()))

    G = 32 if resolution >= 224 else 16
    W = token_wells(meta, G)
    combined = (W * np.array(weights, dtype=np.float32)[:, None, None]).sum(axis=0)

    if mode == "prototype_activation":
        energy = W.max(axis=0)
    elif mode == "patch_attention_energy":
        attention_mix = normalize(W).mean(axis=0)
        energy = combined * (0.4 + 0.6 * normalize(attention_mix))
    else:
        energy = combined
    energy = normalize(energy)

    png_bytes = synthesize(meta, weights, energy, G, mode, resolution, seed)

    dominant_idx = W.argmax(axis=0)
    flat = energy.flatten()
    patches = sorted(range(G * G), key=lambda p: flat[p], reverse=True)
    spatial_patches = []
    for p in patches[:48]:
        r, c = divmod(p, G)
        spatial_patches.append(
            {
                "patch": p,
                "row": r,
                "col": c,
                "energy": round4(flat[p]),
                "dominant_token": meta[int(dominant_idx[r, c])][0],
            }
        )

    shares = W.sum(axis=(1, 2))
    total_share = max(1e-6, float(shares.sum()))
    attributions = []
    for i, (w, cat, cu, cv, sigma, _amp) in enumerate(meta):
        attributions.append(
            {
                "token": w,
                "category": cat,
                "weight": round4(weights[i]),
                "centroid": [round4(cu), round4(cv)],
                "sigma": round4(sigma),
                "energy_share": round4(float(shares[i]) / total_share),
            }
        )

    ents = flat / max(1e-9, float(flat.sum()))
    entropy = float(-(ents * np.log(ents + 1e-12)).sum() / math.log(G * G))
    peak_pos = int(flat.argmax())
    peak_row, peak_col = divmod(peak_pos, G)
    elapsed_ms = round4((time.time() - start_time) * 1000.0)

    output_path = getattr(args, "output", None)
    if not output_path:
        out_dir = os.path.join(os.getcwd(), ".mcp-uploads", "vlm-reverse")
        os.makedirs(out_dir, exist_ok=True)
        output_path = os.path.join(out_dir, f"vlm_reverse_{int(time.time() * 1000)}.png")
    else:
        out_parent = os.path.dirname(os.path.abspath(output_path))
        if out_parent:
            os.makedirs(out_parent, exist_ok=True)

    with open(output_path, "wb") as f:
        f.write(png_bytes)

    return {
        "output_path": os.path.abspath(output_path),
        "tokens": [w for w, _ in raw_tokens],
        "token_attributions": attributions,
        "spatial_patches": spatial_patches,
        "latent_energy_map": round_nested(energy),
        "metrics": {
            "patch_grid": G,
            "resolution": resolution,
            "mode": mode,
            "attention_entropy": round4(entropy),
            "peak_saliency": round4(float(flat.max())),
            "peak_coords": [peak_row, peak_col],
            "token_count": len(raw_tokens),
            "elapsed_ms": elapsed_ms,
        },
        "learning_notes": (
            "Vision-Language models (Qwen2.5-VL style) project textual token vectors into a "
            "2D continuous spatial latent space of cross-attention energy wells; the reverse "
            "problem inverts this mapping - instead of classifying an image into tokens, we "
            "reconstruct an image from token embeddings by IDCT/harmonic synthesis over the "
            "latent energy map, so attention becomes geometry."
        ),
    }


def main():
    parser = argparse.ArgumentParser(
        description="VLM Reverse Image Synthesis & Attribution Engine"
    )
    parser.add_argument("action", choices=("reverse_generate",))
    parser.add_argument("--file", default=None, help="ignored; scenario target is synthetic")
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--mode", default="feature_attribution", choices=MODES)
    parser.add_argument("--resolution", default=256, type=int)
    parser.add_argument("--seed", default=None, type=int)
    parser.add_argument("--output", default=None, help="persisted destination PNG path")
    args = parser.parse_args()
    result = reverse_generate(args)
    json.dump(result, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
