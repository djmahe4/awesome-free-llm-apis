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

def generate_reasoning_gguf(filepath):
    # GGUF v3 binary header
    # magic: 'GGUF' (4 bytes), version: 3 (uint32), tensor_count: 7 (uint64), metadata_kv_count: 4 (uint64)
    with open(filepath, 'wb') as f:
        f.write(b'GGUF')
        f.write(struct.pack('<I', 3))
        f.write(struct.pack('<Q', 7))  # 7 tensors
        f.write(struct.pack('<Q', 4))  # 4 metadata pairs

        def write_kv_str(k, v):
            k_b = k.encode('utf-8')
            f.write(struct.pack('<Q', len(k_b)))
            f.write(k_b)
            f.write(struct.pack('<I', 8))  # type STRING
            v_b = v.encode('utf-8')
            f.write(struct.pack('<Q', len(v_b)))
            f.write(v_b)

        def write_kv_u32(k, v):
            k_b = k.encode('utf-8')
            f.write(struct.pack('<Q', len(k_b)))
            f.write(k_b)
            f.write(struct.pack('<I', 4))  # type UINT32
            f.write(struct.pack('<I', v))

        # KV 1: "general.architecture" = "reasoning_transformer"
        write_kv_str('general.architecture', 'reasoning_transformer')

        # KV 2: "reasoning_transformer.context_length" = 512
        write_kv_u32('reasoning_transformer.context_length', 512)

        # KV 3: "reasoning_transformer.embedding_length" = 16
        write_kv_u32('reasoning_transformer.embedding_length', 16)

        # KV 4: "reasoning_transformer.head_count" = 2
        write_kv_u32('reasoning_transformer.head_count', 2)

        tensor_specs = [
            ('token_embd.weight', [16, 14]),
            ('blk.0.attn_norm.weight', [16]),
            ('blk.0.attn_q.weight', [16, 16]),
            ('blk.0.attn_k.weight', [16, 16]),
            ('blk.0.attn_v.weight', [16, 16]),
            ('blk.0.attn_output.weight', [16, 16]),
            ('output.weight', [16, 14]),
        ]

        current_offset = 0
        tensor_info = []
        for name, shape in tensor_specs:
            num_elements = 1
            for d in shape:
                num_elements *= d
            current_offset = ((current_offset + 31) // 32) * 32
            tensor_info.append((name, shape, num_elements, current_offset))
            current_offset += num_elements * 4

        for name, shape, num_elements, offset in tensor_info:
            n_b = name.encode('utf-8')
            f.write(struct.pack('<Q', len(n_b)))
            f.write(n_b)
            f.write(struct.pack('<I', len(shape)))
            for d in shape:
                f.write(struct.pack('<Q', d))
            f.write(struct.pack('<I', 0))  # GGML_TYPE_F32
            f.write(struct.pack('<Q', offset))

        pos = f.tell()
        pad = (32 - (pos % 32)) % 32
        f.write(b'\x00' * pad)

        data_start = f.tell()
        for name, shape, num_elements, offset in tensor_info:
            target_pos = data_start + offset
            pad_len = target_pos - f.tell()
            if pad_len > 0:
                f.write(b'\x00' * pad_len)
            for i in range(num_elements):
                val = ((i % 17) - 8) * 0.05
                f.write(struct.pack('<f', val))

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

def generate_tiny_resnet_pt(filepath):
    with zipfile.ZipFile(filepath, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('archive/byteorder', 'little')
        zf.writestr('archive/version', '3')
        import pickle
        meta = {
            'epoch': 25,
            'arch': 'resnet18',
            'family': 'resnet',
            'task': 'classify',
            'names': {0: 'tench', 1: 'goldfish', 2: 'great_white_shark'},
            'state_dict': {
                'conv1.weight': [64, 3, 7, 7],
                'layer1.0.conv1.weight': [64, 64, 3, 3],
                'fc.weight': [3, 512],
            }
        }
        zf.writestr('archive/data.pkl', pickle.dumps(meta, protocol=2))
        zf.writestr('archive/data/0', struct.pack('<16f', *[float(x) * 0.05 for x in range(16)]))

def generate_tiny_mobilenet_pt(filepath):
    with zipfile.ZipFile(filepath, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('archive/byteorder', 'little')
        zf.writestr('archive/version', '3')
        import pickle
        meta = {
            'epoch': 30,
            'arch': 'mobilenet_v2',
            'family': 'mobilenet',
            'task': 'classify',
            'names': {0: 'cat', 1: 'dog', 2: 'bird'},
            'state_dict': {
                'features.0.0.weight': [32, 3, 3, 3],
                'features.1.conv.0.0.weight': [32, 1, 3, 3],
                'classifier.1.weight': [3, 1280],
            }
        }
        zf.writestr('archive/data.pkl', pickle.dumps(meta, protocol=2))
        zf.writestr('archive/data/0', struct.pack('<16f', *[float(x) * 0.02 for x in range(16)]))

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

def generate_tiny_yolo_onnx(filepath):
    # Minimal binary ONNX with Ultralytics producer and YOLO metadata
    buf = io.BytesIO()
    buf.write(b'\x08\x08')  # ir_version = 8
    p_name = b'ultralytics YOLOv8'
    buf.write(b'\x12' + bytes([len(p_name)]) + p_name)
    names_json = b'{"0": "player", "1": "ball"}'
    task_str = b'detect'
    # Field 14 is metadata_props
    entry1 = bytes([0x0a, 5]) + b'names' + bytes([0x12, len(names_json)]) + names_json
    entry2 = bytes([0x0a, 4]) + b'task' + bytes([0x12, len(task_str)]) + task_str
    buf.write(bytes([0x72, len(entry1)]) + entry1)
    buf.write(bytes([0x72, len(entry2)]) + entry2)
    with open(filepath, 'wb') as f:
        f.write(buf.getvalue())

if __name__ == '__main__':
    out_dir = os.path.join(os.path.dirname(__file__), '../../tests/fixtures/models')
    os.makedirs(out_dir, exist_ok=True)
    generate_tiny_gguf(os.path.join(out_dir, 'tiny.gguf'))
    generate_reasoning_gguf(os.path.join(out_dir, 'reasoning_tiny.gguf'))
    generate_tiny_pt(os.path.join(out_dir, 'tiny.pt'))
    generate_tiny_resnet_pt(os.path.join(out_dir, 'tiny_resnet.pt'))
    generate_tiny_mobilenet_pt(os.path.join(out_dir, 'tiny_mobilenet.pt'))
    generate_tiny_onnx(os.path.join(out_dir, 'tiny.onnx'))
    generate_tiny_yolo_onnx(os.path.join(out_dir, 'tiny_yolo.onnx'))
    print("Generated model fixtures in", out_dir)
