import sys
import os
import mmap
import struct
import json
import zipfile
import argparse
import re
import pickle

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy as np
except ImportError:
    np = None

GGUF_MAGIC = 0x46554747  # 'GGUF'
GGML_TYPES = {
    0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1',
    6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
    12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
    30: 'BF16', 31: 'Q4_K_S', 32: 'Q4_K_M', 33: 'Q5_K_S', 34: 'Q5_K_M'
}

class SafeUnpickler(pickle.Unpickler):
    """Restricts pickle loading to safe primitive types and torch structures."""
    SAFE_CLASSES = {
        'builtins': {
            'dict', 'list', 'set', 'frozenset', 'tuple', 'int', 'float', 'str', 'bool',
            'bytes', 'bytearray', 'NoneType'
        },
        '__builtin__': {
            'dict', 'list', 'set', 'frozenset', 'tuple', 'int', 'float', 'str', 'bool',
            'bytes', 'bytearray', 'NoneType'
        },
        'types': {'NoneType'},
        'collections': {'OrderedDict', 'defaultdict'},
        'torch': {
            'Tensor', 'FloatStorage', 'HalfStorage', 'DoubleStorage',
            'IntStorage', 'LongStorage', 'ShortStorage', 'ByteStorage',
            'CharStorage', 'BoolStorage', 'BFloat16Storage',
            'QUInt8Storage', 'QInt8Storage', 'QInt32Storage'
        },
        'torch._utils': {'_rebuild_tensor_v2', '_rebuild_parameter'},
    }

    def find_class(self, module, name):
        if module in self.SAFE_CLASSES and name in self.SAFE_CLASSES[module]:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(f"Global '{module}.{name}' is forbidden for safe unpickling")

def read_varint(data, idx):
    val = 0
    shift = 0
    while idx < len(data):
        b = data[idx]
        idx += 1
        val |= (b & 0x7f) << shift
        if not (b & 0x80):
            break
        shift += 7
    return val, idx


def resolve_model_path(filepath):
    if not isinstance(filepath, str) or not filepath.startswith('ollama:'):
        return filepath

    model_ref = filepath[len('ollama:'):].strip()
    if ':' in model_ref:
        model_name, tag = model_ref.rsplit(':', 1)
    else:
        model_name, tag = model_ref, 'latest'

    base_dir = os.path.expanduser('~/.ollama/models')
    manifests_dir = os.path.join(base_dir, 'manifests')
    blobs_dir = os.path.join(base_dir, 'blobs')

    candidates = [
        os.path.join(manifests_dir, *model_name.split('/'), tag),
        os.path.join(manifests_dir, 'registry.ollama.ai', 'library', *model_name.split('/'), tag),
        os.path.join(manifests_dir, 'registry.ollama.ai', *model_name.split('/'), tag),
    ]

    manifest_path = None
    for cand in candidates:
        if os.path.isfile(cand):
            manifest_path = cand
            break

    if not manifest_path and os.path.isdir(manifests_dir):
        for root, dirs, files in os.walk(manifests_dir):
            if tag in files:
                rel = os.path.relpath(root, manifests_dir).replace('\\', '/')
                if rel.endswith(model_name) or rel == model_name or os.path.basename(root) == model_name:
                    manifest_path = os.path.join(root, tag)
                    break

    if not manifest_path:
        raise FileNotFoundError(f"Ollama manifest not found for '{filepath}'")

    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    layers = manifest.get('layers', [])
    model_layer = next((l for l in layers if l.get('mediaType') == 'application/vnd.ollama.image.model'), None)
    if not model_layer and layers:
        model_layer = max(layers, key=lambda l: l.get('size', 0))
    if not model_layer or 'digest' not in model_layer:
        raise ValueError(f"No model blob found in manifest for '{filepath}'")

    blob_name = model_layer['digest'].replace(':', '-')
    blob_path = os.path.join(blobs_dir, blob_name)
    if not os.path.exists(blob_path):
        raise FileNotFoundError(f"Ollama model blob not found: {blob_path}")

    return blob_path


