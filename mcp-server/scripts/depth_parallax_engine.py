#!/usr/bin/env python3
"""Local depth-guided pseudo-3D image warp and bbox-selected object transform.

Depth Anything V2 Small weights must already exist locally. Heuristic depth is
available only by explicit opt-in. Single-image warps do not reconstruct hidden
surfaces and are not true 3D scene reconstruction.
"""

import sys
import os
import argparse
import json
import base64
import io
import math
import uuid
import tempfile
import numpy as np
from PIL import Image

try:
    import cv2
    HAS_OPENCV = True
except ImportError:
    HAS_OPENCV = False


def _weighted_boundary_denoise(canvas: np.ndarray, boundary_mask: np.ndarray, radius: int = 4) -> np.ndarray:
    """Apply distance-weighted edge-preserving bilateral smoothing strictly along warped/disocclusion boundaries."""
    if not HAS_OPENCV or not np.any(boundary_mask):
        return canvas
    b_u8 = (boundary_mask > 0).astype(np.uint8)
    dist_b = cv2.distanceTransform((b_u8 == 0).astype(np.uint8), cv2.DIST_L2, 3)
    sigma = max(float(radius) * 0.55, 1.0)
    w_b = np.where(b_u8 > 0, 0.85, np.exp(-((dist_b / sigma) ** 2)) * 0.72).astype(np.float32)
    w_b[dist_b > float(radius)] = 0.0
    denoised = cv2.bilateralFilter(canvas.astype(np.uint8), d=7, sigmaColor=28, sigmaSpace=4).astype(np.float32)
    blended = (1.0 - w_b[:, :, None]) * canvas.astype(np.float32) + w_b[:, :, None] * denoised
    return np.clip(blended, 0, 255).astype(np.uint8)


def _forward_zbuffer_splat(
    src_rgb: np.ndarray,
    dst_x: np.ndarray,
    dst_y: np.ndarray,
    depth_z: np.ndarray,
    keep_mask: np.ndarray,
    src_alpha: np.ndarray | None = None,
    z_tol: float = 0.05,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray | None]:
    """2-pass Z-buffered 2x2 bilinear forward splat returning (canvas_f, has_data, z_grid, alpha_grid)."""
    sh, sw, _ = src_rgb.shape
    xd_v = dst_x[keep_mask]
    yd_v = dst_y[keep_mask]
    d_v = depth_z[keep_mask].astype(np.float32)
    img_v = src_rgb[keep_mask].astype(np.float64)
    a_v = src_alpha[keep_mask].astype(np.float64) if src_alpha is not None else None

    x0 = np.floor(xd_v).astype(np.int32)
    y0 = np.floor(yd_v).astype(np.int32)
    fx = xd_v - x0
    fy = yd_v - y0

    n_pix = sh * sw
    z_buf = np.full(n_pix, -1e9, dtype=np.float32)
    offsets = (
        (0, 0, (1.0 - fx) * (1.0 - fy)),
        (1, 0, fx * (1.0 - fy)),
        (0, 1, (1.0 - fx) * fy),
        (1, 1, fx * fy),
    )

    for ox, oy, wb in offsets:
        ix = x0 + ox
        iy = y0 + oy
        m = (ix >= 0) & (ix < sw) & (iy >= 0) & (iy < sh) & (wb > 0.08)
        if np.any(m):
            np.maximum.at(z_buf, iy[m] * sw + ix[m], d_v[m])

    w_sum = np.zeros(n_pix, dtype=np.float64)
    c_sum = np.zeros((n_pix, 3), dtype=np.float64)
    a_sum = np.zeros(n_pix, dtype=np.float64) if a_v is not None else None
    for ox, oy, wb in offsets:
        ix = x0 + ox
        iy = y0 + oy
        m = (ix >= 0) & (ix < sw) & (iy >= 0) & (iy < sh) & (wb > 0.0)
        if not np.any(m):
            continue
        fidx = iy[m] * sw + ix[m]
        w_eff = wb[m].astype(np.float64) * (d_v[m] >= z_buf[fidx] - z_tol)
        valid_w = w_eff > 0.0
        if not np.any(valid_w):
            continue
        fidx_w = fidx[valid_w]
        w_fin = w_eff[valid_w]
        src_c = img_v[m][valid_w]
        w_sum += np.bincount(fidx_w, weights=w_fin, minlength=n_pix)
        for ch in range(3):
            c_sum[:, ch] += np.bincount(fidx_w, weights=src_c[:, ch] * w_fin, minlength=n_pix)
        if a_sum is not None and a_v is not None:
            a_sum += np.bincount(fidx_w, weights=a_v[m][valid_w] * w_fin, minlength=n_pix)

    w_grid = w_sum.reshape(sh, sw)
    z_grid = z_buf.reshape(sh, sw)
    has_data = w_grid > 0.05
    canvas_f = np.zeros((sh, sw, 3), dtype=np.float32)
    canvas_f[has_data] = (c_sum.reshape(sh, sw, 3)[has_data] / w_grid[has_data, None]).astype(np.float32)
    alpha_grid = None
    if a_sum is not None:
        alpha_grid = np.zeros((sh, sw), dtype=np.float32)
        alpha_grid[has_data] = np.clip(a_sum.reshape(sh, sw)[has_data] / w_grid[has_data], 0.0, 1.0).astype(np.float32)
    return canvas_f, has_data, z_grid, alpha_grid


def generate_relative_depth(img_np: np.ndarray) -> np.ndarray:
    """
    Explicit heuristic fallback only; this is not machine-learned depth.
    """
    h, w, _ = img_np.shape
    y_coords, x_coords = np.indices((h, w), dtype=np.float32)

    # Vertical atmospheric perspective prior (ground is near, sky/roof is far)
    vert_prior = y_coords / float(max(h - 1, 1))

    # Luminance channel
    lum = 0.299 * img_np[:, :, 0] + 0.587 * img_np[:, :, 1] + 0.114 * img_np[:, :, 2]
    lum_norm = lum / 255.0

    if HAS_OPENCV:
        grad_x = cv2.Sobel(lum_norm, cv2.CV_32F, 1, 0, ksize=3)
        grad_y = cv2.Sobel(lum_norm, cv2.CV_32F, 0, 1, ksize=3)
        grad_mag = np.sqrt(grad_x**2 + grad_y**2)
        grad_smooth = cv2.GaussianBlur(grad_mag, (25, 25), 8.0)
        grad_norm = (grad_smooth - grad_smooth.min()) / max(grad_smooth.max() - grad_smooth.min(), 1e-6)
    else:
        padded = np.pad(lum_norm, ((1, 1), (1, 1)), mode='edge')
        grad_y = np.abs(padded[2:, 1:-1] - padded[:-2, 1:-1])
        grad_x = np.abs(padded[1:-1, 2:] - padded[1:-1, :-2])
        grad_norm = np.clip(grad_x + grad_y, 0.0, 1.0)

    # Center focus prior
    center_y, center_x = 0.55 * h, 0.45 * w
    dist_center = np.sqrt(((x_coords - center_x) / (0.45 * w))**2 + ((y_coords - center_y) / (0.45 * h))**2)
    focus_prior = np.clip(1.2 - dist_center, 0.0, 1.0)

    raw_depth = 0.40 * vert_prior + 0.35 * grad_norm + 0.25 * focus_prior
    d_min, d_max = np.min(raw_depth), np.max(raw_depth)
    depth = (raw_depth - d_min) / max(d_max - d_min, 1e-6)

    if HAS_OPENCV:
        depth_u8 = (depth * 255).astype(np.uint8)
        depth = cv2.bilateralFilter(depth_u8, 11, 75, 75).astype(np.float32) / 255.0

    return depth.astype(np.float32)


