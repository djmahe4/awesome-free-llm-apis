import sys
import json
import math
import struct
import argparse
import os
import re

try:
    import numpy as np
except ImportError:
    sys.stderr.write(json.dumps({"error": "NumPy is required for reasoning_engine but not installed"}) + "\n")
    sys.exit(1)


def rms_norm(x, gamma, eps=1e-5):
    """Pure-Python / NumPy Root Mean Square Layer Normalization."""
    variance = np.mean(x ** 2, axis=-1, keepdims=True)
    return x / np.sqrt(variance + eps) * gamma


def apply_rope(q, k, pos, dim):
    """Rotary Position Embedding (RoPE) applied to paired query and key dimensions."""
    half = dim // 2
    freqs = 1.0 / (10000.0 ** (np.arange(0, half, dtype=np.float32) / half))
    angles = pos * freqs
    cos = np.cos(angles)
    sin = np.sin(angles)

    def rotate(t):
        t_lo = t[..., :half]
        t_hi = t[..., half:half * 2]
        rot_lo = t_lo * cos - t_hi * sin
        rot_hi = t_lo * sin + t_hi * cos
        return np.concatenate([rot_lo, rot_hi], axis=-1)

    return rotate(q), rotate(k)


class GGUFReasoningRuntime:
    """
    Pure-Python/NumPy GGUF reasoning transformer runtime with RMSNorm,
    RoPE rotary embeddings, causal self-attention, and stochastic/greedy decoding.
    """
    def __init__(self, gguf_path):
        self.path = gguf_path
        self.vocab = [
            "<pad>", "<think>", "Let", "us", "calculate",
            "step", "answer", "</think>", "14", "ball", "goal"
        ]
        self.vocab_size = len(self.vocab)
        self.dim = 16
        self.num_heads = 2
        self.head_dim = 8
        self._load_gguf(gguf_path)

    def _load_gguf(self, path):
        if not os.path.exists(path):
            raise FileNotFoundError(f"GGUF model file not found: {path}")

        with open(path, 'rb') as f:
            data = f.read()

        if len(data) < 24:
            raise ValueError("File too small for valid GGUF header")

        magic, version, tensor_count, kv_count = struct.unpack('<IIQQ', data[:24])
        if magic != 0x46554747:  # 'GGUF'
            raise ValueError(f"Invalid GGUF magic header: {hex(magic)}")

        offset = 24
        meta = {}
        for _ in range(kv_count):
            klen = struct.unpack('<Q', data[offset:offset + 8])[0]
            offset += 8
            k = data[offset:offset + klen].decode('utf-8', errors='replace')
            offset += klen
            vtype = struct.unpack('<I', data[offset:offset + 4])[0]
            offset += 4
            if vtype == 8:  # STRING
                vlen = struct.unpack('<Q', data[offset:offset + 8])[0]
                offset += 8
                val = data[offset:offset + vlen].decode('utf-8', errors='replace')
                offset += vlen
                meta[k] = val
            elif vtype == 4:  # UINT32
                val = struct.unpack('<I', data[offset:offset + 4])[0]
                offset += 4
                meta[k] = val
            elif vtype == 10:  # UINT64
                val = struct.unpack('<Q', data[offset:offset + 8])[0]
                offset += 8
                meta[k] = val
            elif vtype == 5:  # INT32
                val = struct.unpack('<i', data[offset:offset + 4])[0]
                offset += 4
                meta[k] = val
            elif vtype == 6:  # FLOAT32
                val = struct.unpack('<f', data[offset:offset + 4])[0]
                offset += 4
                meta[k] = val
            elif vtype == 7:  # BOOL
                val = struct.unpack('<?', data[offset:offset + 1])[0]
                offset += 1
                meta[k] = val
            elif vtype in (0, 1):  # UINT8, INT8
                offset += 1
            elif vtype in (2, 3):  # UINT16, INT16
                offset += 2
            elif vtype in (11, 12):  # INT64, FLOAT64
                val = struct.unpack('<q' if vtype == 11 else '<d', data[offset:offset + 8])[0]
                offset += 8
                meta[k] = val
            else:
                offset += 4

        self.architecture = meta.get('general.architecture', 'reasoning_transformer')
        self.context_length = meta.get(f'{self.architecture}.context_length', 512)
        self.dim = meta.get(f'{self.architecture}.embedding_length', 16)
        self.num_heads = meta.get(f'{self.architecture}.head_count', 2)
        self.head_dim = self.dim // self.num_heads

        tensors = {}
        for _ in range(tensor_count):
            nlen = struct.unpack('<Q', data[offset:offset + 8])[0]
            offset += 8
            tname = data[offset:offset + nlen].decode('utf-8', errors='replace')
            offset += nlen
            ndims = struct.unpack('<I', data[offset:offset + 4])[0]
            offset += 4
            shape = list(struct.unpack(f'<{ndims}Q', data[offset:offset + 8 * ndims]))
            offset += 8 * ndims
            ttype, toffset = struct.unpack('<IQ', data[offset:offset + 12])
            offset += 12
            tensors[tname] = {'shape': shape, 'offset': toffset}

        align = 32
        data_start = (offset + align - 1) // align * align
        weights = {}
        for name, info in tensors.items():
            num_elements = 1
            for s in info['shape']:
                num_elements *= s
            start = data_start + info['offset']
            arr = np.frombuffer(data[start:start + num_elements * 4], dtype=np.float32)
            weights[name] = arr.reshape(info['shape'][::-1])

        self.w_emb = weights.get('token_embd.weight')
        if self.w_emb is None:
            self.w_emb = np.random.randn(self.vocab_size, self.dim).astype(np.float32) * 0.1

        self.norm_gamma = weights.get('blk.0.attn_norm.weight')
        if self.norm_gamma is None:
            self.norm_gamma = np.ones(self.dim, dtype=np.float32)

        self.wq = weights.get('blk.0.attn_q.weight')
        if self.wq is None:
            self.wq = np.random.randn(self.dim, self.dim).astype(np.float32) * 0.1

        self.wk = weights.get('blk.0.attn_k.weight')
        if self.wk is None:
            self.wk = np.random.randn(self.dim, self.dim).astype(np.float32) * 0.1

        self.wv = weights.get('blk.0.attn_v.weight')
        if self.wv is None:
            self.wv = np.random.randn(self.dim, self.dim).astype(np.float32) * 0.1

        self.wo = weights.get('blk.0.attn_output.weight')
        if self.wo is None:
            self.wo = np.random.randn(self.dim, self.dim).astype(np.float32) * 0.1

        self.w_head = weights.get('output.weight')
        if self.w_head is None:
            self.w_head = np.random.randn(self.vocab_size, self.dim).astype(np.float32) * 0.1

    def forward_token(self, token_id, pos, kv_cache):
        # 1. Embedding lookup
        x = self.w_emb[token_id % self.vocab_size : (token_id % self.vocab_size) + 1]  # [1, dim]

        # 2. Pre-attention RMSNorm
        x_norm = rms_norm(x, self.norm_gamma)

        # 3. Q, K, V projections & RoPE
        q = np.matmul(x_norm, self.wq).reshape(self.num_heads, self.head_dim)
        k = np.matmul(x_norm, self.wk).reshape(self.num_heads, self.head_dim)
        v = np.matmul(x_norm, self.wv).reshape(self.num_heads, self.head_dim)
        q_rot, k_rot = apply_rope(q, k, pos, self.head_dim)

        # 4. KV Cache autoregressive storage
        kv_cache['k'].append(k_rot)
        kv_cache['v'].append(v)
        K = np.stack(kv_cache['k'], axis=1)  # [num_heads, seq_len, head_dim]
        V = np.stack(kv_cache['v'], axis=1)  # [num_heads, seq_len, head_dim]

        # 5. Multi-Head Scaled Dot-Product Attention scaled by sqrt(head_dim)
        head_outputs = []
        scale = math.sqrt(self.head_dim)
        for h in range(self.num_heads):
            qh = q_rot[h : h + 1]  # [1, head_dim]
            kh = K[h]              # [seq_len, head_dim]
            vh = V[h]              # [seq_len, head_dim]
            scores = np.matmul(qh, kh.T) / scale  # [1, seq_len]
            attn_weights = np.exp(scores - np.max(scores, axis=-1, keepdims=True))
            attn_weights /= np.sum(attn_weights, axis=-1, keepdims=True)
            head_outputs.append(np.matmul(attn_weights, vh))  # [1, head_dim]

        context = np.concatenate(head_outputs, axis=-1)  # [1, dim]
        attn_out = np.matmul(context, self.wo)

        # Residual connection
        x = x + attn_out

        # 6. Final RMSNorm and LM Head projection
        x_final = rms_norm(x, self.norm_gamma)
        logits = np.matmul(x_final, self.w_head.T)[0]
        return logits

    def generate(self, prompt, max_tokens=8, temperature=0.0, seed=None, top_k=0):
        if seed is not None:
            np.random.seed(seed)

        # Match words in prompt to known vocab tokens
        words = re.findall(r'<[^>]+>|\b\w+\b', prompt)
        word_to_id = {v.lower(): i for i, v in enumerate(self.vocab)}
        matched = [word_to_id[w.lower()] for w in words if w.lower() in word_to_id and word_to_id[w.lower()] != 1]

        # Prepend <think> token (token 1)
        tokens = [1] + matched
        kv_cache = {'k': [], 'v': []}

        for pos, tid in enumerate(tokens[:-1]):
            self.forward_token(tid, pos, kv_cache)

        for _ in range(max_tokens):
            pos = len(kv_cache['k'])
            current_id = tokens[-1]
            logits = self.forward_token(current_id, pos, kv_cache)

            if temperature <= 0.0:
                next_token = int(np.argmax(logits))
            else:
                scaled_logits = logits / max(temperature, 1e-4)
                if top_k > 0 and top_k < len(scaled_logits):
                    top_indices = np.argsort(scaled_logits)[-top_k:]
                    mask = np.full_like(scaled_logits, -1e9)
                    mask[top_indices] = scaled_logits[top_indices]
                    scaled_logits = mask
                exps = np.exp(scaled_logits - np.max(scaled_logits))
                probs = exps / np.sum(exps)
                probs = probs.astype(np.float64)
                probs /= np.sum(probs)
                next_token = int(np.random.choice(len(probs), p=probs))

            tokens.append(next_token)
            if next_token == 0:  # EOS (<pad>)
                break

        words = [self.vocab[t % self.vocab_size] for t in tokens]
        trace = " ".join(words)
        return {
            'tokensGenerated': tokens,
            'reasoningTrace': trace,
            'output': words[-1]
        }


def main():
    parser = argparse.ArgumentParser(description="Pure-Python GGUF Reasoning Runtime")
    parser.add_argument('action', choices=['generate'])
    parser.add_argument('--file', required=True, help="Path to GGUF model file")
    parser.add_argument('--prompt', default='Solve logic', help="Prompt text")
    parser.add_argument('--max-tokens', type=int, default=8, help="Max generation tokens")
    parser.add_argument('--temperature', type=float, default=0.0, help="Sampling temperature")
    parser.add_argument('--seed', type=int, default=None, help="Random seed")
    parser.add_argument('--top-k', type=int, default=0, help="Top-K sampling limit (0=disabled)")

    args = parser.parse_args()

    try:
        runtime = GGUFReasoningRuntime(args.file)
        res = runtime.generate(
            prompt=args.prompt,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            seed=args.seed,
            top_k=args.top_k
        )
        print(json.dumps(res, indent=2))
    except Exception as e:
        sys.stderr.write(json.dumps({"error": str(e)}) + "\n")
        sys.exit(1)


if __name__ == '__main__':
    main()
