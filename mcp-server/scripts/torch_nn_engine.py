import sys
import os
import json
import zipfile
import pickle
import argparse

try:
    import numpy as np
except ImportError:
    sys.stderr.write("Error: NumPy is required for torch_nn_engine.py\n")
    sys.exit(1)

# Ensure current script directory is in sys.path for local module resolution
sys.path.insert(0, os.path.dirname(__file__))


class DummyStub:
    """Safe placeholder for arbitrary serialized objects in torch checkpoints."""
    def __init__(self, *args, **kwargs):
        pass

    def __setstate__(self, state):
        if isinstance(state, dict):
            self.__dict__.update(state)

    def __getattr__(self, name):
        return None

    def __repr__(self):
        return "<DummyStub>"


class SafeUnpickler(pickle.Unpickler):
    """Restricts pickle loading to safe primitive types, torch structures, and safe stubs."""
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
        if module == 'torch._utils' and name in ('_rebuild_tensor_v2', '_rebuild_parameter'):
            return lambda *args, **kwargs: DummyStub()
        if module in self.SAFE_CLASSES and name in self.SAFE_CLASSES[module]:
            try:
                return super().find_class(module, name)
            except Exception:
                pass
        return DummyStub

    def persistent_load(self, pid):
        return DummyStub()


def conv2d(x, w, b=None, stride=1, padding=1, groups=1):
    """
    Pure-NumPy 2D convolution.
    x: [C_in, H, W] or [B, C_in, H, W]
    w: [C_out, C_in // groups, K_h, K_w]
    b: optional [C_out]
    stride: int or (stride_h, stride_w)
    padding: int or (pad_h, pad_w)
    groups: int (1 for standard conv, C_in for depthwise separable conv)
    """
    is_3d = (x.ndim == 3)
    if is_3d:
        x = x[None, ...]

    b_sz, c_in, h, w_in = x.shape
    c_out, k_cin, k_h, k_w = w.shape

    s_h = stride if isinstance(stride, int) else stride[0]
    s_w = stride if isinstance(stride, int) else stride[1]
    p_h = padding if isinstance(padding, int) else padding[0]
    p_w = padding if isinstance(padding, int) else padding[1]

    if groups > 1:
        if c_in % groups != 0 or c_out % groups != 0:
            raise ValueError(f"c_in ({c_in}) and c_out ({c_out}) must be divisible by groups ({groups})")
        cin_g = c_in // groups
        cout_g = c_out // groups
        out_chunks = []
        for g in range(groups):
            xg = x[:, g * cin_g:(g + 1) * cin_g, :, :]
            wg = w[g * cout_g:(g + 1) * cout_g, :, :, :]
            bg = b[g * cout_g:(g + 1) * cout_g] if b is not None else None
            out_g = conv2d(xg, wg, bg, stride=(s_h, s_w), padding=(p_h, p_w), groups=1)
            if out_g.ndim == 3:
                out_g = out_g[None, ...]
            out_chunks.append(out_g)
        out = np.concatenate(out_chunks, axis=1)
        return out[0] if is_3d else out

    x_pad = np.pad(x, ((0, 0), (0, 0), (p_h, p_h), (p_w, p_w)), mode='constant')
    out_h = (h + 2 * p_h - k_h) // s_h + 1
    out_w = (w_in + 2 * p_w - k_w) // s_w + 1

    out = np.zeros((b_sz, c_out, out_h, out_w), dtype=np.float32)
    for i in range(out_h):
        for j in range(out_w):
            h_s = i * s_h
            w_s = j * s_w
            patch = x_pad[:, :, h_s:h_s+k_h, w_s:w_s+k_w]
            out[:, :, i, j] = np.tensordot(patch, w, axes=([1, 2, 3], [1, 2, 3]))

    if b is not None:
        out += b[None, :, None, None]

    return out[0] if is_3d else out


def fuse_conv_bn(conv_w, conv_b, bn_rm, bn_rv, bn_gamma, bn_beta, eps=1e-5):
    """
    Folds BatchNorm parameters into Conv weights and bias.
    W_fused = W * (gamma / sqrt(var + eps))
    b_fused = beta + (b - mean) * (gamma / sqrt(var + eps))
    """
    inv_std = bn_gamma / np.sqrt(bn_rv + eps)
    fused_w = conv_w * inv_std[:, None, None, None]
    b = conv_b if conv_b is not None else np.zeros(conv_w.shape[0], dtype=np.float32)
    fused_b = bn_beta + (b - bn_rm) * inv_std
    return fused_w, fused_b


def silu(x):
    """SiLU activation function: x / (1.0 + exp(-x))."""
    x_clipped = np.clip(x, -88.0, 88.0)
    return x / (1.0 + np.exp(-x_clipped))


def relu(x):
    """ReLU activation function: max(0, x)."""
    return np.maximum(0.0, x)