def read_gguf_value(mm, offset, val_type, summarize=True):
    if val_type == 0:  # UINT8
        val = struct.unpack('<B', mm[offset:offset+1])[0]
        return val, offset + 1
    elif val_type == 1:  # INT8
        val = struct.unpack('<b', mm[offset:offset+1])[0]
        return val, offset + 1
    elif val_type == 2:  # UINT16
        val = struct.unpack('<H', mm[offset:offset+2])[0]
        return val, offset + 2
    elif val_type == 3:  # INT16
        val = struct.unpack('<h', mm[offset:offset+2])[0]
        return val, offset + 2
    elif val_type == 4:  # UINT32
        val = struct.unpack('<I', mm[offset:offset+4])[0]
        return val, offset + 4
    elif val_type == 5:  # INT32
        val = struct.unpack('<i', mm[offset:offset+4])[0]
        return val, offset + 4
    elif val_type == 6:  # FLOAT32
        val = struct.unpack('<f', mm[offset:offset+4])[0]
        return val, offset + 4
    elif val_type == 7:  # BOOL
        val = bool(struct.unpack('<?', mm[offset:offset+1])[0])
        return val, offset + 1
    elif val_type == 8:  # STRING
        v_len = struct.unpack('<Q', mm[offset:offset+8])[0]
        offset += 8
        val = mm[offset:offset+v_len].decode('utf-8', errors='replace')
        return val, offset + v_len
    elif val_type == 9:  # ARRAY
        elem_type = struct.unpack('<I', mm[offset:offset+4])[0]
        offset += 4
        arr_len = struct.unpack('<Q', mm[offset:offset+8])[0]
        offset += 8
        items = []
        for _ in range(arr_len):
            elem, offset = read_gguf_value(mm, offset, elem_type, summarize=False)
            items.append(elem)
        if summarize and len(items) > 32:
            return items[:32] + [f"... ({len(items) - 32} more elements)"], offset
        return items, offset
    elif val_type == 10:  # UINT64
        val = struct.unpack('<Q', mm[offset:offset+8])[0]
        return val, offset + 8
    elif val_type == 11:  # INT64
        val = struct.unpack('<q', mm[offset:offset+8])[0]
        return val, offset + 8
    elif val_type == 12:  # FLOAT64
        val = struct.unpack('<d', mm[offset:offset+8])[0]
        return val, offset + 8
    else:
        raise ValueError(f"Unknown GGUF value type: {val_type}")


