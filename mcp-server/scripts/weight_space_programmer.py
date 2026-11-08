#!/usr/bin/env python3
"""
Weight-Space Programmer
Spectral analysis, rank-k attractor ablation, and loop-attractor suppression.
"""
import sys
import os
import json
import struct
import argparse
import numpy as np

try:
    from model_inspector import get_tensor_data, inspect_gguf, resolve_model_path
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        from model_inspector import get_tensor_data, inspect_gguf, resolve_model_path
    except ImportError:
        get_tensor_data = None
        inspect_gguf = None
        resolve_model_path = lambda p: p


def create_synthetic_weight_matrix(dim: int = 64, rank: int = 1, attractor_strength: float = 10.0, seed: int = 42) -> np.ndarray:
    """Plant rank-k attractor in random matrix."""
    rng = np.random.RandomState(seed)
    # Background noise with unit variance scaled by 1/sqrt(dim)
    w_noise = rng.randn(dim, dim).astype(np.float32) / np.sqrt(dim)
    w_attractor = np.zeros((dim, dim), dtype=np.float32)
    for i in range(rank):
        u = rng.randn(dim, 1).astype(np.float32)
        u /= (np.linalg.norm(u) + 1e-12)
        v = rng.randn(dim, 1).astype(np.float32)
        v /= (np.linalg.norm(v) + 1e-12)
        # Attractor strength diminishes slightly per component if rank > 1
        scale = attractor_strength / (i + 1.0)
        w_attractor += scale * (u @ v.T)
    return (w_noise + w_attractor).astype(np.float32)


def inspect_weight_spectrum(weight_matrix: np.ndarray, top_k: int = 10) -> dict:
    """
    SVD and spectral statistics:
    Effective rank, spectral norm, Frobenius norm, condition number, top-k singular values,
    energy concentration (cumulative energy in top 1, 3, 5).
    """
    mat = np.asarray(weight_matrix, dtype=np.float64)
    if mat.ndim != 2:
        mat = mat.reshape(mat.shape[0], -1)

    U, S, Vt = np.linalg.svd(mat, full_matrices=False)
    sum_s = float(np.sum(S))
    if sum_s > 0:
        p = S / sum_s
        H = -float(np.sum(p * np.log(p + 1e-12)))
        erank = float(np.exp(H))
    else:
        erank = 0.0

    spectral_norm = float(S[0]) if len(S) > 0 else 0.0
    frob_norm = float(np.linalg.norm(mat))
    cond_num = float(S[0] / (S[-1] + 1e-12)) if len(S) > 0 else 1.0

    energy = S ** 2
    total_energy = float(np.sum(energy))
    if total_energy > 0:
        top1_energy = float(np.sum(energy[:min(1, len(S))]) / total_energy)
        top3_energy = float(np.sum(energy[:min(3, len(S))]) / total_energy)
        top5_energy = float(np.sum(energy[:min(5, len(S))]) / total_energy)
    else:
        top1_energy, top3_energy, top5_energy = 0.0, 0.0, 0.0

    top_sv = [round(float(v), 6) for v in S[:top_k]]
    energy_dict = {
        "top1": round(top1_energy, 6),
        "top3": round(top3_energy, 6),
        "top5": round(top5_energy, 6)
    }

    return {
        "shape": list(mat.shape),
        "spectral_norm": round(spectral_norm, 6),
        "spectralNorm": round(spectral_norm, 6),
        "frobenius_norm": round(frob_norm, 6),
        "frobeniusNorm": round(frob_norm, 6),
        "condition_number": round(cond_num, 6),
        "conditionNumber": round(cond_num, 6),
        "effective_rank": round(erank, 6),
        "effectiveRank": round(erank, 6),
        "singular_values": top_sv,
        "singularValues": top_sv,
        "energy_concentration": energy_dict,
        "energyConcentration": energy_dict
    }


