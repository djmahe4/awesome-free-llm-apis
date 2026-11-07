import sys
import os
import mmap
import struct
import json
import zipfile
import argparse

GGUF_MAGIC = 0x46554747  # 'GGUF'
GGML_TYPES = {
    0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1',
    6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
    12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K'
}

def inspect_gguf(filepath):
    with open(filepath, 'rb') as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            if len(mm) < 24:
                raise ValueError("File too small for GGUF")
            magic, version, tensor_count, kv_count = struct.unpack('<IIQQ', mm[:24])
            if magic != GGUF_MAGIC:
                raise ValueError(f"Invalid GGUF magic: {hex(magic)}")

            offset = 24
            metadata = {}
            for _ in range(kv_count):
                key_len = struct.unpack('<Q', mm[offset:offset+8])[0]
                offset += 8
                key = mm[offset:offset+key_len].decode('utf-8', errors='replace')
                offset += key_len
                val_type = struct.unpack('<I', mm[offset:offset+4])[0]
                offset += 4

                if val_type == 8:  # STRING
                    v_len = struct.unpack('<Q', mm[offset:offset+8])[0]
                    offset += 8
                    val = mm[offset:offset+v_len].decode('utf-8', errors='replace')
                    offset += v_len
                    metadata[key] = val
                elif val_type in (4, 5):  # UINT32, INT32
                    val = struct.unpack('<I', mm[offset:offset+4])[0]
                    offset += 4
                    metadata[key] = val
                elif val_type in (10, 11):  # UINT64, INT64
                    val = struct.unpack('<Q', mm[offset:offset+8])[0]
                    offset += 8
                    metadata[key] = val
                elif val_type == 6:  # FLOAT32
                    val = struct.unpack('<f', mm[offset:offset+4])[0]
                    offset += 4
                    metadata[key] = val
                else:
                    offset += 4

            tensors = []
            for _ in range(tensor_count):
                name_len = struct.unpack('<Q', mm[offset:offset+8])[0]
                offset += 8
                name = mm[offset:offset+name_len].decode('utf-8', errors='replace')
                offset += name_len
                n_dims = struct.unpack('<I', mm[offset:offset+4])[0]
                offset += 4
                dims = struct.unpack(f'<{n_dims}Q', mm[offset:offset+8*n_dims])
                offset += 8 * n_dims
                t_type, t_offset = struct.unpack('<IQ', mm[offset:offset+12])
                offset += 12
                tensors.append({
                    'name': name,
                    'shape': list(dims),
                    'type': GGML_TYPES.get(t_type, f'UNKNOWN_{t_type}'),
                    'offset': t_offset
                })

            arch = metadata.get('general.architecture', 'unknown')
            return {
                'format': 'gguf',
                'version': version,
                'architecture': arch,
                'contextLength': metadata.get(f'{arch}.context_length', metadata.get('context_length')),
                'metadata': metadata,
                'tensorCount': len(tensors),
                'tensors': tensors
            }
        finally:
            mm.close()

def inspect_pytorch(filepath):
    is_zip = zipfile.is_zipfile(filepath)
    if not is_zip:
        raise ValueError("Legacy uncompressed PyTorch pickles not supported for safety; ZIP checkpoint required")

    result = {
        'format': 'pytorch',
        'isZipContainer': True,
        'fileSizeBytes': os.path.getsize(filepath),
        'metadata': {},
        'tensorCount': 0,
        'tensors': []
    }

    with zipfile.ZipFile(filepath, 'r') as zf:
        infolist = zf.infolist()
        result['records'] = [{'name': info.filename, 'size': info.file_size} for info in infolist]

        # Extract archive/data.pkl safely
        pkl_entry = next((info.filename for info in infolist if info.filename.endswith('data.pkl')), None)
        if pkl_entry:
            data = None
            try:
                import torch
                data = torch.load(filepath, map_location='cpu', weights_only=True, mmap=True)
            except Exception:
                try:
                    import pickle
                    with zf.open(pkl_entry) as pf:
                        data = pickle.load(pf)
                except Exception as pe:
                    result['metadata']['load_warning'] = str(pe)

            if isinstance(data, dict):
                for k in ('epoch', 'best_fitness', 'date', 'version', 'task'):
                    if k in data and data[k] is not None:
                        result['metadata'][k] = data[k]
                if 'names' in data and isinstance(data['names'], (dict, list)):
                    classes = list(data['names'].values()) if isinstance(data['names'], dict) else data['names']
                    result['metadata']['classes'] = classes

                state_dict = data.get('model', data)
                if hasattr(state_dict, 'state_dict'):
                    state_dict = state_dict.state_dict()
                if isinstance(state_dict, dict):
                    result['tensorCount'] = len(state_dict)
                    for name, tensor in list(state_dict.items())[:50]:
                        if hasattr(tensor, 'shape'):
                            result['tensors'].append({
                                'name': str(name),
                                'shape': list(tensor.shape),
                                'dtype': str(tensor.dtype).replace('torch.', '')
                            })

    return result