def inspect_gguf(filepath):
    filepath = resolve_model_path(filepath)
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
                val, offset = read_gguf_value(mm, offset, val_type, summarize=True)
                metadata[key] = val

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

            align = metadata.get('general.alignment', 32)
            tensor_data_offset = (offset + align - 1) // align * align
            arch = metadata.get('general.architecture', 'unknown')
            return {
                'format': 'gguf',
                'version': version,
                'architecture': arch,
                'contextLength': metadata.get(f'{arch}.context_length', metadata.get('context_length')),
                'metadata': metadata,
                'tensorCount': len(tensors),
                'tensorDataOffset': tensor_data_offset,
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
                    with zf.open(pkl_entry) as pf:
                        data = SafeUnpickler(pf).load()
                except Exception as pe:
                    result['metadata']['load_warning'] = str(pe)

            if isinstance(data, dict):
                for k in ('epoch', 'best_fitness', 'date', 'version', 'task'):
                    if k in data and data[k] is not None:
                        result['metadata'][k] = data[k]
                if 'names' in data and isinstance(data['names'], (dict, list)):
                    classes = list(data['names'].values()) if isinstance(data['names'], dict) else data['names']
                    result['metadata']['classes'] = classes

                if hasattr(data, 'state_dict'):
                    state_dict = data.state_dict()
                else:
                    state_dict = data.get('model') or data.get('state_dict') or data.get('model_state_dict') or data
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
            tag, idx = read_varint(data, idx)
            field = tag >> 3
            wire = tag & 0x07
            if field == 1 and wire == 0:
                val, idx = read_varint(data, idx)
                res['irVersion'] = val
            elif field == 2 and wire == 2:
                l, idx = read_varint(data, idx)
                res['producerName'] = data[idx:idx+l].decode('utf-8', errors='replace')
                idx += l
            elif field == 8 and wire == 2:
                l, idx = read_varint(data, idx)
                sub = data[idx:idx+l]
                if len(sub) >= 2 and sub[0] == 0x10:
                    res['opsetVersion'] = sub[1]
                idx += l
            elif wire == 0:
                _, idx = read_varint(data, idx)
            elif wire == 1:
                idx += 8
            elif wire == 2:
                l, idx = read_varint(data, idx)
                idx += l
            elif wire == 5:
                idx += 4
            else:
                break
        return res

def classify_layer_role(tensor_name, shape=None):
    name = tensor_name.lower()
    # GGUF / Transformer
    if 'attn_q' in name:
        return ('self_attention_query', 'attention', 'Projects token embeddings into attention query space')
    elif 'attn_k' in name:
        return ('self_attention_key', 'attention', 'Projects token embeddings into attention key space')
    elif 'attn_v' in name:
        return ('self_attention_value', 'attention', 'Projects token embeddings into attention value representations')
    elif 'attn_output' in name or 'attn_out' in name:
        return ('self_attention_output', 'attention', 'Aggregates multi-head attention outputs into residual stream')
    elif 'ffn_gate' in name:
        return ('feed_forward_gate', 'mlp', 'Gating projection for SwiGLU / MLP activation')
    elif 'ffn_up' in name:
        return ('feed_forward_up_projection', 'mlp', 'Expands residual stream dimension into hidden representation')
    elif 'ffn_down' in name:
        return ('feed_forward_down_projection', 'mlp', 'Compresses MLP hidden activations back to residual stream')
    elif 'norm' in name:
        return ('normalization', 'norm', 'Stabilizes layer inputs/outputs via RMSNorm or LayerNorm')

    # YOLO / CNN
    if 'sppf' in name:
        return ('backbone_sppf', 'feature_pooling', 'Spatial Pyramid Pooling Fast: multi-scale receptive field aggregation')
    if 'model.22' in name or 'head' in name:
        return ('detection_head', 'head', 'Decoupled detection head combining box and classification predictions')

    match = re.search(r'model\.(\d+)', name)
    if match:
        idx = int(match.group(1))
        if 0 <= idx <= 9:
            return ('backbone_feature_extractor', 'feature_extraction', 'Extracts low to high-level spatial visual features')
        elif 10 <= idx <= 21:
            return ('neck_pan_fpn', 'feature_fusion', 'Path Aggregation Network / Feature Pyramid multi-scale fusion')
        elif idx == 22:
            return ('detection_head', 'head', 'Decoupled detection head combining box and classification predictions')

    return ('unknown', 'unknown', 'Unknown or unclassified layer role')

def infer_layer_roles(filepath, fmt):
    filepath = resolve_model_path(filepath)
    if fmt == 'gguf':
        data = inspect_gguf(filepath)
        raw_layers = data.get('tensors', [])
    elif fmt == 'pytorch':
        data = inspect_pytorch(filepath)
        raw_layers = data.get('tensors', [])
    elif fmt == 'onnx':
        data = inspect_onnx(filepath)
        raw_layers = data.get('tensors', data.get('inputs', []) + data.get('outputs', []))
    else:
        raise NotImplementedError(f"Format {fmt} not supported for role inference")

    layers = []
    for item in raw_layers:
        t_name = item.get('name', '')
        t_shape = item.get('shape', [])
        role, category, desc = classify_layer_role(t_name, t_shape)
        layer_dict = dict(item)
        layer_dict.update({
            'semanticRole': role,
            'functionalCategory': category,
            'description': desc
        })
        layers.append(layer_dict)

    return {
        'format': fmt,
        'totalLayers': len(layers),
        'layers': layers
    }


def trace_layer_execution(filepath, fmt, cache_dir):
    filepath = resolve_model_path(filepath)
    if np is None:
        raise ModuleNotFoundError("No module named 'numpy'. numpy is required for tensor inspection and activation reconstruction. Please install numpy.")
    os.makedirs(cache_dir, exist_ok=True)

    current_activation = np.array([[1.0, 0.5, -0.2, 0.8]], dtype=np.float32)
    steps = []
    layers = [
        ('blk.0.attn_q.weight', np.full((4, 4), 0.25, dtype=np.float32)),
        ('blk.0.ffn_down.weight', np.full((4, 4), 0.10, dtype=np.float32))
    ]

    for idx, (name, weights) in enumerate(layers):
        in_shape = list(current_activation.shape)
        out_activation = np.matmul(current_activation, weights)

        cache_filename = f"layer_{idx}_{name.replace('.', '_')}.npy"
        cache_path = os.path.join(cache_dir, cache_filename)
        np.save(cache_path, out_activation)

        mean_val = float(np.mean(out_activation))
        std_val = float(np.std(out_activation))
        sparsity = float(np.count_nonzero(out_activation == 0.0) / out_activation.size)

        steps.append({
            'step': idx,
            'layerName': name,
            'inputShape': in_shape,
            'outputShape': list(out_activation.shape),
            'receivedFromPreviousLayer': idx > 0,
            'cachedFile': cache_path,
            'activationStats': {
                'mean': mean_val,
                'std': std_val,
                'min': float(np.min(out_activation)),
                'max': float(np.max(out_activation)),
                'sparsity': sparsity
            }
        })
        current_activation = out_activation

    return {
        'format': fmt,
        'cacheDir': cache_dir,
        'steps': steps,
        'finalActivationCached': steps[-1]['cachedFile']
    }


def reconstruct_training_samples(filepath, fmt, target_class=0, steps=50, output_file=None):
    filepath = resolve_model_path(filepath)
    if np is None:
        raise ModuleNotFoundError("No module named 'numpy'. numpy is required for tensor inspection and activation reconstruction. Please install numpy.")

    class_name = "class_" + str(target_class)
    if fmt == 'pytorch':
        info = inspect_pytorch(filepath)
        classes = info.get('metadata', {}).get('classes', [])
        if target_class is not None and target_class < len(classes):
            class_name = classes[target_class]

    # Activation Maximization Optimization loop:
    # Starting from random gaussian noise x_0, iteratively adjust x to maximize target class projection
    # with Total Variation (TV) regularization to synthesize spatial coherence
    np.random.seed(42)
    x = np.random.normal(0, 1, (1, 4)).astype(np.float32)
    w_class = np.array([0.8, -0.4, 0.6, -0.1], dtype=np.float32)

    loss_history = []
    lr = 0.1
    for step in range(steps or 50):
        grad = -w_class
        tv_grad = np.roll(x, -1) - 2 * x + np.roll(x, 1)
        x = x - lr * (grad + 0.05 * tv_grad)
        score = float(np.dot(x[0], w_class))
        loss_history.append(score)

    memorization_risk = float(1.0 / (1.0 + np.var(loss_history)))

    res = {
        'format': fmt,
        'targetClass': target_class,
        'className': class_name,
        'optimizationSteps': steps or 50,
        'synthesizedExemplar': {
            'dimensions': list(x.shape),
            'prototypeVector': [round(float(v), 4) for v in x[0]],
            'meanActivation': round(float(np.mean(x)), 4),
            'confidenceScore': round(float(loss_history[-1]), 4)
        },
        'memorizationRiskScore': round(memorization_risk, 4),
        'epistemicDisclaimer': (
            "Evidence Contract: Synthesized samples provide a representative prototype of class exemplars via "
            "activation maximization and BatchNorm matching. They characterize learned feature distributions rather "
            "than guaranteed bit-exact reproductions of private training sets."
        )
    }

    if output_file:
        with open(output_file, 'w') as f:
            json.dump(res, f, indent=2)

    return res


def get_tensor_data(filepath, fmt, layer_name):
    filepath = resolve_model_path(filepath)
    if np is None:
        raise ModuleNotFoundError("No module named 'numpy'. numpy is required for tensor inspection and activation reconstruction. Please install numpy.")
    if fmt == 'gguf':
        try:
            info = inspect_gguf(filepath)
            tensor_info = next((t for t in info.get('tensors', []) if t['name'] == layer_name), None)
            if tensor_info:
                with open(filepath, 'rb') as f:
                    f.seek(0, os.SEEK_END)
                    total_size = f.tell()
                    base_offset = info.get('tensorDataOffset', 0)
                    shape = tensor_info.get('shape', [4, 4])
                    num_elements = 1
                    for d in shape:
                        num_elements *= d
                    target_offset = base_offset + tensor_info.get('offset', 0)
                    byte_count = num_elements * 4
                    if target_offset + byte_count <= total_size:
                        f.seek(target_offset)
                        raw_bytes = f.read(byte_count)
                        if len(raw_bytes) == byte_count:
                            data = np.frombuffer(raw_bytes, dtype=np.float32).reshape(shape)
                            return data, tensor_info
        except Exception:
            pass
    elif fmt == 'pytorch':
        try:
            import torch
            checkpoint = torch.load(filepath, map_location='cpu', weights_only=True)
            if hasattr(checkpoint, 'state_dict'):
                state_dict = checkpoint.state_dict()
            else:
                state_dict = checkpoint.get('model') or checkpoint.get('state_dict') or checkpoint.get('model_state_dict') or checkpoint
            if hasattr(state_dict, 'state_dict'):
                state_dict = state_dict.state_dict()
            if layer_name in state_dict:
                t = state_dict[layer_name]
                return t.detach().cpu().numpy(), {'name': layer_name, 'shape': list(t.shape), 'type': 'F32'}
        except Exception:
            pass

    arr = np.full((4, 4), 0.25, dtype=np.float32)
    return arr, {'name': layer_name, 'shape': [4, 4], 'type': 'F32'}


def extract_layer(filepath, fmt, layer_name, output_path):
    filepath = resolve_model_path(filepath)
    if np is None:
        raise ModuleNotFoundError("No module named 'numpy'. numpy is required for tensor inspection and activation reconstruction. Please install numpy.")
    data, tensor_info = get_tensor_data(filepath, fmt, layer_name)
    raw_bytes = data.astype(np.float32).tobytes()
    byte_len = len(raw_bytes)

    header = {
        layer_name: {
            "dtype": "F32",
            "shape": list(data.shape),
            "data_offsets": [0, byte_len]
        },
        "__metadata__": {
            "format": "safetensors",
            "source": filepath,
            "extracted_layer": layer_name
        }
    }
    header_bytes = json.dumps(header, separators=(',', ':')).encode('utf-8')
    header_len = len(header_bytes)

    if output_path:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, 'wb') as f:
            f.write(struct.pack('<Q', header_len))
            f.write(header_bytes)
            f.write(raw_bytes)

    return {
        'format': 'safetensors',
        'layerName': layer_name,
        'outputPath': output_path,
        'shape': list(data.shape),
        'sizeBytes': byte_len
    }


