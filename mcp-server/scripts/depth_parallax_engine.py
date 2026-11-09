#!/usr/bin/env python3
"""
Pure NumPy 2.5D layered homography warping + synthetic/relative depth field + Telea/median disocclusion fill.
"""

import argparse
import base64
import io
import json
import math
import os
import sys
import numpy as np
from PIL import Image


def generate_relative_depth(img_rgb: np.ndarray) -> np.ndarray:
    """
    Generate synthetic/relative depth field [0.0, 1.0] from image using luminance gradient + spatial prior.
    Higher values = closer / foreground, lower values = far / background.
    """
    h, w, _ = img_rgb.shape
    # Grayscale luminance
    lum = 0.2989 * img_rgb[:, :, 0] + 0.5870 * img_rgb[:, :, 1] + 0.1140 * img_rgb[:, :, 2]
    norm_lum = lum / 255.0

    # Vertical spatial gradient (ground plane prior: bottom is closer, top is further)
    y_grad = np.linspace(0.0, 1.0, h, endpoint=True)[:, None]
    y_field = np.repeat(y_grad, w, axis=1)

    # Center-focus radial prior
    yc, xc = h / 2.0, w / 2.0
    y_coords, x_coords = np.ogrid[:h, :w]
    dist_center = np.sqrt(((y_coords - yc) / yc) ** 2 + ((x_coords - xc) / xc) ** 2)
    radial_prior = np.clip(1.0 - 0.5 * dist_center, 0.0, 1.0)

    # Composite depth
    depth = 0.5 * y_field + 0.3 * norm_lum + 0.2 * radial_prior
    d_min, d_max = depth.min(), depth.max()
    if d_max > d_min:
        depth = (depth - d_min) / (d_max - d_min)
    else:
        depth = np.full((h, w), 0.5, dtype=np.float32)
    return depth.astype(np.float32)


def compute_depth_entropy(depth: np.ndarray, bins: int = 32) -> float:
    """Compute Shannon entropy of the depth field."""
    hist, _ = np.histogram(depth, bins=bins, range=(0.0, 1.0), density=True)
    hist = hist[hist > 0]
    # normalize probabilities
    p = hist / np.sum(hist)
    entropy = -np.sum(p * np.log2(p))
    return float(entropy)


def warp_layer(
    img: np.ndarray,
    mask: np.ndarray,
    scale: float,
    shift_x: float,
    shift_y: float = 0.0
) -> tuple[np.ndarray, np.ndarray]:
    """
    Pure NumPy inverse-mapping homography/affine warp for a single depth layer.
    Warp transformation: maps layer according to camera translation / zoom.
    x_src = (x_dst - shift_x - cx) / scale + cx
    y_src = (y_dst - shift_y - cy) / scale + cy
    """
    h, w, c = img.shape
    cx, cy = w / 2.0, h / 2.0

    yd, xd = np.indices((h, w), dtype=np.float32)

    xs = (xd - shift_x - cx) / scale + cx
    ys = (yd - shift_y - cy) / scale + cy

    # Valid source bounds
    valid_coords = (xs >= 0) & (xs <= w - 1) & (ys >= 0) & (ys <= h - 1)

    # Nearest / bilinear sample
    xs_clip = np.clip(xs, 0, w - 1)
    ys_clip = np.clip(ys, 0, h - 1)

    x0 = np.floor(xs_clip).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y0 = np.floor(ys_clip).astype(np.int32)
    y1 = np.clip(y0 + 1, 0, h - 1)

    wx = (xs_clip - x0)[:, :, None]
    wy = (ys_clip - y0)[:, :, None]

    # Sample mask with nearest neighbor
    xs_round = np.clip(np.round(xs), 0, w - 1).astype(np.int32)
    ys_round = np.clip(np.round(ys), 0, h - 1).astype(np.int32)
    src_mask = mask[ys_round, xs_round] & valid_coords

    # Bilinear sample image
    ia = img[y0, x0]
    ib = img[y0, x1]
    ic = img[y1, x0]
    id_val = img[y1, x1]

    top = ia * (1 - wx) + ib * wx
    bottom = ic * (1 - wx) + id_val * wx
    warped_img = top * (1 - wy) + bottom * wy

    # Zero out unmapped or invalid mask areas
    warped_img = np.where(src_mask[:, :, None], warped_img, 0.0)
    return warped_img, src_mask