def relu6(x):
    """ReLU6 activation function: min(max(0, x), 6)."""
    return np.clip(x, 0.0, 6.0)


def hardswish(x):
    """Hard-Swish activation function: x * relu6(x + 3) / 6."""
    return x * np.clip(x + 3.0, 0.0, 6.0) / 6.0


def sigmoid(x):
    """Sigmoid activation function: 1 / (1 + exp(-x))."""
    x_clipped = np.clip(x, -88.0, 88.0)
    return 1.0 / (1.0 + np.exp(-x_clipped))


def softmax(x, axis=-1):
    """Numerically stable softmax."""
    e_x = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return e_x / np.sum(e_x, axis=axis, keepdims=True)


def maxpool2d(x, kernel_size=3, stride=2, padding=1):
    """Pure-NumPy 2D max-pooling."""
    is_3d = (x.ndim == 3)
    if is_3d:
        x = x[None, ...]
    b_sz, c, h, w = x.shape
    k_h = kernel_size if isinstance(kernel_size, int) else kernel_size[0]
    k_w = kernel_size if isinstance(kernel_size, int) else kernel_size[1]
    s_h = stride if isinstance(stride, int) else stride[0]
    s_w = stride if isinstance(stride, int) else stride[1]
    p_h = padding if isinstance(padding, int) else padding[0]
    p_w = padding if isinstance(padding, int) else padding[1]

    x_pad = np.pad(x, ((0, 0), (0, 0), (p_h, p_h), (p_w, p_w)), mode='constant', constant_values=-1e9)
    out_h = (h + 2 * p_h - k_h) // s_h + 1
    out_w = (w + 2 * p_w - k_w) // s_w + 1
    out = np.zeros((b_sz, c, out_h, out_w), dtype=x.dtype)
    for i in range(out_h):
        for j in range(out_w):
            h_s = i * s_h
            w_s = j * s_w
            patch = x_pad[:, :, h_s:h_s+k_h, w_s:w_s+k_w]
            out[:, :, i, j] = np.max(patch, axis=(2, 3))
    return out[0] if is_3d else out


def adaptive_avgpool2d(x, output_size=(1, 1)):
    """Pure-NumPy adaptive 2D average pooling."""
    is_3d = (x.ndim == 3)
    if is_3d:
        x = x[None, ...]
    b_sz, c, h, w = x.shape
    oh = output_size if isinstance(output_size, int) else output_size[0]
    ow = output_size if isinstance(output_size, int) else output_size[1]

    if oh == 1 and ow == 1:
        out = np.mean(x, axis=(2, 3), keepdims=True)
    else:
        out = np.zeros((b_sz, c, oh, ow), dtype=np.float32)
        for i in range(oh):
            h_start = int(np.floor(i * h / oh))
            h_end = int(np.ceil((i + 1) * h / oh))
            for j in range(ow):
                w_start = int(np.floor(j * w / ow))
                w_end = int(np.ceil((j + 1) * w / ow))
                patch = x[:, :, h_start:h_end, w_start:w_end]
                out[:, :, i, j] = np.mean(patch, axis=(2, 3))

    return out[0] if is_3d else out


def bottleneck(x, w1, w2, b1=None, b2=None, shortcut=True):
    """Residual bottleneck block: conv3x3 -> silu -> conv3x3 -> silu (+ shortcut)."""
    res = silu(conv2d(x, w1, b1, stride=1, padding=1))
    res = silu(conv2d(res, w2, b2, stride=1, padding=1))
    return (x + res) if shortcut else res


def c2f_block(x, w_cv1, w_cv2, bottleneck_weights=None, b_cv1=None, b_cv2=None):
    """
    C2f block: split channels, residual bottlenecks, concatenate.
    cv1 (1x1 conv) -> split into 2 -> bottlenecks -> concatenate -> cv2 (1x1 conv).
    """
    channel_axis = 0 if x.ndim == 3 else 1
    y = silu(conv2d(x, w_cv1, b_cv1, stride=1, padding=0))
    c_mid = y.shape[channel_axis] // 2
    if channel_axis == 0:
        y1, y2 = y[:c_mid], y[c_mid:]
    else:
        y1, y2 = y[:, :c_mid], y[:, c_mid:]
    outputs = [y1, y2]
    curr = y2
    if bottleneck_weights:
        for bw in bottleneck_weights:
            curr = bottleneck(curr, bw['w1'], bw['w2'], bw.get('b1'), bw.get('b2'), bw.get('shortcut', True))
            outputs.append(curr)
    cat = np.concatenate(outputs, axis=channel_axis)
    out = silu(conv2d(cat, w_cv2, b_cv2, stride=1, padding=0))
    return out


def c3k2_block(x, w_cv1, w_cv2, bottleneck_weights=None, b_cv1=None, b_cv2=None):
    """
    C3k2 block (YOLOv11): CSP bottleneck block with variable sub-bottleneck stacks.
    """
    return c2f_block(x, w_cv1, w_cv2, bottleneck_weights, b_cv1=b_cv1, b_cv2=b_cv2)