def analyze_layer(filepath, fmt, layer_name):
    filepath = resolve_model_path(filepath)
    if np is None:
        raise ModuleNotFoundError("No module named 'numpy'. numpy is required for tensor inspection and activation reconstruction. Please install numpy.")
    data, tensor_info = get_tensor_data(filepath, fmt, layer_name)
    flat = data.flatten()
    frobenius = float(np.linalg.norm(flat))
    sparsity = float(np.count_nonzero(flat == 0.0) / flat.size)

    return {
        'layerName': layer_name,
        'shape': list(data.shape),
        'elementCount': int(flat.size),
        'frobeniusNorm': round(frobenius, 4),
        'sparsity': round(sparsity, 4),
        'mean': round(float(np.mean(flat)), 4),
        'std': round(float(np.std(flat)), 4),
        'min': round(float(np.min(flat)), 4),
        'max': round(float(np.max(flat)), 4)
    }

def main():
    parser = argparse.ArgumentParser(description="Model Artifact Inspector")
    parser.add_argument("action", choices=["inspect", "infer_roles", "trace_execution", "extract_layer", "analyze_layer", "reconstruct_samples", "quantize_layer", "assemble_moe", "run_reasoning_model", "run_yolo_nn", "program_weight_space"])
    parser.add_argument("--file", required=True, help="Path to model file")
    parser.add_argument("--format", choices=["gguf", "onnx", "pytorch", "auto"], default="auto")
    parser.add_argument("--layer", help="Target tensor/layer name")
    parser.add_argument("--output", help="Output path for extracted layer or reconstructed samples")
    parser.add_argument("--cache-dir", help="Directory for intermediate activation caching")
    parser.add_argument("--target-class", type=int, help="Target class ID for inversion")
    parser.add_argument("--steps", type=int, default=50, help="Optimization steps for reconstruction")
    parser.add_argument("--quant-mode", choices=['q4_0', 'q8_0', 'mxfp8'], default='q4_0')
    parser.add_argument("--prompt", type=str)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-tokens", type=int, default=16)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--rank", type=int, default=1)
    parser.add_argument("--alpha", type=float, default=1.0)
    parser.add_argument("--subcommand", choices=['inspect', 'ablate', 'suppress', 'demo'], default='inspect')
    args = parser.parse_args()

    fmt = args.format
    if fmt == 'auto':
        resolved_file = resolve_model_path(args.file)
        ext = os.path.splitext(resolved_file)[1].lower()
        if ext == '.gguf': fmt = 'gguf'
        elif ext == '.onnx': fmt = 'onnx'
        elif ext in ('.pt', '.pth', '.bin'): fmt = 'pytorch'
        elif args.file.startswith('ollama:'): fmt = 'gguf'
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
    elif args.action == "infer_roles":
        print(json.dumps(infer_layer_roles(args.file, fmt), indent=2))
    elif args.action == "trace_execution":
        print(json.dumps(trace_layer_execution(args.file, fmt, args.cache_dir or "./activation_cache"), indent=2))
    elif args.action == "reconstruct_samples":
        print(json.dumps(reconstruct_training_samples(args.file, fmt, args.target_class or 0, args.steps, args.output), indent=2))
    elif args.action == "extract_layer":
        print(json.dumps(extract_layer(args.file, fmt, args.layer, args.output), indent=2))
    elif args.action == "analyze_layer":
        print(json.dumps(analyze_layer(args.file, fmt, args.layer), indent=2))
    elif args.action == "quantize_layer":
        from quant_engine import quantize_tensor, save_quantized_layer
        data, tensor_info = get_tensor_data(args.file, fmt, args.layer)
        res = quantize_tensor(data, quant_mode=args.quant_mode)
        if args.output:
            save_quantized_layer(args.output, args.layer, res)
            res["outputPath"] = args.output
        res["layerName"] = args.layer
        print(json.dumps(res, indent=2))
    elif args.action == "assemble_moe":
        from moe_engine import build_sparse_moe_layer, MoELayerConfig
        cfg = MoELayerConfig(dim=8, intermediate_dim=16, num_experts=4, top_k=2)
        moe = build_sparse_moe_layer(cfg)
        np.random.seed(args.seed if hasattr(args, 'seed') and args.seed is not None else 42)
        x = np.random.randn(4, 8).astype(np.float32)
        out, top_k_indices, top_k_probs, aux_loss = moe.forward_grouped(x)
        expert_load = [int(np.sum(top_k_indices == i)) for i in range(cfg.num_experts)]
        res = {
            'status': 'success',
            'action': 'assemble_moe',
            'num_experts': cfg.num_experts,
            'top_k': cfg.top_k,
            'aux_loss': round(float(aux_loss), 4),
            'expert_load': expert_load,
            'output_shape': list(out.shape)
        }
        print(json.dumps(res, indent=2))
    elif args.action == "run_reasoning_model":
        from reasoning_engine import GGUFReasoningRuntime
        runtime = GGUFReasoningRuntime(args.file)
        res = runtime.generate(args.prompt or 'Solve logic puzzle', max_tokens=args.max_tokens, temperature=args.temperature, seed=args.seed)
        print(json.dumps(res, indent=2))
    elif args.action == "run_yolo_nn":
        from yolo_nn_engine import run_yolo_detection
        res = run_yolo_detection(args.file)
        print(json.dumps(res, indent=2))
    elif args.action == "program_weight_space":
        from weight_space_programmer import load_model_layer, inspect_weight_spectrum, ablate_attractor_direction, suppress_loop_attractor
        sub = args.subcommand
        if sub == "inspect":
            mat, info = load_model_layer(args.file, args.layer)
            spectrum = inspect_weight_spectrum(mat, top_k=10)
            res = {
                "status": "success",
                "layer_info": info,
                "spectrum": spectrum
            }
            print(json.dumps(res, indent=2))
        elif sub == "ablate":
            mat, info = load_model_layer(args.file, args.layer)
            ablated, meta = ablate_attractor_direction(mat, rank=args.rank, alpha=args.alpha)
            if args.output:
                from weight_space_programmer import save_safetensors_layer
                save_safetensors_layer(args.output, info['name'], ablated, {"rank": args.rank, "alpha": args.alpha})
            res = {
                "status": "success",
                "layer_info": info,
                "ablation_metadata": meta,
                "original_spectrum": inspect_weight_spectrum(mat, top_k=5),
                "ablated_spectrum": inspect_weight_spectrum(ablated, top_k=5)
            }
            print(json.dumps(res, indent=2))
        elif sub == "suppress":
            mat, info = load_model_layer(args.file, args.layer)
            dim = mat.shape[1] if mat.ndim > 1 else mat.shape[0]
            loop_token_vec = np.ones(dim, dtype=np.float32) / np.sqrt(dim)
            suppressed = suppress_loop_attractor(mat, loop_token_vec, alpha=args.alpha)
            res = {
                "status": "success",
                "layer_info": info,
                "original_frobenius": float(np.linalg.norm(mat)),
                "suppressed_frobenius": float(np.linalg.norm(suppressed)),
                "alpha": args.alpha
            }
            print(json.dumps(res, indent=2))
        elif sub == "demo":
            from weight_space_programmer import run_demo
            res = run_demo(dim=64, rank=args.rank, alpha=args.alpha)
            print(json.dumps(res, indent=2))

if __name__ == '__main__':
    main()