def ablate_attractor_direction(weight_matrix: np.ndarray, rank: int = 1, alpha: float = 1.0) -> tuple[np.ndarray, dict]:
    """
    SVD ablation of top-k attractor directions:
    delta_W = sum(S[i] * outer(U[:, i], Vt[i, :]) for i in range(rank))
    ablated = weight_matrix - alpha * delta_W
    """
    mat = np.asarray(weight_matrix, dtype=np.float32)
    orig_shape = mat.shape
    if mat.ndim != 2:
        mat_2d = mat.reshape(mat.shape[0], -1)
    else:
        mat_2d = mat

    U, S, Vt = np.linalg.svd(mat_2d, full_matrices=False)
    k = min(rank, len(S))
    delta_W = np.zeros_like(mat_2d)
    ablated_svs = []
    for i in range(k):
        delta_W += float(S[i]) * np.outer(U[:, i], Vt[i, :])
        ablated_svs.append(float(S[i]))

    ablated_2d = mat_2d - (float(alpha) * delta_W)
    ablated = ablated_2d.reshape(orig_shape)

    meta = {
        "rank": rank,
        "alpha": float(alpha),
        "original_frobenius": float(np.linalg.norm(mat_2d)),
        "originalFrobenius": float(np.linalg.norm(mat_2d)),
        "ablated_frobenius": float(np.linalg.norm(ablated_2d)),
        "ablatedFrobenius": float(np.linalg.norm(ablated_2d)),
        "delta_frobenius": float(np.linalg.norm(delta_W)),
        "deltaFrobenius": float(np.linalg.norm(delta_W)),
        "ablated_singular_values": ablated_svs,
        "ablatedSingularValues": ablated_svs
    }
    return ablated, meta


def suppress_loop_attractor(weight_matrix: np.ndarray, loop_token_vec: np.ndarray, alpha: float = 0.5) -> np.ndarray:
    """
    Zero-gradient weight-space steering projection.
    W_steered = weight_matrix - alpha * proj
    Attenuates output activation along loop_token_vec.
    """
    mat = np.asarray(weight_matrix, dtype=np.float32)
    v = np.asarray(loop_token_vec, dtype=np.float32).flatten()
    v_norm = v / (np.linalg.norm(v) + 1e-12)

    orig_shape = mat.shape
    if mat.ndim != 2:
        mat = mat.reshape(mat.shape[0], -1)

    M, N = mat.shape
    if v.size == M:
        # Output space for y = W @ x: project out v_norm from output range
        proj = np.outer(v_norm, v_norm @ mat)
    elif v.size == N:
        # Output space for y = x @ W: project out v_norm from input domain
        proj = np.outer(mat @ v_norm, v_norm)
    else:
        # Dimensionality mismatch fallback: use top singular vector alignment
        U, S, Vt = np.linalg.svd(mat, full_matrices=False)
        v_padded = np.zeros(M, dtype=np.float32)
        v_padded[:min(M, v.size)] = v_norm[:min(M, v.size)]
        proj = np.outer(v_padded, S[0] * Vt[0, :])

    steered = mat - (float(alpha) * proj)
    if orig_shape != mat.shape:
        steered = steered.reshape(orig_shape)
    return steered.astype(weight_matrix.dtype)


def load_safetensors_layer(filepath: str, layer_name: str = None) -> tuple[np.ndarray, dict]:
    """Read layer from SafeTensors header JSON and binary offset buffer."""
    with open(filepath, 'rb') as f:
        header_len_bytes = f.read(8)
        if len(header_len_bytes) < 8:
            raise ValueError("Invalid SafeTensors file: too small for header length")
        header_len = struct.unpack('<Q', header_len_bytes)[0]
        header_bytes = f.read(header_len)
        header = json.loads(header_bytes.decode('utf-8'))

        tensors = {k: v for k, v in header.items() if k != '__metadata__'}
        if not tensors:
            raise KeyError("No tensors found in SafeTensors file")

        target_name = layer_name
        if target_name is None or target_name not in tensors:
            # Pick first matching or first 2D
            for k, info in tensors.items():
                if len(info.get('shape', [])) == 2:
                    target_name = k
                    break
            if target_name is None:
                target_name = next(iter(tensors.keys()))

        info = tensors[target_name]
        shape = info['shape']
        dtype_str = info.get('dtype', 'F32')
        offsets = info['data_offsets']
        start_offset = 8 + header_len + offsets[0]
        byte_len = offsets[1] - offsets[0]

        f.seek(start_offset)
        raw_bytes = f.read(byte_len)

        dtype_map = {
            'F32': np.float32,
            'F16': np.float16,
            'I32': np.int32,
            'I64': np.int64,
            'F64': np.float64
        }
        dt = dtype_map.get(dtype_str, np.float32)
        arr = np.frombuffer(raw_bytes, dtype=dt).reshape(shape).astype(np.float32)
        return arr, {"name": target_name, "shape": shape, "dtype": dtype_str}


