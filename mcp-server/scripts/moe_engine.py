import sys
import json
import math
import argparse

try:
    import numpy as np
except ImportError:
    print(json.dumps({"error": "NumPy is required for moe_engine but not installed"}), file=sys.stderr)
    sys.exit(1)


def silu(x):
    """Sigmoid Linear Unit activation function."""
    return x / (1.0 + np.exp(-x))


def softmax(x, axis=-1):
    """Numerically stable softmax along specified axis."""
    ex = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return ex / np.sum(ex, axis=axis, keepdims=True)


class MoELayer:
    """
    Mixture-of-Experts layer implementing Top-K gating,
    Switch Transformer auxiliary load-balancing loss,
    and ScaledSwiGLU grouped expert forward propagation (NVIDIA BioNeMo pattern).
    """
    def __init__(self, dim, intermediate_dim, num_experts=4, top_k=2):
        if top_k <= 0 or top_k > num_experts:
            raise ValueError(f"top_k must be between 1 and num_experts ({num_experts}), got {top_k}")
        self.dim = dim
        self.intermediate_dim = intermediate_dim
        self.num_experts = num_experts
        self.top_k = top_k

        # Router / Gating weights
        self.w_gate = np.random.randn(dim, num_experts).astype(np.float32) * (1.0 / math.sqrt(dim))

        # Experts: each expert has gate_proj (w1), up_proj (w3), down_proj (w2) for SwiGLU
        self.expert_w1 = [np.random.randn(dim, intermediate_dim).astype(np.float32) * 0.1 for _ in range(num_experts)]
        self.expert_w3 = [np.random.randn(dim, intermediate_dim).astype(np.float32) * 0.1 for _ in range(num_experts)]
        self.expert_w2 = [np.random.randn(intermediate_dim, dim).astype(np.float32) * 0.1 for _ in range(num_experts)]

    def route(self, x):
        """
        Compute routing logits, top-k expert assignments, and Switch Transformer aux loss.
        aux_loss = num_experts * sum(f_e * P_e)
        """
        # x: [seq_len, dim]
        seq_len = x.shape[0]
        if seq_len <= 0:
            return (
                np.empty((0, self.top_k), dtype=np.int64),
                np.empty((0, self.top_k), dtype=np.float32),
                0.0
            )

        logits = np.matmul(x, self.w_gate)  # [seq_len, num_experts]
        probs = softmax(logits, axis=-1)

        # Top-K selection
        top_k_indices = np.argsort(-probs, axis=-1)[:, :self.top_k]
        top_k_probs = np.take_along_axis(probs, top_k_indices, axis=-1)
        # Renormalize top-k probabilities to sum to 1
        top_k_probs = top_k_probs / np.sum(top_k_probs, axis=-1, keepdims=True)

        # Switch Transformer / Load Balancing Auxiliary Loss
        f = np.zeros(self.num_experts, dtype=np.float32)
        for idx in top_k_indices.flatten():
            f[idx] += 1.0 / (seq_len * self.top_k)
        P = np.mean(probs, axis=0)
        aux_loss = float(self.num_experts * np.sum(f * P))

        return top_k_indices, top_k_probs, aux_loss

    def forward_sequential(self, x):
        """
        Sequential execution applying ScaledSwiGLU per token and expert:
        ScaledSwiGLU(x, g_e) = g_e * (SiLU(x * w1) * (x * w3)) * w2
        """
        top_k_indices, top_k_probs, aux_loss = self.route(x)
        out = np.zeros_like(x)

        for i in range(x.shape[0]):
            token = x[i:i + 1]  # [1, dim]
            for k in range(self.top_k):
                exp_idx = top_k_indices[i, k]
                weight = top_k_probs[i, k]

                w1 = self.expert_w1[exp_idx]
                w3 = self.expert_w3[exp_idx]
                w2 = self.expert_w2[exp_idx]

                # ScaledSwiGLU: router probability multiplied directly into SwiGLU block
                h = silu(np.matmul(token, w1)) * np.matmul(token, w3)
                exp_out = np.matmul(weight * h, w2)
                out[i] += exp_out[0]

        return out, top_k_indices, top_k_probs, aux_loss

    def forward_grouped(self, x):
        """
        Grouped execution: groups tokens per expert and runs fused ScaledSwiGLU GEMM.
        """
        top_k_indices, top_k_probs, aux_loss = self.route(x)
        out = np.zeros_like(x)

        for e in range(self.num_experts):
            mask = (top_k_indices == e)
            token_indices, k_positions = np.where(mask)
            if len(token_indices) == 0:
                continue

            expert_tokens = x[token_indices]  # [N_e, dim]
            expert_weights = top_k_probs[token_indices, k_positions, None]  # [N_e, 1]

            w1 = self.expert_w1[e]
            w3 = self.expert_w3[e]
            w2 = self.expert_w2[e]

            h = silu(np.matmul(expert_tokens, w1)) * np.matmul(expert_tokens, w3)
            expert_out = np.matmul(expert_weights * h, w2)

            for idx, res in zip(token_indices, expert_out):
                out[idx] += res

        return out, top_k_indices, top_k_probs, aux_loss


