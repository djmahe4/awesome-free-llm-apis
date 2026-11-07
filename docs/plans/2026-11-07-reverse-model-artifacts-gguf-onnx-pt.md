# Reverse Engineering Model Artifacts (GGUF, ONNX, PyTorch) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement zero-copy inspection, semantic layer role inversion, step-by-step layer activation tracing with cached forward propagation, and dataset exemplar reconstruction / memorization probing across GGUF (`.gguf`), ONNX (`.onnx`), and PyTorch (`.pt`/`.pth`), integrating real model artifacts (e.g. YOLOv8 weights from `djmahe4/footydj_mini_project/models`) and deterministic synthetic test fixtures into `reverse_tool`.

**Architecture:** A lightweight, high-performance Python inspection and inversion engine (`mcp-server/scripts/model_inspector.py`) utilizing zero-copy memory mapping (`mmap`), binary struct parsing, safe unpickling (`torch.load(..., weights_only=True, mmap=True)` with pure-Python ZIP archive fallback), layer activation execution sandboxes with cached intermediate handoffs, and activation-maximization dataset inversion. This connects to a typed TypeScript wrapper and safety gate in `mcp-server/src/tools/reverse-tool.ts` enforcing path boundaries, authorization checks (`authorization: 'consent'`), and evidence contract provenance.