def inspect_onnx(filepath):
    try:
        import onnx
        model = onnx.load(filepath, load_external_data=False)
        op_counts = {}
        for node in model.graph.node:
            op_counts[node.op_type] = op_counts.get(node.op_type, 0) + 1

        return {
            'format': 'onnx',
            'irVersion': model.ir_version,
            'producerName': model.producer_name,
            'producerVersion': model.producer_version,
            'opsetVersion': model.opset_import[0].version if model.opset_import else None,
            'nodeCount': len(model.graph.node),
            'operatorCounts': op_counts,
            'inputs': [{'name': i.name} for i in model.graph.input],
            'outputs': [{'name': o.name} for o in model.graph.output],
            'initializerCount': len(model.graph.initializer)
        }
    except Exception:
        with open(filepath, 'rb') as f:
            data = f.read()
        res = {'format': 'onnx', 'irVersion': None, 'producerName': None, 'opsetVersion': None}
        idx = 0
        while idx < len(data):
            tag = data[idx]
            field = tag >> 3
            wire = tag & 0x07
            idx += 1
            if field == 1 and wire == 0:
                val = 0
                shift = 0
                while True:
                    b = data[idx]
                    idx += 1
                    val |= (b & 0x7f) << shift
                    if not (b & 0x80): break
                    shift += 7
                res['irVersion'] = val
            elif field == 2 and wire == 2:
                l = data[idx]; idx += 1
                res['producerName'] = data[idx:idx+l].decode('utf-8', errors='replace')
                idx += l
            elif field == 8 and wire == 2:
                l = data[idx]; idx += 1
                sub = data[idx:idx+l]
                if len(sub) >= 2 and sub[0] == 0x10:
                    res['opsetVersion'] = sub[1]
                idx += l
            else:
                break
        return res

def main():
    parser = argparse.ArgumentParser(description="Model Artifact Inspector")
    parser.add_argument("action", choices=["inspect", "infer_roles", "trace_execution", "extract_layer", "analyze_layer", "reconstruct_samples"])
    parser.add_argument("--file", required=True, help="Path to model file")
    parser.add_argument("--format", choices=["gguf", "onnx", "pytorch", "auto"], default="auto")
    parser.add_argument("--layer", help="Target tensor/layer name")
    parser.add_argument("--output", help="Output path for extracted layer or reconstructed samples")
    parser.add_argument("--cache-dir", help="Directory for intermediate activation caching")
    parser.add_argument("--target-class", type=int, help="Target class ID for inversion")
    parser.add_argument("--steps", type=int, default=50, help="Optimization steps for reconstruction")
    args = parser.parse_args()

    fmt = args.format
    if fmt == 'auto':
        ext = os.path.splitext(args.file)[1].lower()
        if ext == '.gguf': fmt = 'gguf'
        elif ext == '.onnx': fmt = 'onnx'
        elif ext in ('.pt', '.pth', '.bin'): fmt = 'pytorch'
        else: fmt = 'unknown'

    if args.action == "inspect":
        if fmt == 'gguf':
            print(json.dumps(inspect_gguf(args.file), indent=2))
        elif fmt == 'pytorch':
            print(json.dumps(inspect_pytorch(args.file), indent=2))
        elif fmt == 'onnx':
            print(json.dumps(inspect_onnx(args.file), indent=2))
        else:
            raise NotImplementedError(f"Format {fmt} not yet implemented")

if __name__ == '__main__':
    main()