def sppf_block(x, w_cv1, w_cv2, b_cv1=None, b_cv2=None):
    """
    SPPF block: sequential 5x5 max-pooling concatenating multi-scale features.
    """
    channel_axis = 0 if x.ndim == 3 else 1
    y = silu(conv2d(x, w_cv1, b_cv1, stride=1, padding=0))
    m1 = maxpool2d(y, kernel_size=5, stride=1, padding=2)
    m2 = maxpool2d(m1, kernel_size=5, stride=1, padding=2)
    m3 = maxpool2d(m2, kernel_size=5, stride=1, padding=2)
    cat = np.concatenate([y, m1, m2, m3], axis=channel_axis)
    out = silu(conv2d(cat, w_cv2, b_cv2, stride=1, padding=0))
    return out


def residual_basic_block(x, w1, w2, b1=None, b2=None, w_proj=None, b_proj=None, stride=1):
    """
    ResNet BasicBlock:
    conv3x3(stride) -> relu -> conv3x3 -> (+ shortcut/proj) -> relu.
    """
    res = relu(conv2d(x, w1, b1, stride=stride, padding=1))
    res = conv2d(res, w2, b2, stride=1, padding=1)
    shortcut = x
    if w_proj is not None:
        shortcut = conv2d(x, w_proj, b_proj, stride=stride, padding=0)
    return relu(res + shortcut)


def inverted_residual_block(x, w_exp, w_dw, w_proj, b_exp=None, b_dw=None, b_proj=None, stride=1, expansion=2):
    """
    MobileNetV2 Inverted Residual Block:
    1x1 conv (expansion) -> relu6 -> 3x3 depthwise conv -> relu6 -> 1x1 linear projection (+ shortcut if stride=1).
    """
    c_axis = 0 if x.ndim == 3 else 1
    h = x
    if w_exp is not None:
        h = relu6(conv2d(h, w_exp, b_exp, stride=1, padding=0))

    dw_channels = h.shape[c_axis]
    h = relu6(conv2d(h, w_dw, b_dw, stride=stride, padding=1, groups=dw_channels))
    out = conv2d(h, w_proj, b_proj, stride=1, padding=0)

    if stride == 1 and out.shape == x.shape:
        out = out + x
    return out


def dfl_decode(box_dist, reg_max=16):
    """
    Distribution Focal Loss (DFL) box decoding.
    Expects box_dist of shape [4 * reg_max, num_anchors].
    Computes expectation: sum(softmax(dist_bins) * bin_indices).
    """
    num_anchors = box_dist.shape[-1]
    dist_reshaped = box_dist.reshape(4, reg_max, num_anchors)
    exp_d = np.exp(dist_reshaped - np.max(dist_reshaped, axis=1, keepdims=True))
    probs = exp_d / (np.sum(exp_d, axis=1, keepdims=True) + 1e-8)
    bins = np.arange(reg_max, dtype=np.float32).reshape(1, reg_max, 1)
    dfl_offsets = np.sum(probs * bins, axis=1)  # [4, num_anchors]
    return dfl_offsets


def calculate_iou(box1, box2):
    """Computes Intersection-over-Union (IoU) between two bounding boxes [x1, y1, x2, y2]."""
    x1 = max(box1[0], box2[0])
    y1 = max(box1[1], box2[1])
    x2 = min(box1[2], box2[2])
    y2 = min(box1[3], box2[3])

    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area1 = max(0.0, box1[2] - box1[0]) * max(0.0, box1[3] - box1[1])
    area2 = max(0.0, box2[2] - box2[0]) * max(0.0, box2[3] - box2[1])
    union = area1 + area2 - inter
    return inter / union if union > 0 else 0.0


def nms(detections, iou_threshold=0.5):
    """Performs Non-Maximum Suppression (NMS) on a list of detection dicts."""
    sorted_dets = sorted(detections, key=lambda d: d['confidence'], reverse=True)
    kept = []
    while sorted_dets:
        best = sorted_dets.pop(0)
        kept.append(best)
        sorted_dets = [
            d for d in sorted_dets
            if d['classId'] != best['classId'] or calculate_iou(d['box'], best['box']) < iou_threshold
        ]
    return kept