class DepthModelUnavailable(RuntimeError):
    pass


def estimate_depth_map(img_np: np.ndarray, depth_mode: str = "model") -> tuple[np.ndarray, dict]:
    """Estimate relative depth from a configured local model, or explicit heuristic mode."""
    if depth_mode == "heuristic":
        return generate_relative_depth(img_np), {"backend": "heuristic", "weights": "none"}
    if depth_mode != "model":
        raise ValueError("depth_mode must be 'model' or explicitly opted-in 'heuristic'")
    model_path = os.environ.get("DEPTH_ANYTHING_MODEL_PATH", "").strip()
    if not model_path or not os.path.isdir(model_path):
        raise DepthModelUnavailable(
            "Depth Anything V2 Small unavailable: set DEPTH_ANYTHING_MODEL_PATH to a local model directory; no weights were downloaded."
        )
    try:
        import torch
        import torch.nn.functional as torch_functional
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        processor = AutoImageProcessor.from_pretrained(model_path, local_files_only=True)
        model = AutoModelForDepthEstimation.from_pretrained(model_path, local_files_only=True)
        model.to("cpu")
        model.eval()
        image = Image.fromarray(np.clip(img_np, 0, 255).astype(np.uint8), mode="RGB")
        inputs = processor(images=image, return_tensors="pt")
        with torch.inference_mode():
            prediction = model(**inputs).predicted_depth
            prediction = torch_functional.interpolate(
                prediction.unsqueeze(1), size=image.size[::-1], mode="bicubic", align_corners=False
            ).squeeze()
        depth = prediction.detach().cpu().numpy().astype(np.float32)
    except Exception as exc:
        raise DepthModelUnavailable("Local Depth Anything V2 Small could not run: " + str(exc)) from exc
    low, high = np.percentile(depth, [1, 99])
    if not np.isfinite(low) or not np.isfinite(high) or high - low < 1e-6:
        raise DepthModelUnavailable("Depth model returned a constant or non-finite depth map")
    normalized = np.clip((depth - low) / (high - low), 0.0, 1.0)
    return normalized.astype(np.float32), {"backend": "Depth Anything V2 Small", "weights": "local"}


def compute_depth_entropy(depth_map: np.ndarray, bins: int = 32) -> float:
    counts, _ = np.histogram(depth_map, bins=bins, range=(0.0, 1.0))
    probs = counts[counts > 0].astype(np.float32) / float(depth_map.size)
    return float(-np.sum(probs * np.log2(probs + 1e-12)))