def save_safetensors_layer(filepath: str, layer_name: str, tensor: np.ndarray, metadata: dict = None) -> None:
    """Write array to SafeTensors format."""
    arr = np.asarray(tensor, dtype=np.float32)
    raw = arr.tobytes()
    byte_len = len(raw)
    header = {
        layer_name: {
            "dtype": "F32",
            "shape": list(arr.shape),
            "data_offsets": [0, byte_len]
        }
    }
    if metadata:
        header["__metadata__"] = {str(k): str(v) for k, v in metadata.items()}
    h_bytes = json.dumps(header, separators=(',', ':')).encode('utf-8')
    h_len = len(h_bytes)
    os.makedirs(os.path.dirname(os.path.abspath(filepath)) or '.', exist_ok=True)
    with open(filepath, 'wb') as f:
        f.write(struct.pack('<Q', h_len))
        f.write(h_bytes)
        f.write(raw)


def load_model_layer(filepath: str = None, layer_name: str = None, fallback_dim: int = 64) -> tuple[np.ndarray, dict]:
    """Load layer from SafeTensors, GGUF, or generate synthetic."""
    if not filepath or filepath.strip().lower() in ('synthetic', 'none', ''):
        mat = create_synthetic_weight_matrix(dim=fallback_dim, rank=1, attractor_strength=10.0)
        return mat, {"name": "synthetic.attractor.weight", "shape": list(mat.shape), "format": "synthetic"}

    resolved = resolve_model_path(filepath)
    if not os.path.exists(resolved):
        mat = create_synthetic_weight_matrix(dim=fallback_dim, rank=1, attractor_strength=10.0)
        return mat, {"name": "synthetic.fallback.weight", "shape": list(mat.shape), "format": "synthetic"}

    # Check SafeTensors
    if resolved.endswith('.safetensors'):
        arr, info = load_safetensors_layer(resolved, layer_name)
        return arr, {"name": info["name"], "shape": list(arr.shape), "format": "safetensors"}

    # Check GGUF
    if resolved.endswith('.gguf') or open(resolved, 'rb').read(4) == b'GGUF':
        if get_tensor_data and inspect_gguf:
            info = inspect_gguf(resolved)
            target = layer_name
            if not target:
                # Pick first 2D tensor
                for t in info.get('tensors', []):
                    if len(t.get('shape', [])) == 2:
                        target = t['name']
                        break
            if not target and info.get('tensors'):
                target = info['tensors'][0]['name']
            data, tinfo = get_tensor_data(resolved, 'gguf', target)
            return data, {"name": target, "shape": list(data.shape), "format": "gguf"}

    # Check NumPy
    if resolved.endswith('.npy'):
        arr = np.load(resolved).astype(np.float32)
        return arr, {"name": layer_name or os.path.basename(resolved), "shape": list(arr.shape), "format": "numpy"}

    # Default synthetic
    mat = create_synthetic_weight_matrix(dim=fallback_dim, rank=1, attractor_strength=10.0)
    return mat, {"name": "synthetic.weight", "shape": list(mat.shape), "format": "synthetic"}