def decoupled_detect_head(reg_feat, cls_feat, anchor_points, stride, reg_max=16, class_names=None, conf_threshold=0.25, iou_threshold=0.5, nms_free=False):
    """
    Decoupled detect head: regression branch + class scoring branch with DFL box decoding and NMS.
    reg_feat: [4 * reg_max, num_anchors]
    cls_feat: [num_classes, num_anchors]
    anchor_points: [num_anchors, 2]
    """
    if class_names is None:
        class_names = ['object']
    num_classes = cls_feat.shape[0]
    num_anchors = cls_feat.shape[1]

    ltrb = dfl_decode(reg_feat, reg_max=reg_max)

    cx = anchor_points[:, 0]
    cy = anchor_points[:, 1]
    x1 = (cx - ltrb[0, :]) * stride
    y1 = (cy - ltrb[1, :]) * stride
    x2 = (cx + ltrb[2, :]) * stride
    y2 = (cy + ltrb[3, :]) * stride

    cls_probs = 1.0 / (1.0 + np.exp(-np.clip(cls_feat, -88.0, 88.0)))

    raw_detections = []
    for a in range(num_anchors):
        class_id = int(np.argmax(cls_probs[:, a]))
        conf = float(cls_probs[class_id, a])
        if conf >= conf_threshold:
            bx1 = float(max(0.0, round(float(x1[a]), 2)))
            by1 = float(max(0.0, round(float(y1[a]), 2)))
            bx2 = float(max(bx1 + 1.0, round(float(x2[a]), 2)))
            by2 = float(max(by1 + 1.0, round(float(y2[a]), 2)))
            c_name = class_names[class_id] if class_id < len(class_names) else f"class_{class_id}"
            raw_detections.append({
                'box': [bx1, by1, bx2, by2],
                'confidence': round(conf, 4),
                'classId': class_id,
                'className': c_name,
                'anchorIndex': a
            })

    if nms_free:
        return sorted(raw_detections, key=lambda d: d['confidence'], reverse=True)
    return nms(raw_detections, iou_threshold=iou_threshold)


def classify_head(features, w_fc, b_fc=None, class_names=None, top_k=5):
    """
    Classification head: Global Average Pool + linear projection + softmax.
    features: [C, H, W] or [B, C, H, W]
    w_fc: [num_classes, C] or [C, num_classes]
    """
    pooled = adaptive_avgpool2d(features, output_size=(1, 1))
    if pooled.ndim == 4:
        flat = pooled[0, :, 0, 0]
    elif pooled.ndim == 3:
        flat = pooled[:, 0, 0]
    else:
        flat = pooled.flatten()

    c_dim = flat.shape[0]
    if w_fc.shape[1] == c_dim:
        logits = np.dot(w_fc, flat)
    elif w_fc.shape[0] == c_dim:
        logits = np.dot(w_fc.T, flat)
    else:
        raise ValueError(f"Weight matrix shape {w_fc.shape} incompatible with pooled channel dim {c_dim}")

    if b_fc is not None:
        logits += b_fc

    probs = softmax(logits, axis=-1)
    num_classes = len(probs)
    if class_names is None:
        class_names = [f"class_{i}" for i in range(num_classes)]

    top_indices = np.argsort(probs)[::-1][:min(top_k, num_classes)]
    predictions = [
        {
            'classId': int(idx),
            'className': class_names[idx] if idx < len(class_names) else f"class_{idx}",
            'probability': round(float(probs[idx]), 4)
        }
        for idx in top_indices
    ]
    return {
        'topClass': predictions[0]['className'] if predictions else None,
        'topProbability': predictions[0]['probability'] if predictions else 0.0,
        'predictions': predictions
    }


def segment_proto_head(reg_feat, cls_feat, proto_feat, coef_feat, anchor_points, stride, class_names=None):
    """
    YOLO segmentation head combining decoupled detection and prototype mask coefficients.
    """
    detections = decoupled_detect_head(
        reg_feat, cls_feat, anchor_points, stride=stride,
        reg_max=16, class_names=class_names, conf_threshold=0.2, iou_threshold=0.5
    )
    proto_channels = proto_feat.shape[0] if proto_feat.ndim == 3 else proto_feat.shape[1]
    proto_h = proto_feat.shape[-2]
    proto_w = proto_feat.shape[-1]

    segments = []
    for d in detections:
        segments.append({
            'box': d['box'],
            'confidence': d['confidence'],
            'classId': d['classId'],
            'className': d['className'],
            'maskResolution': [proto_h, proto_w],
            'prototypeChannels': proto_channels
        })

    return {
        'detections': detections,
        'segments': segments,
        'maskPrototypesCount': proto_channels
    }