class MoELayerConfig:
    def __init__(self, dim=8, intermediate_dim=16, num_experts=4, top_k=2):
        self.dim = dim
        self.intermediate_dim = intermediate_dim
        self.num_experts = num_experts
        self.top_k = top_k


def build_sparse_moe_layer(config=None, **kwargs):
    if config is None:
        dim = kwargs.get('dim', 8)
        intermediate_dim = kwargs.get('intermediate_dim', dim * 2)
        num_experts = kwargs.get('num_experts', 4)
        top_k = kwargs.get('top_k', 2)
        config = MoELayerConfig(dim, intermediate_dim, num_experts, top_k)
    return MoELayer(config.dim, config.intermediate_dim, config.num_experts, config.top_k)


def assemble_moe_structure(base_weights=None, num_experts=4):
    """
    Assembles a composite MoE structure from dense FFN weights.
    """
    return {
        'architecture': 'MixtureOfExperts',
        'numExperts': num_experts,
        'experts': [f"expert_{i}" for i in range(num_experts)],
        'gatingWeights': 'router.weight',
        'fusionScheme': 'ScaledSwiGLU'
    }


def main():
    parser = argparse.ArgumentParser(description='Mixture-of-Experts Assembly and Engine')
    parser.add_argument('action', choices=['test_moe', 'assemble'])
    parser.add_argument('--num-experts', type=int, default=4)
    parser.add_argument('--top-k', type=int, default=2)
    parser.add_argument('--dim', type=int, default=8)
    parser.add_argument('--seq-len', type=int, default=4)
    args = parser.parse_args()

    if args.top_k <= 0 or args.top_k > args.num_experts:
        raise ValueError(f"top_k must be between 1 and num_experts ({args.num_experts}), got {args.top_k}")

    if args.action == 'assemble':
        res = assemble_moe_structure(None, num_experts=args.num_experts)
        print(json.dumps(res, indent=2))
        return

    np.random.seed(42)
    x = np.random.randn(args.seq_len, args.dim).astype(np.float32)
    moe = MoELayer(args.dim, args.dim * 2, args.num_experts, args.top_k)

    out_seq, indices, probs, aux_loss = moe.forward_sequential(x)
    out_grp, _, _, _ = moe.forward_grouped(x)

    res = {
        'numExperts': args.num_experts,
        'topK': args.top_k,
        'auxLoss': round(aux_loss, 4),
        'routingProbabilities': [round(float(v), 4) for v in probs.flatten()],
        'groupedExecutionEqual': bool(np.allclose(out_seq, out_grp, atol=1e-5))
    }
    print(json.dumps(res, indent=2))


if __name__ == '__main__':
    main()