def run_demo(dim: int = 64, rank: int = 1, alpha: float = 1.0) -> dict:
    """Run end-to-end demonstration of spectrum analysis, attractor ablation, and loop suppression."""
    W = create_synthetic_weight_matrix(dim=dim, rank=rank, attractor_strength=10.0, seed=42)
    orig_spectrum = inspect_weight_spectrum(W, top_k=10)

    ablated_W, ablate_meta = ablate_attractor_direction(W, rank=rank, alpha=alpha)
    ablated_spectrum = inspect_weight_spectrum(ablated_W, top_k=10)

    # Test loop attractor suppression
    rng = np.random.RandomState(42)
    loop_vec = rng.randn(dim).astype(np.float32)
    v_norm = loop_vec / (np.linalg.norm(loop_vec) + 1e-12)

    steer_alpha = 0.6
    steered_W = suppress_loop_attractor(W, loop_vec, alpha=steer_alpha)

    x = rng.randn(dim).astype(np.float32)
    y_orig = W @ x
    y_steered = steered_W @ x

    act_orig = float(np.dot(v_norm, y_orig))
    act_steered = float(np.dot(v_norm, y_steered))
    attenuation = float(1.0 - abs(act_steered) / (abs(act_orig) + 1e-12))

    return {
        "status": "success",
        "demo": {
            "dim": dim,
            "rank": rank,
            "alpha": alpha
        },
        "original_spectrum": orig_spectrum,
        "ablated_spectrum": ablated_spectrum,
        "ablation_metadata": ablate_meta,
        "loop_suppression": {
            "alpha": steer_alpha,
            "act_orig": round(act_orig, 6),
            "act_steered": round(act_steered, 6),
            "attenuation": round(attenuation, 6),
            "attenuated_over_50_pct": bool(attenuation > 0.5)
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Weight Space Programmer")
    subparsers = parser.add_subparsers(dest="command")

    # inspect --file <path> --layer <name>
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--file", type=str, default="synthetic", help="Path to model file or 'synthetic'")
    inspect_parser.add_argument("--layer", type=str, default=None, help="Name of layer to inspect")
    inspect_parser.add_argument("--top-k", type=int, default=10, help="Top k singular values")

    # ablate --file <path> --layer <name> --rank <int> --alpha <float> --output <path>
    ablate_parser = subparsers.add_parser("ablate")
    ablate_parser.add_argument("--file", type=str, default="synthetic", help="Path to model file or 'synthetic'")
    ablate_parser.add_argument("--layer", type=str, default=None, help="Name of layer to ablate")
    ablate_parser.add_argument("--rank", type=int, default=1, help="Rank of attractor direction to ablate")
    ablate_parser.add_argument("--alpha", type=float, default=1.0, help="Ablation strength factor")
    ablate_parser.add_argument("--output", type=str, default=None, help="Output path for ablated tensor")

    # demo --dim 64 --rank 1
    demo_parser = subparsers.add_parser("demo")
    demo_parser.add_argument("--dim", type=int, default=64, help="Matrix dimension")
    demo_parser.add_argument("--rank", type=int, default=1, help="Planted attractor rank")
    demo_parser.add_argument("--alpha", type=float, default=1.0, help="Ablation alpha")

    args = parser.parse_args()

    if args.command == "inspect":
        mat, info = load_model_layer(args.file, args.layer)
        spectrum = inspect_weight_spectrum(mat, top_k=args.top_k)
        res = {
            "status": "success",
            "layer_info": info,
            "spectrum": spectrum
        }
        print(json.dumps(res, indent=2))
    elif args.command == "ablate":
        mat, info = load_model_layer(args.file, args.layer)
        ablated, meta = ablate_attractor_direction(mat, rank=args.rank, alpha=args.alpha)
        if args.output:
            if args.output.endswith('.safetensors'):
                save_safetensors_layer(args.output, info['name'], ablated, {"rank": args.rank, "alpha": args.alpha})
            elif args.output.endswith('.npy'):
                np.save(args.output, ablated)
            else:
                save_safetensors_layer(args.output, info['name'], ablated, {"rank": args.rank, "alpha": args.alpha})
        res = {
            "status": "success",
            "layer_info": info,
            "ablation_metadata": meta,
            "original_spectrum": inspect_weight_spectrum(mat, top_k=5),
            "ablated_spectrum": inspect_weight_spectrum(ablated, top_k=5)
        }
        print(json.dumps(res, indent=2))
    elif args.command == "demo" or args.command is None:
        dim = getattr(args, 'dim', 64)
        rank = getattr(args, 'rank', 1)
        alpha = getattr(args, 'alpha', 1.0)
        res = run_demo(dim=dim, rank=rank, alpha=alpha)
        print(json.dumps(res, indent=2))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