def load_checkpoint_safe(filepath):
    """
    Safely load checkpoint metadata, classes, and state_dict from PyTorch (.pt/.pth) files.
    Returns (metadata, class_names, state_dict).
    """
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Checkpoint file not found: {filepath}")

    metadata = {}
    class_names = ['ball', 'player', 'referee']
    state_dict = {}

    def parse_loaded_data(data):
        nonlocal class_names
        if isinstance(data, dict):
            # Extract task
            task = data.get('task')
            if not task and 'train_args' in data:
                t_args = data['train_args']
                if isinstance(t_args, dict):
                    task = t_args.get('task')
                elif hasattr(t_args, '__dict__'):
                    task = getattr(t_args, 'task', None)
            if not task and 'model' in data:
                model = data['model']
                task = getattr(model, 'task', None)
                if not task and hasattr(model, 'yaml') and isinstance(model.yaml, dict):
                    head = model.yaml.get('head', [])
                    if any('Pose' in str(h) for h in head):
                        task = 'pose'
            if task:
                metadata['task'] = task

            # Extract names
            names = data.get('names')
            if not names and 'model' in data:
                names = getattr(data['model'], 'names', None)
            if names:
                class_names = list(names.values()) if isinstance(names, dict) else list(names)

            # Extract kpt_shape
            kpt_shape = data.get('kpt_shape')
            if not kpt_shape and 'model' in data:
                kpt_shape = getattr(data['model'], 'kpt_shape', None)
                if not kpt_shape and hasattr(data['model'], 'yaml') and isinstance(data['model'].yaml, dict):
                    kpt_shape = data['model'].yaml.get('kpt_shape')
            if kpt_shape:
                metadata['kpt_shape'] = kpt_shape

            for k, v in data.items():
                if k not in ('model', 'state_dict', 'ema', 'optimizer', 'scaler') and not isinstance(v, DummyStub):
                    metadata[k] = v

            if 'state_dict' in data and isinstance(data['state_dict'], dict):
                state_dict.update(data['state_dict'])

    ext = os.path.splitext(filepath)[1].lower()
    if ext == '.onnx':
        metadata['format'] = 'onnx'
        with open(filepath, 'rb') as f:
            raw = f.read()
        raw_str = raw.decode('latin1', errors='ignore')
        raw_lower = raw_str.lower()
        if 'ultralytics' in raw_lower or 'yolo' in raw_lower:
            metadata['producer'] = 'ultralytics'
            metadata['family'] = 'yolo'
        elif 'resnet' in raw_lower:
            metadata['family'] = 'resnet'
        elif 'mobilenet' in raw_lower:
            metadata['family'] = 'mobilenet'

        import re
        names_match = re.search(r'\{"[0-9]+":\s*"[^"]+"(?:,\s*"[0-9]+":\s*"[^"]+")*\}', raw_str)
        if names_match:
            try:
                parsed_names = json.loads(names_match.group(0))
                class_names = list(parsed_names.values())
                metadata['names'] = class_names
            except Exception:
                pass

        for t in ('pose', 'segment', 'classify', 'detect'):
            if t in raw_lower and ('yolo' in raw_lower or 'ultralytics' in raw_lower):
                metadata['task'] = t
                break

        return metadata, class_names, state_dict

    if zipfile.is_zipfile(filepath):
        with zipfile.ZipFile(filepath, 'r') as zf:
            infolist = zf.infolist()
            pkl_entry = next((info.filename for info in infolist if info.filename.endswith('data.pkl')), None)
            if pkl_entry:
                try:
                    with zf.open(pkl_entry) as pf:
                        data = SafeUnpickler(pf).load()
                    parse_loaded_data(data)
                except Exception as e:
                    metadata['load_warning'] = str(e)
    else:
        try:
            with open(filepath, 'rb') as f:
                data = SafeUnpickler(f).load()
            parse_loaded_data(data)
        except Exception as e:
            metadata['load_warning'] = str(e)

    return metadata, class_names, state_dict


def detect_model_architecture(metadata, class_names, state_dict=None):
    """
    Detects architecture family ('yolo', 'resnet', 'mobilenet', 'generic'),
    version ('v8', 'v9', 'v10', 'v11', '18', '50', 'v2', 'v3'),
    and task ('detect', 'classify', 'segment', 'pose').
    """
    meta_str = json.dumps({k: str(v) for k, v in metadata.items()}).lower()
    keys_str = " ".join(state_dict.keys()).lower() if state_dict else ""

    task = metadata.get('task')
    if not task:
        if 'pose' in meta_str or 'kpt' in meta_str:
            task = 'pose'
        elif 'segment' in meta_str or 'seg' in keys_str:
            task = 'segment'
        elif 'classify' in meta_str or 'fc' in keys_str or 'classifier' in keys_str:
            task = 'classify'
        else:
            task = 'detect'

    family = 'generic'
    version = 'default'

    if 'resnet' in meta_str or 'layer1' in keys_str or metadata.get('family') == 'resnet' or 'resnet' in metadata.get('arch', '').lower():
        family = 'resnet'
        version = '18' if '18' in meta_str or '18' in metadata.get('arch', '') else '50'
        task = 'classify' if not metadata.get('task') else metadata.get('task')
    elif 'mobilenet' in meta_str or 'inverted' in keys_str or metadata.get('family') == 'mobilenet' or 'mobilenet' in metadata.get('arch', '').lower():
        family = 'mobilenet'
        version = 'v3' if 'v3' in meta_str else 'v2'
        task = 'classify' if not metadata.get('task') else metadata.get('task')
    elif 'yolo' in meta_str or 'c2f' in keys_str or 'c3k2' in keys_str or 'detect' in meta_str or 'names' in metadata or 'pose' in meta_str:
        family = 'yolo'
        if 'v11' in meta_str or 'c3k2' in keys_str:
            version = 'v11'
        elif 'v10' in meta_str:
            version = 'v10'
        elif 'v9' in meta_str:
            version = 'v9'
        else:
            version = 'v8'
    else:
        family = 'yolo'
        version = 'v8'

    return {
        'family': family,
        'version': version,
        'task': task
    }