def compute_pooling_pixel_awareness(roi_np: np.ndarray, depth_roi: np.ndarray | None = None) -> np.ndarray:
    """
    Dense multi-scale pooling-driven pixel awareness for foreground entity isolation.
    Combines multi-scale MaxPool/MinPool contrast, lateral-corner background color
    distance, optional depth-map foreground separation, and an upright-body spatial prior
    so heads near the top of a bounding box are never clipped.
    """
    rh, rw, _ = roi_np.shape
    y_idx, x_idx = np.ogrid[:rh, :rw]
    # Broad upright body/head prior: keeps head region (top 5%-30%) weighted alongside torso
    horiz_prior = np.exp(-(((x_idx - rw * 0.5) / max(rw * 0.44, 1.0)) ** 2))
    vert_prior = np.clip(1.0 - np.maximum(0.0, np.abs(y_idx - rh * 0.48) - rh * 0.34) / max(rh * 0.28, 1.0), 0.35, 1.0)
    body_prior = horiz_prior * vert_prior

    if HAS_OPENCV:
        gray = cv2.cvtColor(roi_np.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        pool_diffs = []
        for k in [3, 7, 15, 31]:
            if k >= min(rh, rw):
                continue
            kernel = np.ones((k, k), np.uint8)
            max_p = cv2.dilate(gray, kernel)
            min_p = cv2.erode(gray, kernel)
            avg_p = cv2.blur(gray, (k, k))
            diff = (max_p - min_p) * (1.0 + np.abs(gray - avg_p))
            pool_diffs.append(diff)
        if pool_diffs:
            pool_energy = np.mean(pool_diffs, axis=0)
            pool_energy = (pool_energy - pool_energy.min()) / max(pool_energy.max() - pool_energy.min(), 1e-6)
        else:
            pool_energy = np.ones((rh, rw), dtype=np.float32)

        # Sample lateral margins & upper corners (never full top row so hairline stays protected)
        border_mask = np.zeros((rh, rw), dtype=bool)
        lat_w = max(1, int(rw * 0.04))
        corner_h = max(1, int(rh * 0.12))
        corner_w = max(1, int(rw * 0.14))
        border_mask[:, :lat_w] = True
        border_mask[:, -lat_w:] = True
        border_mask[:corner_h, :corner_w] = True
        border_mask[:corner_h, -corner_w:] = True
        bg_samples = roi_np[border_mask]
        if len(bg_samples) > 0:
            bg_color = np.median(bg_samples, axis=0)
            color_dist = np.linalg.norm(roi_np - bg_color, axis=2)
            color_dist = (color_dist - color_dist.min()) / max(color_dist.max() - color_dist.min(), 1e-6)
        else:
            color_dist = np.ones((rh, rw), dtype=np.float32)

        if depth_roi is not None and depth_roi.shape[:2] == (rh, rw):
            bg_depth = float(np.median(depth_roi[border_mask])) if np.any(border_mask) else float(np.percentile(depth_roi, 20))
            fg_depth_span = max(float(np.percentile(depth_roi, 95)) - bg_depth, 0.05)
            depth_fg = np.clip((depth_roi - bg_depth) / fg_depth_span, 0.0, 1.0)
            awareness = 0.42 * depth_fg + 0.30 * pool_energy + 0.18 * color_dist + 0.10 * body_prior
        else:
            awareness = 0.45 * pool_energy + 0.35 * color_dist + 0.20 * body_prior
        return np.clip((awareness - awareness.min()) / max(awareness.max() - awareness.min(), 1e-6), 0.0, 1.0)
    else:
        if depth_roi is not None and depth_roi.shape[:2] == (rh, rw):
            d_min, d_max = float(depth_roi.min()), float(depth_roi.max())
            depth_fg = (depth_roi - d_min) / max(d_max - d_min, 1e-6)
            return np.clip(0.55 * depth_fg + 0.45 * body_prior, 0.0, 1.0)
        return body_prior


def create_object_mask(
    img_np: np.ndarray,
    bbox: tuple[int, int, int, int],
    mask_type: str = "auto",
    depth_map: np.ndarray | None = None,
) -> np.ndarray:
    """
    Creates a high-fidelity alpha matte for the specified entity bounding box.
    Uses multi-scale pooling-driven pixel awareness + optional 3D depth separation.
    Supports: 'sphere', 'circle', 'fullbody'/'grabcut', and 'rect'.
    """
    h, w, _ = img_np.shape
    x1, y1, x2, y2 = bbox
    bw = max(x2 - x1, 4)
    bh = max(y2 - y1, 4)
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    depth_roi = depth_map[y1:y2, x1:x2] if depth_map is not None else None

    if mask_type == "auto":
        mask_type = "fullbody" if HAS_OPENCV else "rect"

    if mask_type in ("sphere", "circle", "ball") and HAS_OPENCV:
        roi = img_np[y1:y2, x1:x2].astype(np.float32)
        rh, rw, _ = roi.shape
        yy_r, xx_r = np.indices((rh, rw), dtype=np.float32)
        ell_r2 = ((xx_r - (rw - 1) / 2.0) / max(rw * 0.485, 1.0)) ** 2 + ((yy_r - (rh - 1) / 2.0) / max(rh * 0.485, 1.0)) ** 2
        inside_ell = ell_r2 <= 1.0

        # Sample exterior bbox corners outside the inscribed sphere so adjacent collar stripes don't contaminate contrast
        corner_bg = roi[ell_r2 > 1.08]
        if corner_bg.size >= 12:
            bg_mean = np.median(corner_bg, axis=0)
            color_dist = np.linalg.norm(roi - bg_mean, axis=2)
        else:
            color_dist = compute_pooling_pixel_awareness(roi, depth_roi=depth_roi) * 100.0

        awareness = compute_pooling_pixel_awareness(roi, depth_roi=depth_roi)
        candidates = (inside_ell & ((color_dist > 28.0) | (awareness > 0.28) | (ell_r2 <= 0.74))).astype(np.uint8)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        clean = cv2.morphologyEx(candidates, cv2.MORPH_CLOSE, kernel)
        clean = cv2.morphologyEx(clean, cv2.MORPH_OPEN, kernel)
        clean[~inside_ell] = 0

        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(clean)
        center_pt = np.array([rw / 2.0, rh / 2.0])
        best_lbl = 1
        min_d = 999999.0
        for lbl in range(1, num_labels):
            if stats[lbl, cv2.CC_STAT_AREA] > 200:
                d = np.linalg.norm(centroids[lbl] - center_pt)
                if d < min_d:
                    min_d = d
                    best_lbl = lbl

        if num_labels > 1 and stats[best_lbl, cv2.CC_STAT_AREA] > 200:
            obj_mask = (labels == best_lbl).astype(np.float32)
        else:
            obj_mask = clean.astype(np.float32)

        obj_feather = cv2.GaussianBlur(obj_mask, (5, 5), 1.2)
        obj_feather[ell_r2 > 1.04] = 0.0
        final_canvas_mask = np.zeros((h, w), dtype=np.float32)
        final_canvas_mask[y1:y2, x1:x2] = obj_feather
        return np.clip(final_canvas_mask, 0.0, 1.0)

    elif mask_type in ("sphere", "circle", "ball"):
        # Pure-NumPy edge-smoothed boundary fallback
        y_idx, x_idx = np.ogrid[:h, :w]
        rx = bw / 2.0
        ry = bh / 2.0
        norm_dist = ((x_idx - cx) / rx) ** 2 + ((y_idx - cy) / ry) ** 2
        mask_feather = np.clip((1.05 - norm_dist) / 0.15, 0.0, 1.0)
        mask_feather[norm_dist > 1.05] = 0.0
        return np.clip(mask_feather, 0.0, 1.0)

    elif mask_type in ("fullbody", "grabcut") and HAS_OPENCV:
        try:
            roi = img_np[y1:y2, x1:x2].astype(np.float32)
            awareness = compute_pooling_pixel_awareness(roi, depth_roi=depth_roi)

            gc_mask = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
            roi_gc = np.full((bh, bw), cv2.GC_PR_BGD, dtype=np.uint8)

            # Pooling + 3D depth awareness seeds; protect top hairline region from forced background
            roi_gc[awareness > 0.24] = cv2.GC_PR_FGD
            roi_gc[awareness > 0.46] = cv2.GC_FGD
            roi_gc[awareness < 0.12] = cv2.GC_BGD

            edge_w = max(2, int(bw * 0.02))
            roi_gc[:, :edge_w] = np.where(awareness[:, :edge_w] < 0.40, cv2.GC_BGD, cv2.GC_PR_BGD)
            roi_gc[:, -edge_w:] = np.where(awareness[:, -edge_w:] < 0.40, cv2.GC_BGD, cv2.GC_PR_BGD)
            gc_mask[y1:y2, x1:x2] = roi_gc

            bgd_model = np.zeros((1, 65), np.float64)
            fgd_model = np.zeros((1, 65), np.float64)
            cv2.grabCut(img_np.astype(np.uint8), gc_mask, None, bgd_model, fgd_model, 3, cv2.GC_INIT_WITH_MASK)

            fg_mask_raw = np.where((gc_mask == cv2.GC_FGD) | (gc_mask == cv2.GC_PR_FGD), 1.0, 0.0).astype(np.float32)

            # Morphological bridge to connect entity parts (head, neck, torso, limbs)
            bridge_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 11))
            clean_roi = cv2.morphologyEx(fg_mask_raw[y1:y2, x1:x2], cv2.MORPH_CLOSE, bridge_k)

            # Filter connected components: keep torso and central upper head components
            num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats((clean_roi > 0.5).astype(np.uint8))
            final_roi = np.zeros_like(clean_roi)
            for lbl in range(1, num_labels):
                area = stats[lbl, cv2.CC_STAT_AREA]
                cx_lbl, cy_lbl = centroids[lbl]
                in_main = area > 600 and 0.10 * bw < cx_lbl < 0.90 * bw
                in_head = area > 180 and 0.18 * bw < cx_lbl < 0.82 * bw and cy_lbl < 0.40 * bh
                if in_main or in_head:
                    final_roi[labels == lbl] = 1.0

            if depth_roi is not None and float(final_roi.sum()) > 0:
                # Reclaim only hairline/head pixels connected near GrabCut foreground (avoid background arches/watermarks)
                upper_h = max(1, int(bh * 0.38))
                fg_depth_med = float(np.median(depth_roi[final_roi > 0.5]))
                fg_depth_std = max(float(np.std(depth_roi[final_roi > 0.5])), 0.05)
                prox_body = cv2.dilate((final_roi > 0.5).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))) > 0
                head_band = (
                    prox_body
                    & (np.arange(bh)[:, None] < upper_h)
                    & (np.arange(bw)[None, :] > 0.15 * bw)
                    & (np.arange(bw)[None, :] < 0.85 * bw)
                    & (depth_roi >= fg_depth_med - 0.85 * fg_depth_std)
                    & (awareness > 0.34)
                )
                reclaimed = np.maximum(final_roi, head_band.astype(np.float32))
                reclaim_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
                reclaimed = cv2.morphologyEx(reclaimed, cv2.MORPH_CLOSE, reclaim_k)
                n_cc, cc_lbl, cc_stats, _ = cv2.connectedComponentsWithStats((reclaimed > 0.5).astype(np.uint8))
                if n_cc > 1:
                    best_body = 1 + int(np.argmax(cc_stats[1:, cv2.CC_STAT_AREA]))
                    final_roi = (cc_lbl == best_body).astype(np.float32)
                else:
                    final_roi = reclaimed

            final_roi = cv2.GaussianBlur(final_roi, (5, 5), 1.5)
            final_canvas_mask = np.zeros((h, w), dtype=np.float32)
            final_canvas_mask[y1:y2, x1:x2] = final_roi
            return np.clip(final_canvas_mask, 0.0, 1.0)
        except Exception as exc:
            raise RuntimeError("GrabCut mask extraction failed: " + str(exc)) from exc

    # Rectangular mask with feathered borders
    mask = np.zeros((h, w), dtype=np.float32)
    mask[y1:y2, x1:x2] = 1.0
    if HAS_OPENCV:
        mask_feather = cv2.GaussianBlur(mask, (7, 7), 2.0)
    else:
        pad_blur = np.pad(mask, ((2, 2), (2, 2)), mode='edge')
        mask_feather = (
            pad_blur[:-4, 2:-2] + pad_blur[4:, 2:-2] +
            pad_blur[2:-2, :-4] + pad_blur[2:-2, 4:] +
            4.0 * pad_blur[2:-2, 2:-2]
        ) / 8.0
    return np.clip(mask_feather, 0.0, 1.0)


