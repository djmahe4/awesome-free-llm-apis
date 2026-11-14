"""
Reads thoughts.jsonl, computes embeddings (sentence-transformers or mock),
groups by expert_label, writes per-expert JSONL shards for MoE fine-tuning.
Usage: python thought_to_moe_dataset.py --input thoughts.jsonl --out-dir dataset/
"""
import argparse, json
from pathlib import Path
from collections import defaultdict


def embed_text(text: str, model=None) -> list:
    if model:
        return model.encode(text).tolist()
    # 16-dim mock fallback
    import hashlib
    h = int(hashlib.md5(text.encode()).hexdigest(), 16)
    return [(h >> i & 0xFF) / 255.0 for i in range(0, 128, 8)]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--out-dir', required=True)
    args = p.parse_args()
    out = Path(args.out_dir); out.mkdir(parents=True, exist_ok=True)

    # Try loading sentence-transformers
    embed_model = None
    try:
        from sentence_transformers import SentenceTransformer
        embed_model = SentenceTransformer('all-MiniLM-L6-v2')
    except ImportError:
        print('sentence-transformers not found — using mock embeddings')

    shards: dict[str, list] = defaultdict(list)
    with open(args.input, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            row['embedding'] = embed_text(row['thought_text'], embed_model)
            shards[row['expert_label']].append(row)

    for label, rows in shards.items():
        shard_path = out / f'expert_{label}.jsonl'
        with open(shard_path, 'w', encoding='utf-8') as sf:
            for r in rows:
                sf.write(json.dumps(r) + '\n')
        print(f'Wrote {len(rows)} rows -> {shard_path}')


if __name__ == '__main__':
    main()
