import sys
import os
import json
import struct
import math
import argparse

try:
    import numpy as np
except ImportError:
    print(json.dumps({"error": "NumPy is required for quant_engine but not installed"}))
    sys.exit(1)


def quantize_q4_0(data_f32):
    """
    Q4_0 block quantization (32 values per block).
    Header: float16 scale (2 bytes).
    Payload: 16 bytes (32 x 4-bit signed nibbles in excess-8 format, two nibbles per byte).
    """
    flat = np.asarray(data_f32, dtype=np.float32).flatten()
    orig_len = len(flat)
    n_blocks = (orig_len + 31) // 32
    padded_len = n_blocks * 32
    if orig_len < padded_len:
        flat = np.pad(flat, (0, padded_len - orig_len))

    blocks = []
    dequantized = np.zeros(padded_len, dtype=np.float32)

    for b in range(n_blocks):
        chunk = flat[b * 32 : (b + 1) * 32]
        amax = float(np.max(np.abs(chunk)))
        scale = amax / -8.0 if amax != 0 else 0.0
        id_scale = 1.0 / scale if scale != 0 else 0.0

        nibbles = []
        for x in chunk:
            q = int(round(x * id_scale))
            q = max(-8, min(7, q))
            nibbles.append(q)

        # Pack into 16 bytes (two nibbles per byte: low nibble chunk[0..15], high nibble chunk[16..31])
        packed_bytes = bytearray(16)
        for i in range(16):
            lo = (nibbles[i] + 8) & 0x0F
            hi = ((nibbles[i + 16] + 8) & 0x0F) << 4
            packed_bytes[i] = lo | hi

        # Unpack and dequantize for verification: val = (nibble - 8) * scale
        for i in range(16):
            lo = packed_bytes[i] & 0x0F
            hi = (packed_bytes[i] >> 4) & 0x0F
            dequantized[b * 32 + i] = (lo - 8) * scale
            dequantized[b * 32 + i + 16] = (hi - 8) * scale

        blocks.append({
            "scale": float(scale),
            "bytes": list(packed_bytes)
        })

    rel_error = float(np.linalg.norm(flat - dequantized) / (np.linalg.norm(flat) + 1e-8))
    return {
        "type": "Q4_0",
        "blockSize": 32,
        "totalBlocks": n_blocks,
        "relativeError": rel_error,
        "blocks": blocks,
        "dequantized": dequantized[:orig_len].tolist()
    }


def quantize_q8_0(data_f32):
    """
    Q8_0 block quantization (32 values per block).
    Header: float16 scale (2 bytes).
    Payload: 32 x 8-bit signed ints.
    """
    flat = np.asarray(data_f32, dtype=np.float32).flatten()
    orig_len = len(flat)
    n_blocks = (orig_len + 31) // 32
    padded_len = n_blocks * 32
    if orig_len < padded_len:
        flat = np.pad(flat, (0, padded_len - orig_len))

    dequantized = np.zeros(padded_len, dtype=np.float32)
    blocks = []

    for b in range(n_blocks):
        chunk = flat[b * 32 : (b + 1) * 32]
        amax = float(np.max(np.abs(chunk)))
        scale = float(np.float16(amax / 127.0)) if amax != 0 else 0.0
        id_scale = 1.0 / scale if scale != 0 else 0.0

        q_bytes = np.clip(np.round(chunk * id_scale), -128, 127).astype(np.int8)
        dequantized[b * 32 : (b + 1) * 32] = q_bytes.astype(np.float32) * scale

        blocks.append({
            "scale": float(scale),
            "bytes": q_bytes.tolist()
        })

    rel_error = float(np.linalg.norm(flat - dequantized) / (np.linalg.norm(flat) + 1e-8))
    return {
        "type": "Q8_0",
        "blockSize": 32,
        "totalBlocks": n_blocks,
        "relativeError": rel_error,
        "blocks": blocks,
        "dequantized": dequantized[:orig_len].tolist()
    }


def _get_e4m3_tables():
    """Generates unique real values and corresponding byte encoding for FP8 E4M3 format."""
    entries = []
    for b in range(256):
        sign = -1.0 if (b & 0x80) else 1.0
        exp = (b >> 3) & 0x0F
        mant = b & 0x07
        if exp == 0:
            val = sign * (mant / 8.0) * (2.0 ** (-6))
        elif exp == 15 and mant == 7:
            continue  # NaN in E4M3 (0x7F, 0xFF)
        else:
            val = sign * (1.0 + mant / 8.0) * (2.0 ** (exp - 7))
        entries.append((float(val), b))

    entries.sort(key=lambda x: (x[0], x[1]))
    unique_entries = []
    seen = set()
    for val, b in entries:
        if val not in seen:
            seen.add(val)
            unique_entries.append((val, b))
    unique_entries.sort(key=lambda x: x[0])
    vals = np.array([x[0] for x in unique_entries], dtype=np.float32)
    bytes_arr = np.array([x[1] for x in unique_entries], dtype=np.uint8)
    return vals, bytes_arr