def inpaint_revealed_background(
    img_np: np.ndarray,
    mask_feather: np.ndarray,
    bbox: tuple[int, int, int, int],
    dilate_ksize: int = 7,
) -> np.ndarray:
    """
    Inpaints the footprint behind the transformed foreground object so the revealed
    background texture is seamless and the rest of the image remains stable.
    """
    h, w, _ = img_np.shape
    x1, y1, x2, y2 = bbox
    pad = 30
    iy1 = max(0, y1 - pad)
    iy2 = min(h, y2 + pad)
    ix1 = max(0, x1 - pad)
    ix2 = min(w, x2 + pad)

    bg_clean = img_np.copy()
    binary_mask = (mask_feather > 0.08).astype(np.uint8)

    if HAS_OPENCV:
        k_sz = max(3, int(dilate_ksize) | 1)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_sz, k_sz))
        dilated_mask = cv2.dilate(binary_mask, kernel, iterations=1)
        roi_img = img_np[iy1:iy2, ix1:ix2].astype(np.uint8)
        roi_mask = dilated_mask[iy1:iy2, ix1:ix2]
        if np.any(roi_mask):
            inpainted_roi = cv2.inpaint(roi_img, roi_mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
            bg_clean[iy1:iy2, ix1:ix2] = inpainted_roi.astype(np.float32)
        return bg_clean

    # Pure NumPy fallback
    bw = max(x2 - x1, 1)
    for y in range(max(0, y1), min(h, y2)):
        lx = max(0, x1 - 2)
        rx = min(w - 1, x2 + 2)
        left_color = bg_clean[y, lx]
        right_color = bg_clean[y, rx]
        for x in range(max(0, x1), min(w, x2)):
            if binary_mask[y, x]:
                weight = (x - x1) / float(bw)
                bg_clean[y, x] = (1.0 - weight) * left_color + weight * right_color
    return bg_clean


def run_bbox_object_pseudo3d_transform(
    img_np: np.ndarray,
    bbox: tuple[int, int, int, int],
    yaw: float = 30.0,
    pitch: float = 10.0,
    roll: float = 0.0,
    target: str = "user_bbox",
    mask_type: str = "auto",
    inpaint_background: bool = True,
    depth_map: np.ndarray | None = None,
    depth_source: str | None = None,
) -> tuple[np.ndarray, dict]:
    """Apply bbox-mask-constrained 2.5D perspective relief rotation; hidden surfaces are not reconstructed."""
    h, w, c = img_np.shape
    x1, y1, x2, y2 = (int(v) for v in bbox)
    x1, x2 = max(0, x1), min(w, x2)
    y1, y2 = max(0, y1), min(h, y2)
    if x2 - x1 < 4 or y2 - y1 < 4:
        raise ValueError("bbox must overlap image and be at least 4x4 pixels")

    if max(abs(yaw), abs(pitch), abs(roll)) > 45:
        raise ValueError("Object pseudo-3D rotation angles must stay within +/-45 degrees")
    box_w, box_h = x2 - x1, y2 - y1
    angle = math.radians(max(abs(yaw), abs(pitch), abs(roll)))
    rotated_extent = abs(math.cos(angle)) * max(box_w, box_h) + abs(math.sin(angle)) * min(box_w, box_h)
    pad = max(12, int(math.ceil((rotated_extent - max(box_w, box_h)) / 2 + 0.22 * max(box_w, box_h))))
    bx1 = max(0, x1 - pad)
    by1 = max(0, y1 - pad)
    bx2 = min(w, x2 + pad)
    by2 = min(h, y2 + pad)

    patch = img_np[by1:by2, bx1:bx2].copy()
    ph, pw, _ = patch.shape

    full_mask = create_object_mask(img_np, (x1, y1, x2, y2), mask_type=mask_type, depth_map=depth_map)
    patch_mask = full_mask[by1:by2, bx1:bx2]
    binary_mask = (patch_mask > 0.15).astype(np.uint8)

    is_sphere_mode = mask_type in ("sphere", "circle", "ball")
    if HAS_OPENCV:
        dist_map = cv2.distanceTransform(binary_mask, cv2.DIST_L2, 5)
        d_max = float(dist_map.max())
        z_dome = (
            np.sqrt(np.maximum(0.0, 2.0 * d_max * dist_map - dist_map**2))
            if d_max > 1.0
            else np.zeros((ph, pw), dtype=np.float32)
        )
        if is_sphere_mode:
            # Spheres (even with saturated Depth Anything values) require true hemispherical curvature
            if depth_map is not None:
                local_depth = np.clip(depth_map[by1:by2, bx1:bx2], 0.0, 1.0)
                fg_vals = local_depth[binary_mask > 0]
                d_low, d_high = np.percentile(fg_vals, [5, 95]) if fg_vals.size > 0 else (0.0, 1.0)
                norm_d = np.clip((local_depth - d_low) / max(float(d_high - d_low), 1e-6), 0.0, 1.0)
                fg_med_d = float(np.median(norm_d[binary_mask > 0])) if np.any(binary_mask) else 0.5
                smooth_d = cv2.GaussianBlur(np.where(binary_mask > 0, norm_d, fg_med_d).astype(np.float32), (17, 17), 5.0)
                z_surface = 0.82 * (z_dome * 0.85) + 0.18 * (smooth_d * float(min(ph, pw)) * 0.45)
            else:
                z_surface = z_dome * 0.85
        elif depth_map is not None:
            local_depth = np.clip(depth_map[by1:by2, bx1:bx2], 0.0, 1.0)
            fg_vals = local_depth[binary_mask > 0]
            d_low, d_high = np.percentile(fg_vals, [5, 95]) if fg_vals.size > 0 else (0.0, 1.0)
            norm_d = np.clip((local_depth - d_low) / max(float(d_high - d_low), 1e-6), 0.0, 1.0)
            fg_med_d = float(np.median(norm_d[binary_mask > 0])) if np.any(binary_mask) else 0.5
            filled_d = np.where(binary_mask > 0, norm_d, fg_med_d).astype(np.float32)
            smooth_d = cv2.GaussianBlur(filled_d, (21, 21), 6.5)
            z_surface = smooth_d * float(min(ph, pw)) * 0.28 + z_dome * 0.24
        else:
            z_surface = z_dome * 0.70

        M = cv2.moments(binary_mask)
        if M["m00"] > 1e-4:
            pcx = M["m10"] / M["m00"]
            pcy = M["m01"] / M["m00"]
        else:
            pcx = (pw - 1) / 2.0
            pcy = (ph - 1) / 2.0
    else:
        y_idx, x_idx = np.indices((ph, pw), dtype=np.float32)
        pcx = (pw - 1) / 2.0
        pcy = (ph - 1) / 2.0
        r_approx = min(pw, ph) / 2.0
        norm_r = np.sqrt((x_idx - pcx)**2 + (y_idx - pcy)**2) / max(r_approx, 1.0)
        dist_map = np.clip(1.0 - norm_r, 0.0, 1.0) * r_approx * patch_mask
        d_max = float(dist_map.max())
        if depth_map is not None:
            local_depth = np.clip(depth_map[by1:by2, bx1:bx2], 0.0, 1.0)
            z_surface = local_depth * float(min(ph, pw)) * 0.28 * np.clip(patch_mask, 0.0, 1.0)
        else:
            z_surface = np.sqrt(np.maximum(0.0, 2.0 * d_max * dist_map - dist_map**2))

    # Rotate spheres in place around true equatorial center (z=0); pivot articulated bodies around foreground median
    if is_sphere_mode:
        z_pivot = 0.0
    elif np.any(binary_mask):
        z_pivot = float(np.median(z_surface[binary_mask > 0]))
    else:
        z_pivot = 0.0
    z_centered = (z_surface - z_pivot).astype(np.float32)
    focal = float(max(pw, ph)) * 2.4

    ry = math.radians(yaw)
    rx = math.radians(pitch)
    rz = math.radians(roll)

    Ry_inv = np.array([[math.cos(-ry), 0, math.sin(-ry)], [0, 1, 0], [-math.sin(-ry), 0, math.cos(-ry)]], dtype=np.float32)
    Rx_inv = np.array([[1, 0, 0], [0, math.cos(-rx), -math.sin(-rx)], [0, math.sin(-rx), math.cos(-rx)]], dtype=np.float32)
    Rz_inv = np.array([[math.cos(-rz), -math.sin(-rz), 0], [math.sin(-rz), math.cos(-rz), 0], [0, 0, 1]], dtype=np.float32)
    R_inv = Ry_inv @ Rx_inv @ Rz_inv

    y_coords, x_coords = np.indices((ph, pw), dtype=np.float32)
    dx = x_coords - pcx
    dy = y_coords - pcy

    if HAS_OPENCV:
        R_fwd = R_inv.T
        P_obj = np.stack([dx, dy, z_centered], axis=-1)
        P_rot = np.einsum('ij,hwj->hwi', R_fwd, P_obj)
        denom = np.maximum(focal - P_rot[:, :, 2], 100.0)
        xd = pcx + focal * P_rot[:, :, 0] / denom
        yd = pcy + focal * P_rot[:, :, 1] / denom
        keep_fg = patch_mask > 0.02
        fg_z_span = float(np.ptp(P_rot[:, :, 2][keep_fg])) if np.any(keep_fg) else 10.0
        z_tol = max(2.5, 0.05 * fg_z_span)
        canvas_f, has_data, _, rot_alpha = _forward_zbuffer_splat(
            patch, xd, yd, P_rot[:, :, 2], keep_fg, src_alpha=patch_mask, z_tol=z_tol
        )
        rot_patch = np.clip(canvas_f, 0, 255).astype(np.uint8)
        rot_alpha = rot_alpha if rot_alpha is not None else has_data.astype(np.float32)
        sil_closed = cv2.morphologyEx((rot_alpha > 0.15).astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
        pinholes = (sil_closed > 0) & (~has_data)
        if np.any(pinholes):
            rot_patch = cv2.inpaint(rot_patch, pinholes.astype(np.uint8), inpaintRadius=3, flags=cv2.INPAINT_TELEA)
            rot_alpha = np.where(pinholes, 1.0, rot_alpha)
        valid_mask = np.clip(rot_alpha, 0.0, 1.0).astype(np.float32)
        # Extend foreground RGB outward into 0-weight border pixels so alpha feathering never blends [0,0,0] rings
        has_fg = (has_data | pinholes).astype(np.float32)
        fg_num = cv2.GaussianBlur(rot_patch.astype(np.float32) * has_fg[:, :, None], (7, 7), 1.6)
        fg_den = np.maximum(cv2.GaussianBlur(has_fg, (7, 7), 1.6), 1e-4)
        rot_patch = np.where(
            has_fg[:, :, None] > 0.5, rot_patch, np.clip(fg_num / fg_den[:, :, None], 0, 255).astype(np.uint8)
        )
        feather_mask = cv2.GaussianBlur(valid_mask, (3, 3), 0.7)[:, :, None]
    else:
        dz_est = z_centered.copy()
        sx = x_coords.copy()
        sy = y_coords.copy()
        for _ in range(3):
            persp = np.maximum(focal - dz_est, 1.0) / focal
            P_rot = np.stack([dx * persp, dy * persp, dz_est], axis=-1)
            P_src = np.einsum('ij,hwj->hwi', R_inv, P_rot)
            denom = np.maximum(focal + P_src[:, :, 2], 1.0)
            sx = pcx + focal * P_src[:, :, 0] / denom
            sy = pcy + focal * P_src[:, :, 1] / denom
            ix = np.clip(np.round(sx).astype(int), 0, pw - 1)
            iy = np.clip(np.round(sy).astype(int), 0, ph - 1)
            dz_est = 0.5 * dz_est + 0.5 * z_centered[iy, ix]

        front = (sx >= 0) & (sx < pw - 1) & (sy >= 0) & (sy < ph - 1)
        xs_clip = np.clip(sx, 0, pw - 2)
        ys_clip = np.clip(sy, 0, ph - 2)
        x0 = np.floor(xs_clip).astype(int)
        x1 = x0 + 1
        y0 = np.floor(ys_clip).astype(int)
        y1 = y0 + 1
        wx = (xs_clip - x0)[:, :, None]
        wy = (ys_clip - y0)[:, :, None]
        top = patch[y0, x0] * (1 - wx) + patch[y0, x1] * wx
        bottom = patch[y1, x0] * (1 - wx) + patch[y1, x1] * wx
        rot_patch = np.clip(top * (1 - wy) + bottom * wy, 0, 255).astype(np.uint8)
        alpha_top = patch_mask[y0, x0] * (1 - (xs_clip - x0)) + patch_mask[y0, x1] * (xs_clip - x0)
        alpha_bottom = patch_mask[y1, x0] * (1 - (xs_clip - x0)) + patch_mask[y1, x1] * (xs_clip - x0)
        source_alpha = alpha_top * (1 - (ys_clip - y0)) + alpha_bottom * (ys_clip - y0)
        valid_mask = front.astype(np.float32) * source_alpha
        feather_mask = valid_mask[:, :, None]

    if inpaint_background:
        # Inpaint the original object footprint so the unrotated entity never shows through as a ghost/offset
        k_inpaint = 11 if is_sphere_mode else 7
        bg_clean = inpaint_revealed_background(img_np, full_mask, (x1, y1, x2, y2), dilate_ksize=k_inpaint)
    else:
        bg_clean = img_np.copy()

    final_composite = bg_clean.copy()
    bg_patch = bg_clean[by1:by2, bx1:bx2]
    blended_patch = np.clip((1.0 - feather_mask) * bg_patch + feather_mask * rot_patch, 0, 255).astype(np.uint8)
    if HAS_OPENCV:
        edge_band = ((valid_mask > 0.03) & (valid_mask < 0.94)).astype(np.uint8)
        blended_patch = _weighted_boundary_denoise(blended_patch, edge_band, radius=3)
    final_composite[by1:by2, bx1:bx2] = blended_patch
    final_composite = np.clip(final_composite, 0, 255).astype(np.uint8)

    footprint_full = np.zeros((h, w), dtype=bool)
    footprint_full[by1:by2, bx1:bx2] = valid_mask > 0.05
    outside = (full_mask < 0.01) & ~(footprint_full)
    stability = round(float(np.mean(np.isclose(final_composite[outside], img_np[outside], atol=2))), 4) if np.any(outside) else 1.0

    source_pixels = max(int(np.sum(patch_mask > 0.05)), 1)
    transformed_pixels = int(np.sum(valid_mask > 0.05))
    resolved_depth_source = (depth_source or "model") if depth_map is not None else "mask_shape_prior"
    metrics = {
        "mode": "pseudo_3d_object_rotation",
        "render_type": "2.5D; hidden surfaces are not reconstructed",
        "depth_source": resolved_depth_source,
        "projection_model": "perspective_3d_homography",
        "homography_applied": True,
        "target": target or "user_bbox",
        "target_bbox": [int(x1), int(y1), int(x2), int(y2)],
        "mask_type": mask_type,
        "mask_backend": "opencv_grabcut" if mask_type in ("auto", "fullbody", "grabcut") and HAS_OPENCV else ("bbox_rect" if mask_type == "auto" else mask_type),
        "boundary_distance_max": round(d_max, 2),
        "rotation_angles": {"yaw": float(yaw), "pitch": float(pitch), "roll": float(roll)},
        "object_pixels_transformed": transformed_pixels,
        "foreground_retention_ratio": round(transformed_pixels / source_pixels, 4),
        "background_stability_score": stability,
        "disocclusion_ratio": None,
        "disocclusion_status": "not_measured_by_single-image-warp",
    }
    return final_composite, metrics

# Compatibility alias; output remains pseudo-3D, not volumetric reconstruction.
run_volumetric_sphere_3d_rotation = run_bbox_object_pseudo3d_transform


def run_continuous_pseudo3d_parallax(
    img_np: np.ndarray,
    depth_map: np.ndarray,
    azimuth: float = 3.0,
    elevation: float = -1.0,
    dolly: float = 15.0,
    pan: float = 0.0,
    shift_y: float = 0.0,
    depth_layers: int = 16,
    depth_source: str = "model",
    mode: str = "continuous_parallax"
) -> tuple[np.ndarray, dict]:
    """Render explicitly labelled pseudo-3D parallax via projective camera homography + smooth depth field."""
    h, w, _ = img_np.shape
    if depth_map.shape != (h, w):
        raise ValueError("Depth map dimensions do not match input image")
    if depth_layers < 2 or depth_layers > 64:
        raise ValueError("depth_layers must be between 2 and 64")
    raw_depth = np.clip(np.asarray(depth_map, dtype=np.float32), 0.0, 1.0)
    quantized_depth = np.round(raw_depth * (depth_layers - 1)) / float(depth_layers - 1)
    # Soft-blended depth avoids harsh stair-step tearing at silhouettes while preserving layer entropy
    depth = 0.25 * quantized_depth + 0.75 * raw_depth
    if HAS_OPENCV:
        depth = cv2.bilateralFilter((depth * 255.0).astype(np.uint8), 7, 35, 35).astype(np.float32) / 255.0

    y_coords, x_coords = np.indices((h, w), dtype=np.float32)
    cx, cy = w / 2.0, h / 2.0
    focal = float(max(w, h)) * 1.6
    r_az, r_el = math.radians(azimuth), math.radians(elevation)

    # Projective camera rotation homography H = K * R_inv * K_inv modulated by relative depth
    Ry_inv = np.array([[math.cos(-r_az), 0.0, math.sin(-r_az)], [0.0, 1.0, 0.0], [-math.sin(-r_az), 0.0, math.cos(-r_az)]], dtype=np.float32)
    Rx_inv = np.array([[1.0, 0.0, 0.0], [0.0, math.cos(-r_el), -math.sin(-r_el)], [0.0, math.sin(-r_el), math.cos(-r_el)]], dtype=np.float32)
    R_inv = Ry_inv @ Rx_inv
    K = np.array([[focal, 0.0, cx], [0.0, focal, cy], [0.0, 0.0, 1.0]], dtype=np.float32)
    K_inv = np.linalg.inv(K)
    H_rot = K @ R_inv @ K_inv

    homog_w = H_rot[2, 0] * x_coords + H_rot[2, 1] * y_coords + H_rot[2, 2]
    homog_w = np.where(np.abs(homog_w) < 1e-4, 1e-4, homog_w)
    rot_x = (H_rot[0, 0] * x_coords + H_rot[0, 1] * y_coords + H_rot[0, 2]) / homog_w
    rot_y = (H_rot[1, 0] * x_coords + H_rot[1, 1] * y_coords + H_rot[1, 2]) / homog_w

    # Recenter optical axis so camera orbit tilts perspective without pushing head/edges out of frame
    c_w = H_rot[2, 0] * cx + H_rot[2, 1] * cy + H_rot[2, 2]
    c_w = c_w if abs(c_w) >= 1e-4 else 1e-4
    rot_cx = (H_rot[0, 0] * cx + H_rot[0, 1] * cy + H_rot[0, 2]) / c_w
    rot_cy = (H_rot[1, 0] * cx + H_rot[1, 1] * cy + H_rot[1, 2]) / c_w
    homog_dx = (rot_x - x_coords) - (rot_cx - cx)
    homog_dy = (rot_y - y_coords) - (rot_cy - cy)

    orbit_x = (depth - 0.45) * (focal * 0.18 * math.tan(r_az))
    orbit_y = (depth - 0.45) * (focal * 0.18 * math.tan(r_el))
    scale = np.maximum(1.0 + (dolly / 100.0) * depth, 0.05)
    base_x = cx + ((x_coords + homog_dx * depth) - cx) / scale
    base_y = cy + ((y_coords + homog_dy * depth) - cy) / scale
    map_x = (base_x - pan * depth - orbit_x).astype(np.float32)
    map_y = (base_y - shift_y * depth - orbit_y).astype(np.float32)
    flow_x = x_coords - map_x
    flow_y = y_coords - map_y
    valid = (map_x >= 0) & (map_x < w) & (map_y >= 0) & (map_y < h)
    if HAS_OPENCV:
        # 2-pass Z-buffered forward splatting + background-only disocclusion fill + weighted boundary denoise.
        grad_x = cv2.Sobel(depth, cv2.CV_32F, 1, 0, ksize=3)
        grad_y = cv2.Sobel(depth, cv2.CV_32F, 0, 1, ksize=3)
        grad_per_px = np.hypot(grad_x, grad_y) * 0.125
        k_edge = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        local_min_s = cv2.erode(depth, k_edge)
        local_max_s = cv2.dilate(depth, k_edge)
        is_ramp = (
            (local_max_s - local_min_s > 0.20)
            & (grad_per_px > 0.025)
            & (depth > local_min_s + 0.04)
            & (depth < local_max_s - 0.06)
        )

        dst_x = cx + (x_coords + pan * depth + orbit_x - cx) * scale - homog_dx * depth
        dst_y = cy + (y_coords + shift_y * depth + orbit_y - cy) * scale - homog_dy * depth

        canvas_f, has_data, z_grid, _ = _forward_zbuffer_splat(
            img_np, dst_x, dst_y, depth, ~is_ramp, z_tol=0.04
        )
        canvas = np.clip(canvas_f, 0, 255).astype(np.uint8)

        hole_mask = (~has_data).astype(np.uint8)
        boundary_band = hole_mask.copy()
        if np.any(hole_mask):
            # Exclude foreground-depth borders strictly (> local_min_z + 0.035) so midground/gk silhouettes never smear
            z_for_min = np.where(has_data, z_grid, 2.0).astype(np.float32)
            local_min_z = cv2.erode(z_for_min, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (81, 81)))
            near_hole = cv2.dilate(hole_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (45, 45)))
            fg_occluder_edge = (near_hole > 0) & has_data & (z_grid > local_min_z + 0.035)
            telea_mask = ((hole_mask > 0) | fg_occluder_edge).astype(np.uint8)
            filled = cv2.inpaint(canvas, telea_mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
            canvas[hole_mask > 0] = filled[hole_mask > 0]
            hole_rim = cv2.dilate(hole_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))) > 0
            boundary_band = ((hole_mask > 0) | (hole_rim & (grad_per_px > 0.03))).astype(np.uint8)
        canvas = _weighted_boundary_denoise(canvas, boundary_band, radius=4)
    else:
        xs = np.clip(map_x, 0, w - 1)
        ys = np.clip(map_y, 0, h - 1)
        x0, y0 = np.floor(xs).astype(int), np.floor(ys).astype(int)
        x1, y1 = np.clip(x0 + 1, 0, w - 1), np.clip(y0 + 1, 0, h - 1)
        wx, wy = (xs - x0)[:, :, None], (ys - y0)[:, :, None]
        top = img_np[y0, x0] * (1 - wx) + img_np[y0, x1] * wx
        bottom = img_np[y1, x0] * (1 - wx) + img_np[y1, x1] * wx
        canvas = np.clip(top * (1 - wy) + bottom * wy, 0, 255).astype(np.uint8)
    metrics = {
        "mode": "pseudo_3d_parallax",
        "depth_source": depth_source,
        "projection_model": "perspective_3d_homography",
        "homography_applied": True,
        "depth_layers": int(depth_layers),
        "depth_entropy_bits": round(compute_depth_entropy(quantized_depth), 4),
        "mean_flow_pixels": round(float(np.mean(np.hypot(flow_x, flow_y))), 4),
        "out_of_frame_ratio": round(float(np.mean(~valid)), 6),
        "disocclusion_ratio": None,
        "disocclusion_status": "not_measured_by_inverse_warp",
        "camera": {"azimuth": float(azimuth), "elevation": float(elevation), "dolly": float(dolly), "pan": float(pan), "shift_y": float(shift_y)},
    }
    return canvas, metrics


