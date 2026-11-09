#!/usr/bin/env python3
"""Pure-NumPy scene augmentation engine for ML Learning Studio.

Actions: augment_scene
Flags:   --file <image>  --operation {min_pool,max_pool,avg_pool,gaussian_smooth,laplacian_sharpen}
         --kernel-size N  --strides N  --intensity F  --seed N  --output <png>

Emits a single JSON object on stdout. Deltas are computed on float32 pixel
values in range [0, 255]; elapsed_ms measures only the NumPy compute phase
(after imports and image loading) so it reflects engine warmth, not process
spawn cost.
"""
import argparse
import json
import os
import sys
import time

try:
    import numpy as np
except ImportError:
    sys.stderr.write("Error: NumPy is required for scene_augmentation.py\n")
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("Error: Pillow is required for scene_augmentation.py\n")
    sys.exit(1)

POOL_OPS = ("min_pool", "max_pool", "avg_pool")
ALL_OPS = POOL_OPS + ("gaussian_smooth", "laplacian_sharpen")


def _shift_add_axis(arr, k1d, axis):
    """Separable 1-D convolution on `axis` of (H, W, C) via shifted weighted adds."""
    n = len(k1d)
    r = n // 2
    pad = [(0, 0), (0, 0), (0, 0)]
    pad[axis] = (r, r)
    padded = np.pad(arr, pad, mode="edge")
    core = arr.shape[axis]
    sl_slices = [slice(None), slice(None), slice(None)]
    out = np.zeros_like(arr, dtype=np.float32)
    for i in range(n):
        sl = list(sl_slices)
        sl[axis] = slice(i, i + core)
        out += k1d[i] * padded[tuple(sl)]
    return out


def gaussian_kernel1d(size, sigma):
    x = np.arange(size, dtype=np.float32) - (size - 1) / 2.0
    k = np.exp(-(x ** 2) / (2.0 * sigma ** 2))
    k /= k.sum()
    return k.astype(np.float32)