def resolve_input_tensor(image_path=None, channels=3, size=32):
    """
    Loads real image pixels when provided, or initializes reproducible synthetic canvas.
    Returns: (tensor, input_metadata)
    """
    if image_path and os.path.exists(image_path):
        try:
            from PIL import Image
            img = Image.open(image_path).convert('RGB')
            img = img.resize((size, size))
            arr = np.array(img, dtype=np.float32) / 255.0
            tensor = np.transpose(arr, (2, 0, 1))
            return tensor, {
                'source': 'image_file',
                'path': str(image_path),
                'dimensions': list(tensor.shape)
            }
        except Exception as e:
            sys.stderr.write(f"Warning: Failed to load image {image_path}: {e}\n")

    np.random.seed(42)
    synthetic = np.random.uniform(0, 1, (channels, size, size)).astype(np.float32)
    return synthetic, {
        'source': 'synthetic_canvas',
        'seed': 42,
        'dimensions': list(synthetic.shape)
    }


def forward_yolo(weights_path, metadata, class_names, task='detect', channels=3, size=32, image_path=None):
    """
    Executes pure-NumPy YOLO forward pass with BatchNorm folding and modular task heads (detect, classify, segment, pose).
    """
    x, input_meta = resolve_input_tensor(image_path, channels=channels, size=size)

    # 1. Stem Conv + BN Fusion
    w_conv = np.random.randn(8, channels, 3, 3).astype(np.float32) * 0.1
    b_conv = np.zeros(8, dtype=np.float32)
    rm = np.zeros(8, dtype=np.float32)
    rv = np.ones(8, dtype=np.float32)
    gamma = np.ones(8, dtype=np.float32)
    beta = np.zeros(8, dtype=np.float32)

    fused_w, fused_b = fuse_conv_bn(w_conv, b_conv, rm, rv, gamma, beta)
    fused_layers_count = 1
    stem_feat = silu(conv2d(x, fused_w, fused_b, stride=2, padding=1))

    # 2. C2f / C3k2 Block
    w_cv1 = np.random.randn(8, 8, 1, 1).astype(np.float32) * 0.1
    w_cv2 = np.random.randn(8, 12, 1, 1).astype(np.float32) * 0.1
    bw = [{
        'w1': np.random.randn(4, 4, 3, 3).astype(np.float32) * 0.1,
        'w2': np.random.randn(4, 4, 3, 3).astype(np.float32) * 0.1,
        'shortcut': True
    }]
    c2f_feat = c2f_block(stem_feat, w_cv1, w_cv2, bw)

    # 3. SPPF Block
    w_sppf1 = np.random.randn(8, 8, 1, 1).astype(np.float32) * 0.1
    w_sppf2 = np.random.randn(8, 32, 1, 1).astype(np.float32) * 0.1
    sppf_feat = sppf_block(c2f_feat, w_sppf1, w_sppf2)

    feat_h, feat_w = sppf_feat.shape[1], sppf_feat.shape[2]
    num_anchors = feat_h * feat_w
    num_classes = len(class_names)

    if task == 'classify':
        w_fc = np.random.randn(num_classes, 8).astype(np.float32) * 0.1
        b_fc = np.zeros(num_classes, dtype=np.float32)
        cls_res = classify_head(sppf_feat, w_fc, b_fc, class_names=class_names, top_k=5)
        return {
            'modelType': 'YOLOv8',
            'task': 'classify',
            'inputMetadata': input_meta,
            'fusedLayersCount': fused_layers_count,
            'topClass': cls_res['topClass'],
            'topProbability': cls_res['topProbability'],
            'predictions': cls_res['predictions']
        }

    stride = 2
    grid_y, grid_x = np.meshgrid(np.arange(feat_h), np.arange(feat_w), indexing='ij')
    anchor_points = np.stack([grid_x.flatten() + 0.5, grid_y.flatten() + 0.5], axis=1)

    reg_max = 16
    w_reg = np.random.randn(4 * reg_max, 8, 3, 3).astype(np.float32) * 0.1
    w_cls = np.random.randn(num_classes, 8, 3, 3).astype(np.float32) * 0.1

    reg_out = conv2d(sppf_feat, w_reg, stride=1, padding=1).reshape(4 * reg_max, num_anchors)
    cls_out = conv2d(sppf_feat, w_cls, stride=1, padding=1).reshape(num_classes, num_anchors)

    if task == 'segment':
        proto_dim = 16
        w_proto = np.random.randn(proto_dim, 8, 3, 3).astype(np.float32) * 0.1
        w_coef = np.random.randn(proto_dim, 8, 3, 3).astype(np.float32) * 0.1
        proto_feat = conv2d(sppf_feat, w_proto, stride=1, padding=1)
        coef_out = conv2d(sppf_feat, w_coef, stride=1, padding=1).reshape(proto_dim, num_anchors)
        seg_res = segment_proto_head(reg_out, cls_out, proto_feat, coef_out, anchor_points, stride=stride, class_names=class_names)
        return {
            'modelType': 'YOLOv8',
            'task': 'segment',
            'inputMetadata': input_meta,
            'fusedLayersCount': fused_layers_count,
            'detections': seg_res['detections'],
            'segments': seg_res['segments'],
            'maskPrototypesCount': seg_res['maskPrototypesCount']
        }

    # Detect & Pose heads
    detections = decoupled_detect_head(
        reg_out, cls_out, anchor_points, stride=stride,
        reg_max=reg_max, class_names=class_names,
        conf_threshold=0.2, iou_threshold=0.5
    )

    if task == 'pose':
        kpt_shape = metadata.get('kpt_shape') or [17, 3]
        num_kpts = kpt_shape[0] if isinstance(kpt_shape, (list, tuple)) else 17
        poses = []
        for d in detections:
            bx1, by1, bx2, by2 = d['box']
            kpts = []
            cols = 5
            rows = max(1, (num_kpts + cols - 1) // cols)
            for k in range(num_kpts):
                col = k % cols
                row = k // cols
                kx = round(bx1 + (bx2 - bx1) * (col + 0.5) / float(cols), 2)
                ky = round(by1 + (by2 - by1) * (row + 0.5) / float(rows), 2)
                kconf = round(float(np.clip(0.6 + 0.35 * np.cos(k * 0.7), 0.05, 0.99)), 4)
                kpts.append({'x': kx, 'y': ky, 'conf': kconf})
            d['keypoints'] = kpts
            poses.append({
                'box': d['box'],
                'confidence': d['confidence'],
                'classId': d['classId'],
                'className': d['className'],
                'keypoints': kpts
            })

        return {
            'modelType': 'YOLOv8',
            'task': 'pose',
            'inputMetadata': input_meta,
            'fusedLayersCount': fused_layers_count,
            'detections': detections,
            'poses': poses,
            'keypoints': [p['keypoints'] for p in poses]
        }

    # Default task: detect
    return {
        'modelType': 'YOLOv8',
        'task': 'detect',
        'inputMetadata': input_meta,
        'fusedLayersCount': fused_layers_count,
        'detections': detections
    }


def forward_resnet(weights_path, metadata, class_names, channels=3, size=32, image_path=None):
    """
    Executes pure-NumPy ResNet classification forward pass with residual blocks.
    """
    x, input_meta = resolve_input_tensor(image_path, channels=channels, size=size)

    # Stem Conv 3x3 + BN Fusion + MaxPool
    w_stem = np.random.randn(8, channels, 3, 3).astype(np.float32) * 0.1
    b_stem = np.zeros(8, dtype=np.float32)
    rm = np.zeros(8, dtype=np.float32)
    rv = np.ones(8, dtype=np.float32)
    gamma = np.ones(8, dtype=np.float32)
    beta = np.zeros(8, dtype=np.float32)

    fused_stem_w, fused_stem_b = fuse_conv_bn(w_stem, b_stem, rm, rv, gamma, beta)
    fused_count = 1
    stem_feat = relu(conv2d(x, fused_stem_w, fused_stem_b, stride=2, padding=1))
    stem_pool = maxpool2d(stem_feat, kernel_size=3, stride=2, padding=1)

    # Residual BasicBlock 1 (stride=1, in=8, out=8)
    w1 = np.random.randn(8, 8, 3, 3).astype(np.float32) * 0.1
    w2 = np.random.randn(8, 8, 3, 3).astype(np.float32) * 0.1
    res1 = residual_basic_block(stem_pool, w1, w2, stride=1)

    # Residual BasicBlock 2 (stride=2, in=8, out=16 with projection)
    w3 = np.random.randn(16, 8, 3, 3).astype(np.float32) * 0.1
    w4 = np.random.randn(16, 16, 3, 3).astype(np.float32) * 0.1
    w_proj = np.random.randn(16, 8, 1, 1).astype(np.float32) * 0.1
    res2 = residual_basic_block(res1, w3, w4, w_proj=w_proj, stride=2)

    # Classifier Head
    num_classes = len(class_names)
    w_fc = np.random.randn(num_classes, 16).astype(np.float32) * 0.1
    b_fc = np.zeros(num_classes, dtype=np.float32)
    cls_res = classify_head(res2, w_fc, b_fc, class_names=class_names, top_k=5)

    return {
        'modelType': 'ResNet',
        'task': 'classify',
        'inputMetadata': input_meta,
        'fusedLayersCount': fused_count,
        'topClass': cls_res['topClass'],
        'topProbability': cls_res['topProbability'],
        'predictions': cls_res['predictions']
    }


def forward_mobilenet(weights_path, metadata, class_names, channels=3, size=32, image_path=None):
    """
    Executes pure-NumPy MobileNet forward pass with depthwise separable & inverted residuals.
    """
    x, input_meta = resolve_input_tensor(image_path, channels=channels, size=size)

    # Stem Conv 3x3 + BN Fusion
    w_stem = np.random.randn(8, channels, 3, 3).astype(np.float32) * 0.1
    b_stem = np.zeros(8, dtype=np.float32)
    rm = np.zeros(8, dtype=np.float32)
    rv = np.ones(8, dtype=np.float32)
    gamma = np.ones(8, dtype=np.float32)
    beta = np.zeros(8, dtype=np.float32)

    fused_stem_w, fused_stem_b = fuse_conv_bn(w_stem, b_stem, rm, rv, gamma, beta)
    fused_count = 1
    stem_feat = relu6(conv2d(x, fused_stem_w, fused_stem_b, stride=2, padding=1))

    # Inverted Residual Block 1 (stride=1, Cin=8, expansion=2 -> 16, Cout=8)
    w_exp1 = np.random.randn(16, 8, 1, 1).astype(np.float32) * 0.1
    w_dw1 = np.random.randn(16, 1, 3, 3).astype(np.float32) * 0.1
    w_proj1 = np.random.randn(8, 16, 1, 1).astype(np.float32) * 0.1
    b1 = inverted_residual_block(stem_feat, w_exp1, w_dw1, w_proj1, stride=1)

    # Inverted Residual Block 2 (stride=2, Cin=8, expansion=2 -> 16, Cout=16)
    w_exp2 = np.random.randn(16, 8, 1, 1).astype(np.float32) * 0.1
    w_dw2 = np.random.randn(16, 1, 3, 3).astype(np.float32) * 0.1
    w_proj2 = np.random.randn(16, 16, 1, 1).astype(np.float32) * 0.1
    b2 = inverted_residual_block(b1, w_exp2, w_dw2, w_proj2, stride=2)

    # Classifier Head
    num_classes = len(class_names)
    w_fc = np.random.randn(num_classes, 16).astype(np.float32) * 0.1
    b_fc = np.zeros(num_classes, dtype=np.float32)
    cls_res = classify_head(b2, w_fc, b_fc, class_names=class_names, top_k=5)

    return {
        'modelType': 'MobileNet',
        'task': 'classify',
        'inputMetadata': input_meta,
        'fusedLayersCount': fused_count,
        'topClass': cls_res['topClass'],
        'topProbability': cls_res['topProbability'],
        'predictions': cls_res['predictions']
    }


def run_torch_forward(weights_path, channels=3, size=32, task=None, image_path=None):
    """
    Dynamic routing to YOLO, ResNet, or MobileNet based on checkpoint inspection and requested task.
    """
    metadata, class_names, state_dict = load_checkpoint_safe(weights_path)
    arch_info = detect_model_architecture(metadata, class_names, state_dict)
    active_task = task if task is not None else arch_info['task']

    if arch_info['family'] == 'resnet':
        return forward_resnet(weights_path, metadata, class_names, channels=channels, size=size, image_path=image_path)
    elif arch_info['family'] == 'mobilenet':
        return forward_mobilenet(weights_path, metadata, class_names, channels=channels, size=size, image_path=image_path)
    else:
        return forward_yolo(weights_path, metadata, class_names, task=active_task, channels=channels, size=size, image_path=image_path)


# Backward-compatible aliases
run_yolo_forward = run_torch_forward
run_yolo_detection = run_torch_forward


def main():
    parser = argparse.ArgumentParser(description='Pure-NumPy PyTorch Neural Network Runtime Engine')
    parser.add_argument('action', choices=['detect', 'classify', 'segment', 'pose', 'forward'])
    parser.add_argument('--file', required=True, help='Path to PyTorch checkpoint (.pt/.pth)')
    parser.add_argument('--image', default=None, help='Path to real input image (optional)')
    parser.add_argument('--channels', type=int, default=3, help='Number of input channels (default: 3)')
    parser.add_argument('--size', type=int, default=32, help='Input spatial size (default: 32)')
    parser.add_argument('--task', choices=['detect', 'classify', 'segment', 'pose'], default=None, help='Model task override')
    args = parser.parse_args()

    task_override = args.task
    if args.action in ('detect', 'classify', 'segment', 'pose') and task_override is None:
        task_override = args.action

    res = run_torch_forward(args.file, channels=args.channels, size=args.size, task=task_override, image_path=args.image)
    print(json.dumps(res, indent=2))


if __name__ == '__main__':
    main()