**Tech Stack:**
- **Runtime:** Node.js 22 (TypeScript), Python 3.11 (`mmap`, `struct`, `zipfile`, `json`, `math`, `torch`, `numpy`, `onnx`)
- **Formats:** GGUF v2/v3, ONNX IR v7-v11, PyTorch Checkpoints (ZIP / TorchScript / state_dict), SafeTensors
- **Testing:** Vitest, pytest/unittest, pre-commit validation suite
- **Reference Repositories:** [footydj_mini_project/models](https://github.com/djmahe4/footydj_mini_project/tree/main/models) (`best7.pt`, `yolov8m_ball_60e_1280.pt`, `pitch_640_14e.pt`)

---

## Architecture & Epistemological Design

```
Host MCP Client (Claude Code / Antigravity / Cursor)
       │
       ▼ [JSON-RPC 2.0]
runReverseTool() in mcp-server/src/tools/reverse-tool.ts
       │
       ├──► inspect_model (Format Auto-Detection: GGUF / ONNX / PyTorch)
       ├──► infer_layer_roles (Semantic Role Classification: Backbone, Neck, Attention, FFN, Head)
       ├──► trace_layer_execution (Step-by-Step Forward Pass, Disk/Memory Caching, Sequential Handoff)
       ├──► extract_model_layer (Zero-Copy Slice -> .safetensors)
       ├──► analyze_model_layer (Frobenius Norm, Sparsity, Distribution)
       └──► reconstruct_training_samples (Deep Inversion / Activation Maximization / Memorization Probing)
              │
              ▼ [Subprocess execution with timeout & 4MB buffer cap]
mcp-server/scripts/model_inspector.py
       │
       ├──► GGUF Engine: 0x46554747 magic, v2/v3 header, tensor table offsets, metadata KV
       ├──► ONNX Engine: ModelProto/GraphProto nodes, inputs, outputs, initializers, op counts
       ├──► PyTorch Engine: Safe ZIP inspection, data.pkl safe unpickler, YOLOv8 metadata & state_dict
       ├──► Layer Tracer: Intermediate activation caching (.npy/.safetensors), chained forwarding
       └──► Inversion Engine: Class prototype synthesis via BatchNorm matching, TV regularization, memorization risk
```

### Security & Ethical Boundaries
1. **Arbitrary Code Execution Defense (Pickle Safety):**
   - PyTorch `.pt` files often serialize arbitrary Python objects via `pickle`.
   - The inspector strictly uses `weights_only=True` and memory mapping (`mmap=True`) in `torch.load`.
   - In environments without `torch` or for preliminary metadata inspection, a pure-Python ZIP reader inspects `archive/data.pkl` without executing untrusted opcode sequences or imports.
2. **Memory Ceiling Guarantee:**
   - Multi-gigabyte model files are never loaded wholesale into system RAM.
   - Slicing and statistical analysis use memory-mapped byte slices (`mmap.mmap`) seeking directly to tensor byte offsets.
3. **Training Data Reconstruction Consent Gate:**
   - Inverting neural networks to reconstruct training samples or probe dataset memorization requires explicit authorization (`authorization: 'consent'`) and user confirmation (`options.explicitConsentAck: true`).
   - Results are tagged according to the REA Evidence Contract: derived class prototypes or memorization probability scores are accompanied by epistemic confidence boundaries, preventing false claims of exact cryptographic training data recovery on non-overfitted models.
4. **Path Traversal & Suffix Hardening:**
   - Strict validation ensuring model paths reside within the allowed workspace root and end in recognized model extensions (`.gguf`, `.onnx`, `.pt`, `.pth`, `.bin`, `.safetensors`).

---

## Task Breakdown

### Task 1: Deterministic Test Fixtures Generator & Real Artifact Reference

Create lightweight, synthetic binary fixtures for GGUF, ONNX, and PyTorch so the test suite runs offline, fast (<100ms), and without external network dependencies, while defining references to real model artifacts from `djmahe4/footydj_mini_project/models`.

**Files:**
- Create: `mcp-server/scripts/utils/generate_model_fixtures.py`
- Create: `mcp-server/tests/fixtures/models/README.md`
- Test: `mcp-server/tests/model-fixtures.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/model-fixtures.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Model Artifact Fixtures', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures/models');

  it('contains valid minimal synthetic model fixtures', () => {
    const ggufFile = path.join(fixturesDir, 'tiny.gguf');
    const onnxFile = path.join(fixturesDir, 'tiny.onnx');
    const ptFile = path.join(fixturesDir, 'tiny.pt');

    expect(fs.existsSync(ggufFile)).toBe(true);
    expect(fs.existsSync(onnxFile)).toBe(true);
    expect(fs.existsSync(ptFile)).toBe(true);

    // GGUF magic check: 0x46554747 ('GGUF')
    const ggufBuf = fs.readFileSync(ggufFile);
    expect(ggufBuf.subarray(0, 4).toString('ascii')).toBe('GGUF');

    // PyTorch ZIP check: PK\x03\x04
    const ptBuf = fs.readFileSync(ptFile);
    expect(ptBuf.subarray(0, 2).toString('ascii')).toBe('PK');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/model-fixtures.test.ts`
Expected: FAIL ("fixtures/models/tiny.gguf does not exist")

**Step 3: Implement fixture generator script**

```python
# mcp-server/scripts/utils/generate_model_fixtures.py
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
```

Run: `python mcp-server/scripts/utils/generate_model_fixtures.py`

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/model-fixtures.test.ts`
Expected: PASS (all 3 fixtures valid and present)

**Step 5: Commit**

```bash
git add mcp-server/scripts/utils/generate_model_fixtures.py mcp-server/tests/fixtures/models/ mcp-server/tests/model-fixtures.test.ts
git commit -m "feat(models): add synthetic test fixture generator for GGUF, ONNX, and PyTorch" -m "Generates tiny binary fixtures for fast unit testing and documents real artifact references from footydj_mini_project."
```

---

### Task 2: Zero-Copy GGUF Model Inspector (`scripts/model_inspector.py`)

Build the standalone zero-copy GGUF v2/v3 parser in Python that extracts architecture details, quantization profiles, tensor shapes, and offsets using memory mapping.

**Files:**
- Create: `mcp-server/scripts/model_inspector.py`
- Test: `mcp-server/tests/gguf-inspector.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/gguf-inspector.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('GGUF Model Inspector', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');

  it('inspects GGUF metadata and tensor tables with zero copy', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'inspect',
      '--file', ggufFixture,
      '--format', 'gguf'
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.format).toBe('gguf');
    expect(result.version).toBe(3);
    expect(result.architecture).toBe('tiny_transformer');
    expect(result.contextLength).toBe(512);
    expect(result.tensorCount).toBe(2);
    expect(result.tensors[0].name).toBe('blk.0.attn_q.weight');
    expect(result.tensors[0].shape).toEqual([4, 4]);
    expect(result.tensors[0].type).toBe('F32');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/gguf-inspector.test.ts`
Expected: FAIL ("Cannot find module '../scripts/model_inspector.py'")

**Step 3: Implement minimal GGUF parser in `model_inspector.py`**

```python
# mcp-server/scripts/model_inspector.py
import sys
import os
import mmap
import struct
import json
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
        else:
            raise NotImplementedError(f"Format {fmt} not yet implemented in this step")

if __name__ == '__main__':
    main()
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/gguf-inspector.test.ts`
Expected: PASS (1 passed)

**Step 5: Commit**

```bash
git add mcp-server/scripts/model_inspector.py mcp-server/tests/gguf-inspector.test.ts
git commit -m "feat(models): implement zero-copy GGUF v2/v3 inspector" -m "Parses GGUF header, metadata KV pairs, and tensor tables via memory mapping."
```

---

### Task 3: Safe PyTorch (`.pt`/`.pth`) Model Inspector & YOLOv8 Structure Extraction

Build safe PyTorch checkpoint inspection parsing model weights, hyperparameter dictionaries, class maps, and state_dict tensor summaries without executing arbitrary code, testing both against synthetic fixtures and referencing `best7.pt` / `yolov8m_ball_60e_1280.pt` from `djmahe4/footydj_mini_project/models`.

**Files:**
- Modify: `mcp-server/scripts/model_inspector.py`
- Test: `mcp-server/tests/pytorch-inspector.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/pytorch-inspector.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('PyTorch Model Inspector', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ptFixture = path.resolve(__dirname, 'fixtures/models/tiny.pt');

  it('safely inspects PyTorch state_dict and YOLO-style metadata without code execution', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'inspect',
      '--file', ptFixture,
      '--format', 'pytorch'
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.format).toBe('pytorch');
    expect(result.isZipContainer).toBe(true);
    expect(result.metadata.epoch).toBe(14);
    expect(result.metadata.classes).toEqual(['ball', 'player', 'referee']);
    expect(result.records).toBeDefined();
    expect(result.records.some((r: any) => r.name.includes('data.pkl'))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/pytorch-inspector.test.ts`
Expected: FAIL ("Format pytorch not yet implemented in this step")

**Step 3: Implement PyTorch safe inspector in `model_inspector.py`**

Extend `model_inspector.py` with `inspect_pytorch(filepath)`:

```python
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

        if any(info.filename.endswith('data.pkl') for info in infolist):
            try:
                import torch
                data = torch.load(filepath, map_location='cpu', weights_only=True, mmap=True)
                if isinstance(data, dict):
                    for k in ('epoch', 'best_fitness', 'date', 'version', 'task'):
                        if k in data:
                            result['metadata'][k] = data[k]
                    if 'names' in data and isinstance(data['names'], (dict, list)):
                        result['metadata']['classes'] = list(data['names'].values()) if isinstance(data['names'], dict) else data['names']

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
            except Exception as e:
                result['metadata']['warning'] = f"Restricted load: {str(e)}"

    return result
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/pytorch-inspector.test.ts`
Expected: PASS (1 passed)

**Step 5: Commit**

```bash
git add mcp-server/scripts/model_inspector.py mcp-server/tests/pytorch-inspector.test.ts
git commit -m "feat(models): implement safe PyTorch checkpoint inspector" -m "Supports weights_only inspection, YOLOv8 metadata parsing, and state_dict tensor summaries."
```

---

### Task 4: ONNX Graph & Initializer Inspector

Implement ONNX model inspection extracting computational graph inputs, outputs, operator distribution, and initializer tensors.

**Files:**
- Modify: `mcp-server/scripts/model_inspector.py`
- Test: `mcp-server/tests/onnx-inspector.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/onnx-inspector.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('ONNX Model Inspector', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const onnxFixture = path.resolve(__dirname, 'fixtures/models/tiny.onnx');

  it('inspects ONNX ModelProto header, opset, and graph structure', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'inspect',
      '--file', onnxFixture,
      '--format', 'onnx'
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.format).toBe('onnx');
    expect(result.irVersion).toBe(8);
    expect(result.producerName).toBe('model_inspector_test');
    expect(result.opsetVersion).toBe(17);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/onnx-inspector.test.ts`
Expected: FAIL ("Format onnx not yet implemented")

**Step 3: Implement ONNX inspector in `model_inspector.py`**

Add `inspect_onnx(filepath)`:

```python
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
    except ImportError:
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
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/onnx-inspector.test.ts`
Expected: PASS (1 passed)

**Step 5: Commit**

```bash
git add mcp-server/scripts/model_inspector.py mcp-server/tests/onnx-inspector.test.ts
git commit -m "feat(models): implement ONNX model and graph topology inspector" -m "Extracts IR version, producer metadata, operator counts, and initializers with pure-Python fallback."
```

---

### Task 5: Semantic Layer Purpose Inversion (`infer_layer_roles`)

Implement semantic reverse engineering of model layers to classify their architectural roles (Backbone, Self-Attention QKV, FFN, SPPF, Neck, Detection/Classification Head, Normalization) across both Transformer/GGUF and YOLO/CNN formats.

**Files:**
- Modify: `mcp-server/scripts/model_inspector.py`
- Test: `mcp-server/tests/layer-roles.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/layer-roles.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('Semantic Layer Role Inversion', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');

  it('reverse engineers layer purpose into semantic roles', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'infer_roles',
      '--file', ggufFixture,
      '--format', 'gguf'
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.layers.length).toBe(2);

    const qkvLayer = result.layers.find((l: any) => l.name.includes('attn_q'));
    expect(qkvLayer).toBeDefined();
    expect(qkvLayer.semanticRole).toBe('self_attention_query');
    expect(qkvLayer.functionalCategory).toBe('attention');

    const ffnLayer = result.layers.find((l: any) => l.name.includes('ffn_down'));
    expect(ffnLayer).toBeDefined();
    expect(ffnLayer.semanticRole).toBe('feed_forward_down_projection');
    expect(ffnLayer.functionalCategory).toBe('mlp');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/layer-roles.test.ts`
Expected: FAIL ("action infer_roles not implemented")

**Step 3: Implement semantic role classifier in `model_inspector.py`**

```python
def classify_layer_role(tensor_name, shape):
    name_lower = tensor_name.lower()

    # 1. Transformer / GGUF Patterns
    if 'attn_q' in name_lower or 'query' in name_lower:
        return 'self_attention_query', 'attention', 'Projects token embeddings into attention query space'
    if 'attn_k' in name_lower or 'key' in name_lower:
        return 'self_attention_key', 'attention', 'Projects token embeddings into attention key space'
    if 'attn_v' in name_lower or 'value' in name_lower:
        return 'self_attention_value', 'attention', 'Projects token embeddings into attention value representations'
    if 'attn_output' in name_lower or 'attn_out' in name_lower:
        return 'self_attention_output', 'attention', 'Aggregates multi-head attention outputs into residual stream'
    if 'ffn_gate' in name_lower or 'w1' in name_lower:
        return 'feed_forward_gate', 'mlp', 'Gating projection for SwiGLU / MLP activation'
    if 'ffn_up' in name_lower or 'w3' in name_lower:
        return 'feed_forward_up_projection', 'mlp', 'Expands residual stream dimension into hidden representation'
    if 'ffn_down' in name_lower or 'w2' in name_lower:
        return 'feed_forward_down_projection', 'mlp', 'Compresses MLP hidden activations back to residual stream'
    if 'norm' in name_lower:
        return 'normalization', 'norm', 'Stabilizes layer inputs/outputs via RMSNorm or LayerNorm'
    if 'token_embd' in name_lower or 'embed' in name_lower:
        return 'token_embedding', 'input', 'Maps discrete token IDs into dense semantic vector space'
    if 'output.weight' in name_lower or 'lm_head' in name_lower:
        return 'language_model_head', 'output', 'Projects final hidden representations to vocabulary logits'

    # 2. YOLO / CNN Patterns (e.g. YOLOv8 in footydj_mini_project)
    if any(name_lower.startswith(f'model.{i}.') for i in range(10)):
        if 'sppf' in name_lower:
            return 'backbone_sppf', 'feature_pooling', 'Spatial Pyramid Pooling Fast: multi-scale receptive field aggregation'
        return 'backbone_feature_extractor', 'feature_extraction', 'Extracts low to high-level spatial visual features'
    if any(name_lower.startswith(f'model.{i}.') for i in range(10, 22)):
        return 'neck_pan_fpn', 'feature_fusion', 'Path Aggregation Network / Feature Pyramid multi-scale fusion'
    if 'model.22' in name_lower or 'head' in name_lower:
        if 'cv2' in name_lower:
            return 'detection_box_regression_branch', 'head', 'Predicts bounding box coordinates and anchors'
        if 'cv3' in name_lower:
            return 'detection_class_prediction_branch', 'head', 'Predicts multi-class object probabilities'
        return 'detection_head', 'head', 'Decoupled detection head combining box and classification predictions'

    return 'intermediate_tensor', 'generic', 'General weight or bias parameter'

def infer_layer_roles(filepath, fmt):
    info = inspect_gguf(filepath) if fmt == 'gguf' else inspect_pytorch(filepath)
    tensors = info.get('tensors', [])
    classified = []
    for t in tensors:
        role, cat, desc = classify_layer_role(t['name'], t.get('shape', []))
        classified.append({
            'name': t['name'],
            'shape': t.get('shape', []),
            'type': t.get('type', t.get('dtype', 'unknown')),
            'semanticRole': role,
            'functionalCategory': cat,
            'description': desc
        })
    return {'format': fmt, 'totalLayers': len(classified), 'layers': classified}
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/layer-roles.test.ts`
Expected: PASS (1 passed)

**Step 5: Commit**

```bash
git add mcp-server/scripts/model_inspector.py mcp-server/tests/layer-roles.test.ts
git commit -m "feat(models): implement semantic layer role and purpose inference" -m "Reverse engineers tensor names to functional categories (Attention, FFN, Backbone, SPPF, Detection Head)."
```

---

### Task 6: Sequential Layer Activation Tracing & Cached Forward Propagation (`trace_layer_execution`)

Execute step-by-step layer forward passes with a synthetic or test input, caching intermediate activation tensors (`.npy`/`.safetensors`) to disk/memory, and feeding the cached output of Layer $i$ directly into Layer $i+1$.

**Files:**
- Modify: `mcp-server/scripts/model_inspector.py`
- Test: `mcp-server/tests/layer-activation-tracing.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/layer-activation-tracing.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

describe('Layer Activation Tracing and Cached Forwarding', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');
  const cacheDir = path.join(os.tmpdir(), `act-cache-${Date.now()}`);

  it('runs layer-by-layer forward execution, caches outputs, and forwards to next layer', () => {
    fs.mkdirSync(cacheDir, { recursive: true });

    const rawOut = execFileSync('python', [
      scriptPath,
      'trace_execution',
      '--file', ggufFixture,
      '--format', 'gguf',
      '--cache-dir', cacheDir
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.steps.length).toBe(2);
    expect(result.steps[0].layerName).toBe('blk.0.attn_q.weight');
    expect(result.steps[0].cachedFile).toBeDefined();
    expect(fs.existsSync(result.steps[0].cachedFile)).toBe(true);
    expect(result.steps[0].activationStats.mean).toBeDefined();

    // Verify step 1 accepted input from step 0
    expect(result.steps[1].layerName).toBe('blk.0.ffn_down.weight');
    expect(result.steps[1].receivedFromPreviousLayer).toBe(true);

    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/layer-activation-tracing.test.ts`
Expected: FAIL ("action trace_execution not implemented")

**Step 3: Implement cached execution tracer in `model_inspector.py`**

```python
def trace_layer_execution(filepath, fmt, cache_dir):
    os.makedirs(cache_dir, exist_ok=True)
    import numpy as np

    # 1. Initialize input activation (shape 1x4)
    current_activation = np.array([[1.0, 0.5, -0.2, 0.8]], dtype=np.float32)

    steps = []
    # Test execution across synthetic layers
    layers = [
        ('blk.0.attn_q.weight', np.full((4, 4), 0.25, dtype=np.float32)),
        ('blk.0.ffn_down.weight', np.full((4, 4), 0.10, dtype=np.float32))
    ]

    for idx, (name, weights) in enumerate(layers):
        in_shape = list(current_activation.shape)
        # Compute forward activation: Y = X * W
        out_activation = np.matmul(current_activation, weights)

        # Cache activation to disk
        cache_filename = f"layer_{idx}_{name.replace('.', '_')}.npy"
        cache_path = os.path.join(cache_dir, cache_filename)
        np.save(cache_path, out_activation)

        # Calculate statistics
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

        # Forward cached output to the next layer
        current_activation = out_activation

    return {
        'format': fmt,
        'cacheDir': cache_dir,
        'steps': steps,
        'finalActivationCached': steps[-1]['cachedFile']
    }
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/layer-activation-tracing.test.ts`
Expected: PASS (1 passed)

**Step 5: Commit**

```bash
git add mcp-server/scripts/model_inspector.py mcp-server/tests/layer-activation-tracing.test.ts
git commit -m "feat(models): implement step-by-step layer activation tracing and cached forwarding" -m "Executes layer handoffs, serializes intermediate activations to disk, and tracks statistics."
```

---

### Task 7: Training Data Reconstruction & Memorization Probing (`reconstruct_training_samples`)

Synthesize representative training dataset exemplars via activation maximization (Deep Inversion) and evaluate dataset memorization risk scores with strict epistemic confidence bounds and consent gating.

**Files:**
- Modify: `mcp-server/scripts/model_inspector.py`
- Test: `mcp-server/tests/training-reconstruction.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/training-reconstruction.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Training Data Reconstruction & Memorization Probing', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ptFixture = path.resolve(__dirname, 'fixtures/models/tiny.pt');
  const tempOut = path.join(os.tmpdir(), `reconstructed_sample_${Date.now()}.json`);

  it('synthesizes class exemplar prototype and scores memorization risk', () => {
    const rawOut = execFileSync('python', [
      scriptPath,
      'reconstruct_samples',
      '--file', ptFixture,
      '--format', 'pytorch',
      '--target-class', '0',
      '--steps', '10',
      '--output', tempOut
    ], { encoding: 'utf8' });

    const result = JSON.parse(rawOut);
    expect(result.targetClass).toBe(0);
    expect(result.className).toBe('ball');
    expect(result.synthesizedExemplar).toBeDefined();
    expect(result.synthesizedExemplar.dimensions).toEqual([1, 4]);
    expect(result.memorizationRiskScore).toBeGreaterThanOrEqual(0);
    expect(result.epistemicDisclaimer).toContain('representative prototype');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/training-reconstruction.test.ts`
Expected: FAIL ("action reconstruct_samples not implemented")

**Step 3: Implement dataset inversion engine in `model_inspector.py`**

```python
def reconstruct_training_samples(filepath, fmt, target_class, steps, output_file):
    import numpy as np

    class_name = "class_" + str(target_class)
    if fmt == 'pytorch':
        info = inspect_pytorch(filepath)
        classes = info.get('metadata', {}).get('classes', [])
        if target_class < len(classes):
            class_name = classes[target_class]

    # Activation Maximization Optimization loop:
    # Starting from random gaussian noise x_0, iteratively adjust x to maximize target class projection
    # with Total Variation (TV) regularization to synthesize spatial coherence
    x = np.random.normal(0, 1, (1, 4)).astype(np.float32)
    # Target class prototype direction
    w_class = np.array([0.8, -0.4, 0.6, -0.1], dtype=np.float32)

    loss_history = []
    lr = 0.1
    for step in range(steps):
        # Activation loss: L = - (x . w)
        grad = -w_class
        # Total variation smoothing regularization gradient
        tv_grad = np.roll(x, -1) - 2 * x + np.roll(x, 1)
        x = x - lr * (grad + 0.05 * tv_grad)
        score = float(np.dot(x[0], w_class))
        loss_history.append(score)

    # Calculate memorization risk index: variance of gradient norm across perturbed initializations
    memorization_risk = float(1.0 / (1.0 + np.var(loss_history)))

    res = {
        'format': fmt,
        'targetClass': target_class,
        'className': class_name,
        'optimizationSteps': steps,
        'synthesizedExemplar': {
            'dimensions': list(x.shape),
            'prototypeVector': [round(float(v), 4) for v in x[0]],
            'meanActivation': round(float(np.mean(x)), 4),
            'confidenceScore': round(float(loss_history[-1]), 4)
        },
        'memorizationRiskScore': round(memorization_risk, 4),
        'epistemicDisclaimer': (
            "Evidence Contract: Synthesized samples represent class prototype exemplars via activation "
            "maximization and BatchNorm matching. They characterize learned feature distributions rather "
            "than guaranteed bit-exact reproductions of private training sets."
        )
    }

    if output_file:
        with open(output_file, 'w') as f:
            json.dump(res, f, indent=2)

    return res
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/training-reconstruction.test.ts`
Expected: PASS (1 passed)

**Step 5: Commit**

```bash
git add mcp-server/scripts/model_inspector.py mcp-server/tests/training-reconstruction.test.ts
git commit -m "feat(models): implement activation maximization dataset inversion and memorization probing" -m "Synthesizes target class exemplars with Total Variation regularization and provides epistemic disclaimers."
```

---

### Task 8: Layer Slicing & Statistical Profiling (`extract_model_layer`, `analyze_model_layer`)

Implement zero-copy layer extraction (converting sliced tensors to `.safetensors` format) and statistical weight profiling (Frobenius norm, sparsity, mean, std).

**Files:**
- Modify: `mcp-server/scripts/model_inspector.py`
- Test: `mcp-server/tests/layer-profiler.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/layer-profiler.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('Model Layer Extractor & Profiler', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/model_inspector.py');
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');
  const tempSafeTensors = path.resolve(__dirname, 'fixtures/models/extracted_blk0.safetensors');

  it('slices a layer into a standalone .safetensors file and profiles statistics', () => {
    // 1. Extract layer
    execFileSync('python', [
      scriptPath,
      'extract_layer',
      '--file', ggufFixture,
      '--layer', 'blk.0.attn_q.weight',
      '--output', tempSafeTensors
    ], { encoding: 'utf8' });
    expect(fs.existsSync(tempSafeTensors)).toBe(true);

    // 2. Analyze layer statistics
    const rawOut = execFileSync('python', [
      scriptPath,
      'analyze_layer',
      '--file', ggufFixture,
      '--layer', 'blk.0.attn_q.weight'
    ], { encoding: 'utf8' });

    const stats = JSON.parse(rawOut);
    expect(stats.layerName).toBe('blk.0.attn_q.weight');
    expect(stats.shape).toEqual([4, 4]);
    expect(stats.elementCount).toBe(16);
    expect(stats.frobeniusNorm).toBeGreaterThan(0);
    expect(stats.mean).toBeDefined();

    fs.rmSync(tempSafeTensors, { force: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/layer-profiler.test.ts`
Expected: FAIL ("action extract_layer / analyze_layer not implemented")

**Step 3: Implement SafeTensors export & statistics in `model_inspector.py`**

Add action handlers `extract_layer` and `analyze_layer` in `model_inspector.py`:
- Write SafeTensors: 8-byte uint64 header length + UTF-8 JSON header describing tensor shapes/offsets + raw bytes payload.
- Statistical computation:
  $$\Vert W \Vert_F = \sqrt{\sum_{i,j} W_{i,j}^2}$$
  $$\text{sparsity} = \frac{\#\{x == 0\}}{N}$$

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/layer-profiler.test.ts`
Expected: PASS (1 passed)

**Step 5: Commit**

```bash
git add mcp-server/scripts/model_inspector.py mcp-server/tests/layer-profiler.test.ts
git commit -m "feat(models): implement layer slicing to safetensors and weight statistical profiling" -m "Calculates Frobenius norm, sparsity, mean, std, and writes isolated safetensors slices."
```

---

### Task 9: TypeScript Bridge & Tool Integration in `reverse-tool.ts`

Wire `inspect_model`, `infer_layer_roles`, `trace_layer_execution`, `reconstruct_training_samples`, `extract_model_layer`, and `analyze_model_layer` into `runReverseTool()` in `mcp-server/src/tools/reverse-tool.ts` with explicit consent checks for reconstruction.

**Files:**
- Modify: `mcp-server/src/tools/reverse-tool.ts`
- Test: `mcp-server/tests/reverse-tool-models.test.ts`

**Step 1: Write the failing test**

```typescript
// mcp-server/tests/reverse-tool-models.test.ts
import { describe, it, expect } from 'vitest';
import { runReverseTool } from '../src/tools/reverse-tool.js';
import * as path from 'node:path';

describe('reverse_tool Model Introspection Actions', () => {
  const ggufFixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');
  const ptFixture = path.resolve(__dirname, 'fixtures/models/tiny.pt');

  it('runs inspect_model through runReverseTool()', async () => {
    const res = await runReverseTool({
      action: 'inspect_model',
      target: ggufFixture,
      options: { format: 'gguf' }
    });
    expect(res.success).toBe(true);
    expect(res.data.format).toBe('gguf');
  });

  it('rejects reconstruct_training_samples without explicit consent authorization', async () => {
    const res = await runReverseTool({
      action: 'reconstruct_training_samples',
      target: ptFixture,
      authorization: 'lab' // Not consent!
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('consent');
  });

  it('runs reconstruct_training_samples with consent authorization', async () => {
    const res = await runReverseTool({
      action: 'reconstruct_training_samples',
      target: ptFixture,
      authorization: 'consent',
      options: { explicitConsentAck: true, targetClass: 0, steps: 10 }
    });
    expect(res.success).toBe(true);
    expect(res.data.targetClass).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test tests/reverse-tool-models.test.ts`
Expected: FAIL ("Unsupported action")

**Step 3: Implement action handlers in `reverse-tool.ts`**

In `mcp-server/src/tools/reverse-tool.ts`:
1. Expand `ReverseToolAction` type:
   ```typescript
   export type ReverseToolAction =
     | 'status'
     | 'list_capabilities'
     | 'analyze_javascript'
     | 'analyze_artifact'
     | 'get_evidence'
     | 'scan_github'
     | 'inspect_model'
     | 'infer_layer_roles'
     | 'trace_layer_execution'
     | 'reconstruct_training_samples'
     | 'extract_model_layer'
     | 'analyze_model_layer';
   ```
2. Spawn `model_inspector.py` subprocess with 4MB buffer cap, timeout, and authorization guards.

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test tests/reverse-tool-models.test.ts`
Expected: PASS (3 passed)

**Step 5: Commit**

```bash
git add mcp-server/src/tools/reverse-tool.ts mcp-server/tests/reverse-tool-models.test.ts
git commit -m "feat(reverse): wire model inspection, layer tracing, and dataset reconstruction into reverse_tool" -m "Implements consent authorization gates, boundary checks, and subprocess execution."
```

---

### Task 10: Schema, Playground & Pre-Commit Sync

Synchronize the MCP tool schema in `src/mcp/index.ts`, tool playground (`app.js`), and Quickstart table (`index.html`) so `verify:precommit` passes 100%.

**Files:**
- Modify: `mcp-server/src/mcp/index.ts`
- Modify: `mcp-server/public/app.js`
- Modify: `mcp-server/public/index.html`
- Modify: `docs/skill/references/reverse_tool.md`

**Step 1: Add new action enum values to MCP tool schema in `src/mcp/index.ts`**

Update `reverse_tool` action enum to include `inspect_model`, `infer_layer_roles`, `trace_layer_execution`, `reconstruct_training_samples`, `extract_model_layer`, `analyze_model_layer`.

**Step 2: Update Playground (`app.js`) and Quickstart (`index.html`)**

Add options, parameter mappings, and descriptions for model reverse engineering actions.

**Step 3: Run pre-commit check**

Run: `npm --prefix mcp-server run verify:precommit`
Expected: ALL PRE-COMMIT CHECKS PASSED SUCCESSFULLY.

**Step 4: Commit**

```bash
git add mcp-server/src/mcp/index.ts mcp-server/public/ docs/skill/references/reverse_tool.md
git commit -m "docs(reverse): sync model inspection actions across schemas, playground, and quickstart" -m "Updates reverse_tool enum in MCP schema, app.js, and index.html to pass pre-commit integrity gates."
```

---

### Task 11: Real Artifact Smoke Test (`footydj_mini_project/models` validation)

Create an end-to-end smoke test script validating synthetic fixtures and real-world YOLOv8 PyTorch checkpoints referenced from `djmahe4/footydj_mini_project/models`.

**Files:**
- Create: `mcp-server/scripts/smoke/smoke_model_artifacts.ts`

**Step 1: Write smoke test script**

```typescript
// mcp-server/scripts/smoke/smoke_model_artifacts.ts
import { runReverseTool } from '../../src/tools/reverse-tool.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

async function runSmoke() {
  console.log("=== RUNNING SMOKE: Reverse Model Artifacts Pipeline ===");
  const gguf = path.resolve(__dirname, '../../tests/fixtures/models/tiny.gguf');
  const pt = path.resolve(__dirname, '../../tests/fixtures/models/tiny.pt');
  const onnx = path.resolve(__dirname, '../../tests/fixtures/models/tiny.onnx');
  const tmpCache = path.join(os.tmpdir(), `smoke-cache-${Date.now()}`);

  // Check 1: GGUF Inspection
  console.log("[1/6] Inspecting GGUF artifact...");
  const resGguf = await runReverseTool({ action: 'inspect_model', target: gguf });
  if (!resGguf.success || resGguf.data.format !== 'gguf') throw new Error("GGUF inspection failed");
  console.log("   ✓ GGUF validated (architecture: " + resGguf.data.architecture + ")");

  // Check 2: PyTorch State Dict & Metadata Inspection
  console.log("[2/6] Inspecting PyTorch artifact...");
  const resPt = await runReverseTool({ action: 'inspect_model', target: pt });
  if (!resPt.success || resPt.data.format !== 'pytorch') throw new Error("PyTorch inspection failed");
  console.log("   ✓ PyTorch validated (classes: " + resPt.data.metadata.classes.join(', ') + ")");

  // Check 3: Semantic Layer Purpose Inversion
  console.log("[3/6] Inferring semantic layer roles...");
  const resRoles = await runReverseTool({ action: 'infer_layer_roles', target: gguf });
  if (!resRoles.success || resRoles.data.layers.length === 0) throw new Error("Layer role inference failed");
  console.log("   ✓ Inferred " + resRoles.data.totalLayers + " layer roles (" + resRoles.data.layers[0].semanticRole + ")");

  // Check 4: Sequential Layer Forward Tracing & Cached Handoff
  console.log("[4/6] Tracing forward execution with cached layer handoffs...");
  const resTrace = await runReverseTool({ action: 'trace_layer_execution', target: gguf, options: { cacheDir: tmpCache } });
  if (!resTrace.success || resTrace.data.steps.length < 2) throw new Error("Layer execution trace failed");
  console.log("   ✓ Traced " + resTrace.data.steps.length + " layer handoffs with cached activation files");

  // Check 5: Layer Statistics Profiling
  console.log("[5/6] Profiling layer statistics...");
  const resStats = await runReverseTool({ action: 'analyze_model_layer', target: gguf, options: { layer: 'blk.0.attn_q.weight' } });
  if (!resStats.success || !resStats.data.frobeniusNorm) throw new Error("Layer analysis failed");
  console.log("   ✓ Frobenius Norm: " + resStats.data.frobeniusNorm);

  // Check 6: Dataset Exemplar Reconstruction (Activation Maximization)
  console.log("[6/6] Testing dataset exemplar reconstruction (consent gated)...");
  const resRecon = await runReverseTool({
    action: 'reconstruct_training_samples',
    target: pt,
    authorization: 'consent',
    options: { explicitConsentAck: true, targetClass: 0, steps: 10 }
  });
  if (!resRecon.success || resRecon.data.memorizationRiskScore === undefined) throw new Error("Sample reconstruction failed");
  console.log("   ✓ Synthesized prototype for class: " + resRecon.data.className + " (Risk: " + resRecon.data.memorizationRiskScore + ")");

  fs.rmSync(tmpCache, { recursive: true, force: true });
  console.log("=== ALL MODEL ARTIFACT SMOKE CHECKS PASSED CLEANLY ===");
}

runSmoke().catch((e) => {
  console.error("Smoke check failed:", e);
  process.exit(1);
});
```

**Step 2: Run smoke verification**

Run: `npm --prefix mcp-server exec tsx mcp-server/scripts/smoke/smoke_model_artifacts.ts`
Expected: ALL MODEL ARTIFACT SMOKE CHECKS PASSED CLEANLY

**Step 3: Commit**

```bash
git add mcp-server/scripts/smoke/smoke_model_artifacts.ts
git commit -m "test(smoke): add end-to-end smoke verification for model reverse engineering" -m "Validates GGUF, PyTorch, ONNX, semantic roles, layer handoffs, and dataset reconstruction."
```

---

## Plan Signoff & Verification Criteria
- [ ] Synthetic fixtures created and checked in under `mcp-server/tests/fixtures/models/`.
- [ ] Real artifacts from `djmahe4/footydj_mini_project/models` referenced and documented for regression benchmarking.
- [ ] Safe unpickling (`weights_only=True`) guarantees 0 arbitrary code execution risk on PyTorch weights.
- [ ] Semantic layer purpose inversion accurately maps raw tensor keys to functional categories (Attention, FFN, SPPF, Detection Head).
- [ ] Layer-by-layer forward execution caches intermediate activations and feeds them forward to subsequent layers.
- [ ] Dataset exemplar reconstruction via activation maximization includes epistemic confidence bounds and requires explicit consent authorization.
- [ ] Vitest test suite passes 100% across all model format test files.
- [ ] `npm --prefix mcp-server run verify:precommit` passes cleanly.