def gaussian_smooth(arr, kernel, intensity):
    half = max(1, kernel // 2)
    size = 2 * half + 1
    sigma = max(0.6, kernel * 0.4 * max(0.25, intensity))
    k1d = gaussian_kernel1d(size, sigma)
    out = _shift_add_axis(arr, k1d, axis=0)
    out = _shift_add_axis(out, k1d, axis=1)
    return out


def pooling(arr, kernel, strides, mode):
    """Pool via elementwise reduce over kernel*kernel strided offset views.

    Each view strips window offset (a, b); combining views with
    maximum/minimum/mean per-element yields the same result as windowed
    pooling but avoids materializing a windowed strided tensor, which is
    dramatically faster on large images.
    """
    h, w = arr.shape[:2]
    out_h = (h - kernel) // strides + 1
    out_w = (w - kernel) // strides + 1
    views = []
    for a in range(kernel):
        rows = arr[a:a + out_h * strides:strides]
        for b in range(kernel):
            views.append(rows[:, b:b + out_w * strides:strides])
    if mode == "max":
        return np.maximum.reduce(views), out_h, out_w
    if mode == "min":
        return np.minimum.reduce(views), out_h, out_w
    return np.add.reduce(views) / float(kernel * kernel), out_h, out_w


def center_samples(arr, kernel, strides, out_h, out_w):
    off = (kernel - 1) // 2
    return arr[off:off + out_h * strides:strides,
               off:off + out_w * strides:strides]


def augment_scene(args):
    input_path = args.file
    if not os.path.isfile(input_path):
        sys.stderr.write("Error: file not found: %s\n" % input_path)
        sys.exit(2)

    operation = args.operation
    if operation not in ALL_OPS:
        sys.stderr.write(
            "Unsupported operation: %s (expected one of %s)\n"
            % (operation, ", ".join(ALL_OPS))
        )
        sys.exit(2)

    img = Image.open(input_path).convert("RGB")
    arr = np.asarray(img, dtype=np.float32)
    H0, W0, C = arr.shape
    # Start the compute clock only once the image is decoded into a NumPy array.
    t0 = time.perf_counter()

    if operation in POOL_OPS:
        kernel, strides = args.kernel_size, args.strides
        if kernel < 1 or strides < 1:
            sys.stderr.write("Error: kernel-size and strides must be >= 1\n")
            sys.exit(2)
        if H0 < kernel or W0 < kernel:
            sys.stderr.write(
                "Error: kernel-size %d too large for image %dx%d\n" % (kernel, W0, H0)
            )
            sys.exit(2)
        avg_pool, outH, outW = pooling(arr, kernel, strides, "avg")
        mode = operation.split("_")[0]
        pool_result, _, _ = pooling(arr, kernel, strides, mode)
        centers = center_samples(arr, kernel, strides, outH, outW)
        deltas = {
            "max_vs_avg": float(np.mean(pool_result - avg_pool)) if mode == "max" else 0.0,
            "min_vs_avg": float(np.mean(pool_result - avg_pool)) if mode == "min" else 0.0,
            "avg_center_dev": float(np.mean(np.abs(avg_pool - centers))),
            "smooth_delta": 0.0,
            "edge_delta": 0.0,
        }
        result_arr = pool_result
        keywords = [operation, "pooling", "scene_augmentation"]
    else:
        intensity = args.intensity if args.intensity is not None else 0.5
        half = max(1, args.kernel_size // 2)
        size = 2 * half + 1
        sigma = max(0.6, args.kernel_size * 0.4 * max(0.25, intensity))
        k1d = gaussian_kernel1d(size, sigma)
        if operation == "gaussian_smooth":
            smoothed = _shift_add_axis(_shift_add_axis(arr, k1d, axis=0), k1d, axis=1)
            result_arr = smoothed
            deltas = {
                "max_vs_avg": 0.0,
                "min_vs_avg": 0.0,
                "avg_center_dev": 0.0,
                "smooth_delta": float(np.mean(np.abs(arr - smoothed))),
                "edge_delta": 0.0,
            }
            keywords = [operation, "gaussian", "smoothing", "scene_augmentation"]
        else:  # laplacian_sharpen (unsharp masking on a Gaussian estimate)
            smoothed = _shift_add_axis(_shift_add_axis(arr, k1d, axis=0), k1d, axis=1)
            high_pass = arr - smoothed
            result_arr = arr + intensity * high_pass
            deltas = {
                "max_vs_avg": 0.0,
                "min_vs_avg": 0.0,
                "avg_center_dev": 0.0,
                "smooth_delta": float(np.mean(np.abs(high_pass))),
                "edge_delta": float(np.mean(np.abs(result_arr - arr))),
            }
            keywords = [operation, "laplacian", "sharpening", "scene_augmentation"]

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 3)

    result = {
        "ok": True,
        "operation": operation,
        "input": {"width": W0, "height": H0, "channels": C},
        "output": {"width": int(result_arr.shape[1]), "height": int(result_arr.shape[0])},
        "deltas": deltas,
        "keywords": keywords,
        "elapsed_ms": elapsed_ms,
    }

    if args.output:
        out_abs = os.path.abspath(args.output)
        out_dir = os.path.dirname(out_abs)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        out_img = Image.fromarray(np.clip(result_arr, 0.0, 255.0).astype(np.uint8))
        out_img.save(out_abs, format="PNG")
        result["output_path"] = out_abs

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


def main():
    parser = argparse.ArgumentParser(
        prog="scene_augmentation.py",
        description="Pure-NumPy scene augmentation engine (pooling / smoothing / sharpening).",
    )
    parser.add_argument("actions", nargs="*", help="Action to run, e.g. augment_scene")
    parser.add_argument("--file", required=True, help="Path to the input image")
    parser.add_argument(
        "--operation",
        default="avg_pool",
        help="Augmentation operation: %s" % ", ".join(ALL_OPS),
    )
    parser.add_argument("--kernel-size", type=int, default=2)
    parser.add_argument("--strides", type=int, default=2)
    parser.add_argument("--intensity", type=float, default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--output", default=None, help="Optional PNG output path")
    args = parser.parse_args()

    if "augment_scene" not in args.actions:
        sys.stderr.write(
            "Unsupported action: %s (expected: augment_scene)\n" % " ".join(args.actions)
        )
        sys.exit(2)

    augment_scene(args)


if __name__ == "__main__":
    main()