def fill_disocclusion_median_telea(composite: np.ndarray, filled_mask: np.ndarray) -> np.ndarray:
    """
    Fast pure-NumPy Telea / multi-pass directional median inpainting for disocclusion holes (!filled_mask).
    Propagates nearest valid color and applies median smoothing on infilled holes.
    """
    h, w, c = composite.shape
    if np.all(filled_mask):
        return composite.copy()

    result = composite.copy()
    unfilled = ~filled_mask

    # Step 1: Multi-direction propagation (left, right, up, down)
    # Forward horizontal fill
    for y in range(h):
        last_val = None
        for x in range(w):
            if filled_mask[y, x]:
                last_val = result[y, x]
            elif last_val is not None:
                result[y, x] = last_val

    # Backward horizontal fill for remaining
    for y in range(h):
        last_val = None
        for x in range(w - 1, -1, -1):
            if filled_mask[y, x]:
                last_val = result[y, x]
            elif unfilled[y, x] and last_val is not None:
                result[y, x] = 0.5 * result[y, x] + 0.5 * last_val

    # Vertical propagation for any boundary residue
    for x in range(w):
        last_val = None
        for y in range(h):
            if filled_mask[y, x]:
                last_val = result[y, x]
            elif unfilled[y, x] and last_val is not None:
                result[y, x] = 0.5 * result[y, x] + 0.5 * last_val

    # 3x3 median filtering specifically on unfilled pixels (telea/median regularization)
    padded = np.pad(result, ((1, 1), (1, 1), (0, 0)), mode='edge')
    windows = []
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            windows.append(padded[dy:dy + h, dx:dx + w])
    stacked = np.stack(windows, axis=0)  # [9, H, W, C]
    median_filtered = np.median(stacked, axis=0)

    final_result = np.where(unfilled[:, :, None], median_filtered, composite)
    return final_result


def run_depth_parallax(
    img_path: str,
    depth_layers: int = 8,
    dolly: float = 15.0,
    pan: float = 0.0,
    shift_y: float = 0.0,
    near: float = 20.0,
    far: float = 100.0,
    output_path: str | None = None
) -> dict:
    if not os.path.exists(img_path):
        raise FileNotFoundError(f"Input image not found: {img_path}")

    pil_img = Image.open(img_path).convert("RGB")
    img_np = np.asarray(pil_img, dtype=np.float32)
    h, w, _ = img_np.shape

    # Generate synthetic / relative depth map
    depth = generate_relative_depth(img_np)
    depth_entropy = compute_depth_entropy(depth)

    # Stratify depth into N discrete layers from far (0) to near (1)
    layer_quant = np.clip(np.floor(depth * depth_layers).astype(np.int32), 0, depth_layers - 1)

    # Initialize canvas and composite buffer
    composite = np.zeros_like(img_np)
    accum_mask = np.zeros((h, w), dtype=bool)

    # Parallax scale/shift based on dolly and pan
    # Far layers shift less, near layers shift more
    # Near plane distance = near, Far plane distance = far
    for layer_idx in range(depth_layers):
        layer_mask = (layer_quant == layer_idx)
        if not np.any(layer_mask):
            continue

        # Relative layer depth: 0.0 (far) to 1.0 (near)
        t = layer_idx / max(depth_layers - 1, 1)
        # Z-depth in world units
        z = far - t * (far - near)
        z = max(z, 1.0)

        # Disparity ~ 1 / z
        disparity = 1.0 / z
        # Pan and vertical shift
        shift_x = pan * disparity * 100.0
        shift_y_layer = shift_y * disparity * 100.0
        # Dolly zoom factor (near objects expand more than far objects)
        scale = 1.0 + (dolly / 100.0) * disparity * 20.0
        scale = max(scale, 0.01)

        warped_layer, valid_warped = warp_layer(img_np, layer_mask, scale, shift_x, shift_y_layer)

        # Painter's algorithm: write over background
        mask_3d = valid_warped[:, :, None]
        composite = np.where(mask_3d, warped_layer, composite)
        accum_mask = accum_mask | valid_warped

    # Disocclusion ratio
    disocclusion_ratio = float(np.mean(~accum_mask))

    # Inpaint disocclusion holes
    final_canvas = fill_disocclusion_median_telea(composite, accum_mask)
    final_canvas = np.clip(final_canvas, 0, 255).astype(np.uint8)

    # Export to output or buffer
    out_pil = Image.fromarray(final_canvas)
    if output_path:
        out_dir = os.path.dirname(output_path)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        out_pil.save(output_path, format="PNG")

    buf = io.BytesIO()
    out_pil.save(buf, format="PNG")
    b64_str = base64.b64encode(buf.getvalue()).decode("utf-8")

    return {
        "ok": True,
        "operation": "parallax_warp",
        "layers_count": int(depth_layers),
        "dolly_mm": float(dolly),
        "output_base64": b64_str,
        "metrics": {
            "disocclusion_ratio": round(disocclusion_ratio, 4),
            "depth_entropy": round(depth_entropy, 4)
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Pure NumPy 2.5D Depth Parallax Engine")
    parser.add_argument("--file", required=True, help="Input image file path")
    parser.add_argument("--depth-layers", type=int, default=8, help="Number of depth layers")
    parser.add_argument("--dolly", type=float, default=15.0, help="Dolly translation in mm/arbitrary units")
    parser.add_argument("--pan", type=float, default=0.0, help="Pan translation in pixels/units")
    parser.add_argument("--shift-y", type=float, default=0.0, help="Vertical tilt / shift in pixels/units")
    parser.add_argument("--near", type=float, default=20.0, help="Near plane depth")
    parser.add_argument("--far", type=float, default=100.0, help="Far plane depth")
    parser.add_argument("--output", type=str, default=None, help="Output image file path")

    args = parser.parse_args()

    try:
        res = run_depth_parallax(
            img_path=args.file,
            depth_layers=args.depth_layers,
            dolly=args.dolly,
            pan=args.pan,
            shift_y=args.shift_y,
            near=args.near,
            far=args.far,
            output_path=args.output
        )
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