def run_isolated_object_3d_rotation(
    img_np: np.ndarray,
    yaw: float = 20.0,
    pitch: float = 0.0,
    roll: float = 0.0,
    bbox: tuple[int, int, int, int] | None = None,
    target: str | None = None,
    mask_type: str = "auto",
    focal_length: float = 1200.0,
    camera_dist: float = 1200.0,
    inpaint_background: bool = True,
    depth_map: np.ndarray | None = None,
    depth_source: str | None = None,
) -> tuple[np.ndarray, dict]:
    """Apply bbox-constrained pseudo-3D foreground rotation; this is not full 3D reconstruction."""
    if bbox is None:
        raise ValueError("Object-aware rotation requires an explicit bbox [x1,y1,x2,y2]")
    return run_bbox_object_pseudo3d_transform(
        img_np, bbox, yaw=yaw, pitch=pitch, roll=roll,
        target=target or "user_bbox", mask_type=mask_type,
        inpaint_background=inpaint_background, depth_map=depth_map,
        depth_source=depth_source,
    )


def run_depth_parallax(
    img_path: str,
    depth_layers: int = 16,
    dolly: float = 15.0,
    pan: float = 0.0,
    shift_y: float = 0.0,
    mode: str = "continuous_parallax",
    yaw: float = 0.0,
    pitch: float = 0.0,
    roll: float = 0.0,
    bbox: tuple[int, int, int, int] | None = None,
    target: str | None = None,
    mask_type: str = "auto",
    output_path: str | None = None,
    depth_mode: str = "model",
) -> dict:
    if not os.path.isfile(img_path):
        raise FileNotFoundError(f"Input image not found: {img_path}")
    Image.MAX_IMAGE_PIXELS = 16_000_000
    with Image.open(img_path) as source_image:
        if source_image.width * source_image.height > 16_000_000:
            raise ValueError("Input image exceeds the 16 megapixel limit")
        pil_img = source_image.convert("RGB")
    original_size = pil_img.size
    scale_factor = min(1.0, 2048.0 / max(pil_img.size))
    if scale_factor < 1.0:
        pil_img = pil_img.resize((int(pil_img.width * scale_factor), int(pil_img.height * scale_factor)), Image.Resampling.BILINEAR)
    img_np = np.asarray(pil_img, dtype=np.float32)
    scaled_bbox = None
    if bbox is not None:
        scaled_bbox = tuple(int(round(value * scale_factor)) for value in bbox)
    try:
        depth_map, depth_info = estimate_depth_map(img_np, depth_mode)
    except DepthModelUnavailable as exc:
        return {"ok": False, "status": "not_available", "operation": "depth_parallax", "error": str(exc)}
    if mode == "object_3d_rotation" or target is not None:
        final_canvas, metrics = run_isolated_object_3d_rotation(
            img_np, yaw=yaw, pitch=pitch, roll=roll, bbox=scaled_bbox,
            target=target, mask_type=mask_type, depth_map=depth_map,
            depth_source=depth_info["backend"],
        )
    else:
        final_canvas, metrics = run_continuous_pseudo3d_parallax(
            img_np, depth_map=depth_map, azimuth=yaw, elevation=pitch,
            dolly=dolly, pan=pan, shift_y=shift_y, depth_layers=depth_layers,
            depth_source=depth_info["backend"], mode=mode,
        )
    out_pil = Image.fromarray(final_canvas)
    if not output_path:
        fd, output_path = tempfile.mkstemp(prefix="depth-parallax-", suffix=".png")
        os.close(fd)
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    out_pil.save(output_path, format="PNG")
    buf = io.BytesIO()
    out_pil.save(buf, format="PNG")
    return {
        "ok": True,
        "status": "ok",
        "operation": "pseudo_3d_object_transform" if (mode == "object_3d_rotation" or target is not None) else "pseudo_3d_parallax",
        "render_type": "single-image pseudo-3D; hidden surfaces are not reconstructed",
        "input_size": {"width": original_size[0], "height": original_size[1]},
        "depth_backend": depth_info["backend"],
        "depth_mode": depth_mode,
        "layers_count": int(depth_layers),
        "output_path": os.path.abspath(output_path),
        "metrics": metrics,
    }