_E4M3_VALS, _E4M3_BYTES = _get_e4m3_tables()


def quantize_mxfp8(data_f32):
    """
    MXFP8 Microscaling format (32 values share an 8-bit E8M0 scale exponent).
    Simulates E4M3 quantization with OCP MXFP8 8-bit power-of-2 shared exponent.
    """
    flat = np.asarray(data_f32, dtype=np.float32).flatten()
    orig_len = len(flat)
    n_blocks = (orig_len + 31) // 32
    padded_len = n_blocks * 32
    if orig_len < padded_len:
        flat = np.pad(flat, (0, padded_len - orig_len))

    dequantized = np.zeros(padded_len, dtype=np.float32)
    scales = []
    blocks = []

    for b in range(n_blocks):
        chunk = flat[b * 32 : (b + 1) * 32]
        amax = float(np.max(np.abs(chunk)))
        if amax > 0:
            exp = int(math.ceil(math.log2(amax / 448.0)))
            # Clamp exponent to 8-bit range [-127, 127] (E8M0 with bias 127)
            exp = max(-127, min(127, exp))
        else:
            exp = -127
        scale = 2.0 ** exp

        scales.append(exp + 127)  # Store 8-bit unsigned scale

        scaled_chunk = chunk / scale
        # Map to nearest FP8 E4M3 value
        idx = np.searchsorted(_E4M3_VALS, scaled_chunk)
        idx = np.clip(idx, 0, len(_E4M3_VALS) - 1)
        prev_idx = np.clip(idx - 1, 0, len(_E4M3_VALS) - 1)
        choose_prev = np.abs(scaled_chunk - _E4M3_VALS[prev_idx]) < np.abs(scaled_chunk - _E4M3_VALS[idx])
        final_idx = np.where(choose_prev, prev_idx, idx)

        q_sim = _E4M3_VALS[final_idx]
        q_bytes = _E4M3_BYTES[final_idx]
        dequantized[b * 32 : (b + 1) * 32] = q_sim * scale

        blocks.append({
            "scale": float(scale),
            "e8m0_scale": int(exp + 127),
            "bytes": q_bytes.tolist()
        })

    rel_error = float(np.linalg.norm(flat - dequantized) / (np.linalg.norm(flat) + 1e-8))
    return {
        "type": "MXFP8",
        "blockSize": 32,
        "totalBlocks": n_blocks,
        "scaleBits": 8,
        "scales": scales,
        "blocks": blocks,
        "bytes": [int(x) for blk in blocks for x in blk["bytes"]],
        "relativeError": rel_error,
        "dequantized": dequantized[:orig_len].tolist()
    }


def quantize_tensor(tensor_data, quant_mode="q4_0"):
    mode = str(quant_mode).lower().replace("-", "_")
    if mode in ("q4_0", "q4"):
        return quantize_q4_0(tensor_data)
    elif mode in ("q8_0", "q8"):
        return quantize_q8_0(tensor_data)
    elif mode in ("mxfp8", "fp8"):
        return quantize_mxfp8(tensor_data)
    else:
        raise ValueError(f"Unknown quant mode: {quant_mode}")


def save_quantized_layer(output_path, layer_name, quant_res):
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({
            "layer": layer_name,
            "quantization": quant_res
        }, f, indent=2)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Quantization and dequantization engine")
    parser.add_argument("action", choices=["test_quant"], help="Action to execute")
    parser.add_argument("--type", choices=["Q4_0", "Q8_0", "MXFP8"], default="Q4_0", help="Quantization format")
    parser.add_argument("--elements", type=int, default=64, help="Number of elements")
    args = parser.parse_args()

    np.random.seed(42)
    sample_data = np.random.randn(args.elements).astype(np.float32)

    if args.type == "Q4_0":
        res = quantize_q4_0(sample_data)
    elif args.type == "Q8_0":
        res = quantize_q8_0(sample_data)
    elif args.type == "MXFP8":
        res = quantize_mxfp8(sample_data)
    else:
        raise ValueError(f"Unknown quantization type: {args.type}")

    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
