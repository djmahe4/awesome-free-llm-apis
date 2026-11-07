import os
import struct
import zipfile
import json
import io

def generate_tiny_gguf(filepath):
    # GGUF v3 binary header
    # magic: 'GGUF' (4 bytes), version: 3 (uint32), tensor_count: 2 (uint64), metadata_kv_count: 2 (uint64)
    with open(filepath, 'wb') as f:
        f.write(b'GGUF')
        f.write(struct.pack('<I', 3))
        f.write(struct.pack('<Q', 2))  # 2 tensors
        f.write(struct.pack('<Q', 2))  # 2 metadata pairs

        # KV 1: "general.architecture" = "tiny_transformer"
        key = b'general.architecture'
        f.write(struct.pack('<Q', len(key)))
        f.write(key)
        f.write(struct.pack('<I', 8))  # type STRING
        val = b'tiny_transformer'
        f.write(struct.pack('<Q', len(val)))
        f.write(val)

        # KV 2: "tiny_transformer.context_length" = 512
        key = b'tiny_transformer.context_length'
        f.write(struct.pack('<Q', len(key)))
        f.write(key)
        f.write(struct.pack('<I', 4))  # type UINT32
        f.write(struct.pack('<I', 512))

        # Tensor 1: blk.0.attn_q.weight
        t1_name = b'blk.0.attn_q.weight'
        f.write(struct.pack('<Q', len(t1_name)))
        f.write(t1_name)
        f.write(struct.pack('<I', 2))
        f.write(struct.pack('<Q', 4))
        f.write(struct.pack('<Q', 4))
        f.write(struct.pack('<I', 0))  # GGML_TYPE_F32
        f.write(struct.pack('<Q', 0))  # offset 0

        # Tensor 2: blk.0.ffn_down.weight
        t2_name = b'blk.0.ffn_down.weight'
        f.write(struct.pack('<Q', len(t2_name)))
        f.write(t2_name)
        f.write(struct.pack('<I', 2))
        f.write(struct.pack('<Q', 4))
        f.write(struct.pack('<Q', 4))
        f.write(struct.pack('<I', 0))  # GGML_TYPE_F32
        f.write(struct.pack('<Q', 64)) # offset 64 bytes

        # Pad to 32 bytes alignment
        pos = f.tell()
        pad = (32 - (pos % 32)) % 32
        f.write(b'\x00' * pad)

        # Raw tensor payload: 32 float32 values
        for i in range(32):
            f.write(struct.pack('<f', float(i) * 0.05))

def generate_tiny_pt(filepath):
    # PyTorch checkpoints are ZIP archives containing archive/data.pkl and records
    with zipfile.ZipFile(filepath, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('archive/byteorder', 'little')
        zf.writestr('archive/version', '3')
        import pickle
        meta = {
            'epoch': 14,
            'best_fitness': 0.892,
            'names': {0: 'ball', 1: 'player', 2: 'referee'},
            'task': 'detect',
            'model': None
        }
        zf.writestr('archive/data.pkl', pickle.dumps(meta, protocol=2))
        zf.writestr('archive/data/0', struct.pack('<16f', *[float(x) * 0.1 for x in range(16)]))

def generate_tiny_onnx(filepath):
    # Minimal binary ONNX protobuf model (ModelProto with IR version 8)
    buf = io.BytesIO()
    buf.write(b'\x08\x08')  # ir_version = 8
    p_name = b'model_inspector_test'
    buf.write(b'\x12' + bytes([len(p_name)]) + p_name)
    opset = b'\x10\x11'  # version 17
    buf.write(b'\x42' + bytes([len(opset)]) + opset)
    with open(filepath, 'wb') as f:
        f.write(buf.getvalue())

if __name__ == '__main__':
    out_dir = os.path.join(os.path.dirname(__file__), '../../tests/fixtures/models')
    os.makedirs(out_dir, exist_ok=True)
    generate_tiny_gguf(os.path.join(out_dir, 'tiny.gguf'))
    generate_tiny_pt(os.path.join(out_dir, 'tiny.pt'))
    generate_tiny_onnx(os.path.join(out_dir, 'tiny.onnx'))
    print("Generated model fixtures in", out_dir)