def run_animate_still(
    img_path: str,
    frames: int = 12,
    fps: int = 12,
    trajectory: str = "orbit",
    mode: str = "continuous_parallax",
    target: str | None = None,
    bbox: tuple[int, int, int, int] | None = None,
    mask_type: str = "auto",
    azimuth_amp: float = 5.0,
    elevation_amp: float = 2.0,
    dolly_amp: float = 15.0,
    pan_amp: float = 10.0,
    output_path: str | None = None,
    depth_mode: str = "model",
) -> dict:
    """
    Renders multi-frame pseudo-3D parallax or object 3D rotation camera trajectories.
    Aligned with docs/plans/rev_tool.md Section 5.2.
    Turns a still image into an N-frame looping sequence along a camera path.
    """
    if not os.path.exists(img_path):
        raise FileNotFoundError(f"Input image not found: {img_path}")

    Image.MAX_IMAGE_PIXELS = 16_000_000
    with Image.open(img_path) as source_image:
        if source_image.width * source_image.height > 16_000_000:
            raise ValueError("Input image exceeds the 16 megapixel limit")
        pil_img = source_image.convert("RGB")
    orig_w, orig_h = pil_img.width, pil_img.height
    scale_factor = 1.0
    if max(orig_w, orig_h) > 1280:
        scale_factor = 1280.0 / max(orig_w, orig_h)
        new_w, new_h = int(orig_w * scale_factor), int(orig_h * scale_factor)
        pil_img = pil_img.resize((new_w, new_h), Image.Resampling.BILINEAR)

    img_np = np.asarray(pil_img, dtype=np.float32)
    try:
        depth_map, depth_info = estimate_depth_map(img_np, depth_mode)
    except DepthModelUnavailable as exc:
        return {"ok": False, "status": "not_available", "operation": "animate_still", "error": str(exc)}

    scaled_bbox = None
    if bbox is not None:
        scaled_bbox = (
            int(round(bbox[0] * scale_factor)),
            int(round(bbox[1] * scale_factor)),
            int(round(bbox[2] * scale_factor)),
            int(round(bbox[3] * scale_factor))
        )

    if fps < 1 or fps > 60:
        raise ValueError("fps must be between 1 and 60")
    frame_list = []
    frames = max(2, min(frames, 60))

    for i in range(frames):
        tau = 2.0 * math.pi * (i / float(frames))
        sin_t = math.sin(tau)
        cos_t = math.cos(tau)

        if trajectory == "orbit":
            azimuth = azimuth_amp * sin_t
            elevation = elevation_amp * cos_t
            dolly = dolly_amp * (0.5 + 0.5 * cos_t)
            pan = pan_amp * sin_t
            yaw_obj = azimuth_amp * sin_t
            pitch_obj = elevation_amp * cos_t
        elif trajectory == "dolly_zoom":
            azimuth = 0.0
            elevation = 0.0
            dolly = dolly_amp * sin_t
            pan = 0.0
            yaw_obj = 0.0
            pitch_obj = 0.0
        elif trajectory == "pan_horizontal":
            azimuth = azimuth_amp * sin_t
            elevation = 0.0
            dolly = 0.0
            pan = pan_amp * sin_t
            yaw_obj = azimuth_amp * sin_t
            pitch_obj = 0.0
        elif trajectory == "tilt_vertical":
            azimuth = 0.0
            elevation = elevation_amp * sin_t
            dolly = 0.0
            pan = 0.0
            yaw_obj = 0.0
            pitch_obj = elevation_amp * sin_t
        elif trajectory == "object_spin":
            azimuth = 0.0
            elevation = 0.0
            dolly = 0.0
            pan = 0.0
            yaw_obj = min(max(azimuth_amp * 4.0, 15.0), 40.0) * sin_t
            pitch_obj = elevation_amp * cos_t
        else:
            azimuth = azimuth_amp * sin_t
            elevation = elevation_amp * cos_t
            dolly = dolly_amp * sin_t
            pan = pan_amp * sin_t
            yaw_obj = azimuth
            pitch_obj = elevation

        if mode == "object_3d_rotation" or target is not None:
            canvas, _ = run_isolated_object_3d_rotation(
                img_np,
                yaw=yaw_obj,
                pitch=pitch_obj,
                roll=0.0,
                bbox=scaled_bbox,
                target=target,
                mask_type=mask_type,
                depth_map=depth_map,
                depth_source=depth_info["backend"],
            )
        else:
            canvas, _ = run_continuous_pseudo3d_parallax(
                img_np,
                depth_map=depth_map,
                depth_source=depth_info["backend"],
                azimuth=azimuth,
                elevation=elevation,
                dolly=dolly,
                pan=pan,
                mode=mode
            )

        frame_list.append(Image.fromarray(canvas))

    if not output_path:
        out_dir = tempfile.gettempdir()
        output_path = os.path.join(out_dir, f"animate_still_{uuid.uuid4().hex[:8]}.gif")

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    frame_list[0].save(
        output_path,
        save_all=True,
        append_images=frame_list[1:],
        duration=int(1000.0 / max(fps, 1)),
        loop=0,
        optimize=True
    )

    with open(output_path, "rb") as f:
        gif_bytes = f.read()
    b64_str = base64.b64encode(gif_bytes).decode("utf-8")

    return {
        "ok": True,
        "operation": "animate_still",
        "mode": mode,
        "trajectory": trajectory,
        "frames_count": len(frame_list),
        "fps": int(fps),
        "duration_sec": round(len(frame_list) / float(fps), 2),
        "output_path": os.path.abspath(output_path),
        "depth_backend": depth_info["backend"],
        "depth_mode": depth_mode,
        "render_type": "single-image pseudo-3D; hidden surfaces are not reconstructed",
        "metrics": {
            "trajectory": trajectory,
            "azimuth_amp": float(azimuth_amp),
            "elevation_amp": float(elevation_amp),
            "dolly_amp": float(dolly_amp),
            "pan_amp": float(pan_amp),
            "fps": int(fps),
            "file_size_bytes": len(gif_bytes)
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Object-Aware 3D Augmentation & Volumetric Pseudo-3D Parallax Engine")
    parser.add_argument("action", nargs="?", default="parallax", help="Optional action positional argument")
    parser.add_argument("--file", required=True, help="Input image file path")
    parser.add_argument("--mode", choices=["continuous_parallax", "scene_parallax", "object_3d_rotation"], default="continuous_parallax")
    parser.add_argument("--target", type=str, default=None, help="Optional label for an object selected by explicit bbox")
    parser.add_argument("--mask-type", choices=["auto", "sphere", "circle", "fullbody", "rect", "grabcut"], default="auto", help="Mask extraction mode")
    parser.add_argument("--depth-layers", type=int, default=16, help="Number of depth layers")
    parser.add_argument("--dolly", type=float, default=15.0, help="Dolly translation in mm")
    parser.add_argument("--pan", type=float, default=0.0, help="Pan translation in pixels")
    parser.add_argument("--shift-y", type=float, default=0.0, help="Vertical tilt/shift")
    parser.add_argument("--yaw", type=float, default=0.0, help="3D object yaw / camera azimuth in degrees")
    parser.add_argument("--pitch", type=float, default=0.0, help="3D object pitch / camera elevation in degrees")
    parser.add_argument("--roll", type=float, default=0.0, help="3D object roll spin in degrees")
    parser.add_argument("--bbox", type=str, default=None, help="Object bounding box x1,y1,x2,y2")
    parser.add_argument("--frames", type=int, default=1, help="Number of animation frames")
    parser.add_argument("--fps", type=int, default=12, help="Frames per second")
    parser.add_argument("--trajectory", choices=["orbit", "dolly_zoom", "pan_horizontal", "tilt_vertical", "object_spin"], default="orbit", help="Camera trajectory")
    parser.add_argument("--azimuth-amp", type=float, default=5.0, help="Azimuth amplitude in degrees")
    parser.add_argument("--elevation-amp", type=float, default=2.0, help="Elevation amplitude in degrees")
    parser.add_argument("--dolly-amp", type=float, default=15.0, help="Dolly amplitude in mm")
    parser.add_argument("--pan-amp", type=float, default=10.0, help="Pan amplitude in pixels")
    parser.add_argument("--output", type=str, default=None, help="Output file path (.png or .gif)")
    parser.add_argument("--depth-mode", choices=["model", "heuristic"], default="model", help="Use local Depth Anything weights, or explicitly opt into heuristic depth")

    args = parser.parse_args()

    parsed_bbox = None
    if args.bbox:
        coords = [int(v.strip()) for v in args.bbox.split(",")]
        if len(coords) == 4:
            parsed_bbox = tuple(coords)

    try:
        if args.action == "animate_still" or args.frames > 1:
            res = run_animate_still(
                img_path=args.file,
                frames=args.frames if args.frames > 1 else 12,
                fps=args.fps,
                trajectory=args.trajectory,
                mode=args.mode,
                target=args.target,
                bbox=parsed_bbox,
                mask_type=args.mask_type,
                azimuth_amp=args.azimuth_amp,
                elevation_amp=args.elevation_amp,
                dolly_amp=args.dolly_amp,
                pan_amp=args.pan_amp,
                output_path=args.output,
                depth_mode=args.depth_mode,
            )
        else:
            res = run_depth_parallax(
                img_path=args.file,
                depth_layers=args.depth_layers,
                dolly=args.dolly,
                pan=args.pan,
                shift_y=args.shift_y,
                mode=args.mode,
                yaw=args.yaw,
                pitch=args.pitch,
                roll=args.roll,
                bbox=parsed_bbox,
                target=args.target,
                mask_type=args.mask_type,
                output_path=args.output,
                depth_mode=args.depth_mode,
            )
        print(json.dumps(res, indent=2))
    except Exception as exc:
        err_res = {"ok": False, "error": str(exc)}
        print(json.dumps(err_res))
        sys.exit(1)


if __name__ == "__main__":
    main()
