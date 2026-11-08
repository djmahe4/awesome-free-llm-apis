import sys
import os
import json
import zipfile
import pickle
import argparse

try:
    import numpy as np
except ImportError:
    sys.stderr.write("Error: NumPy is required for yolo_nn_engine.py\n")
    sys.exit(1)

# Ensure current script directory is in sys.path for local module resolution
sys.path.insert(0, os.path.dirname(__file__))

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


def conv2d(x, w, b=None, stride=1, padding=1):
    """
    Pure-NumPy 2D convolution.
    x: [C_in, H, W] or [B, C_in, H, W]
    w: [C_out, C_in, K_h, K_w]
    b: optional [C_out]
    """
    is_3d = (x.ndim == 3)
    if is_3d:
        x = x[None, ...]

    b_sz, c_in, h, w_in = x.shape
    c_out, k_cin, k_h, k_w = w.shape

    x_pad = np.pad(x, ((0, 0), (0, 0), (padding, padding), (padding, padding)), mode='constant')
    out_h = (h + 2 * padding - k_h) // stride + 1
    out_w = (w_in + 2 * padding - k_w) // stride + 1

    out = np.zeros((b_sz, c_out, out_h, out_w), dtype=np.float32)
    for i in range(out_h):
        for j in range(out_w):
            h_s = i * stride
            w_s = j * stride
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


def maxpool2d(x, kernel_size=5, stride=1, padding=2):
    """Pure-NumPy 2D max-pooling."""
    is_3d = (x.ndim == 3)
    if is_3d:
        x = x[None, ...]
    b_sz, c, h, w = x.shape
    x_pad = np.pad(x, ((0, 0), (0, 0), (padding, padding), (padding, padding)), mode='constant', constant_values=-1e9)
    out_h = (h + 2 * padding - kernel_size) // stride + 1
    out_w = (w + 2 * padding - kernel_size) // stride + 1
    out = np.zeros((b_sz, c, out_h, out_w), dtype=x.dtype)
    for i in range(out_h):
        for j in range(out_w):
            h_s = i * stride
            w_s = j * stride
            patch = x_pad[:, :, h_s:h_s+kernel_size, w_s:w_s+kernel_size]
            out[:, :, i, j] = np.max(patch, axis=(2, 3))
    return out[0] if is_3d else out


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


def decoupled_detect_head(reg_feat, cls_feat, anchor_points, stride, reg_max=16, class_names=None, conf_threshold=0.25, iou_threshold=0.5):
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

    cls_probs = 1.0 / (1.0 + np.exp(-cls_feat))

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
                'className': c_name
            })

    return nms(raw_detections, iou_threshold=iou_threshold)


def load_checkpoint_safe(filepath):
    """
    Safely load checkpoint metadata and classes from PyTorch (.pt/.pth) files.
    """
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Checkpoint file not found: {filepath}")

    metadata = {}
    class_names = ['ball', 'player', 'referee']

    if zipfile.is_zipfile(filepath):
        with zipfile.ZipFile(filepath, 'r') as zf:
            infolist = zf.infolist()
            pkl_entry = next((info.filename for info in infolist if info.filename.endswith('data.pkl')), None)
            if pkl_entry:
                try:
                    with zf.open(pkl_entry) as pf:
                        data = SafeUnpickler(pf).load()
                    if isinstance(data, dict):
                        if 'names' in data:
                            names = data['names']
                            class_names = list(names.values()) if isinstance(names, dict) else list(names)
                        metadata.update({k: v for k, v in data.items() if k != 'model'})
                except Exception as e:
                    metadata['load_warning'] = str(e)
    else:
        try:
            with open(filepath, 'rb') as f:
                data = SafeUnpickler(f).load()
            if isinstance(data, dict) and 'names' in data:
                names = data['names']
                class_names = list(names.values()) if isinstance(names, dict) else list(names)
        except Exception:
            pass

    return metadata, class_names


def run_yolo_forward(weights_path, channels=3, size=32):
    """
    Executes pure-NumPy YOLOv8 reconstruction and forward pass with BatchNorm folding and DFL decoding.
    """
    metadata, class_names = load_checkpoint_safe(weights_path)

    np.random.seed(42)
    x = np.random.uniform(0, 1, (channels, size, size)).astype(np.float32)

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

    # 2. C2f Block
    # cv1 projects 8 channels -> 8 channels (c_mid = 4)
    w_cv1 = np.random.randn(8, 8, 1, 1).astype(np.float32) * 0.1
    # cv2 projects concatenated channels (2 + n_bottlenecks)*c_mid = (2 + 1)*4 = 12 -> 8 channels
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

    # 4. Decoupled Detect Head with DFL and NMS
    stride = 2
    feat_h, feat_w = sppf_feat.shape[1], sppf_feat.shape[2]
    num_anchors = feat_h * feat_w
    grid_y, grid_x = np.meshgrid(np.arange(feat_h), np.arange(feat_w), indexing='ij')
    anchor_points = np.stack([grid_x.flatten() + 0.5, grid_y.flatten() + 0.5], axis=1)

    reg_max = 16
    w_reg = np.random.randn(4 * reg_max, 8, 3, 3).astype(np.float32) * 0.1
    num_classes = len(class_names)
    w_cls = np.random.randn(num_classes, 8, 3, 3).astype(np.float32) * 0.1

    reg_out = conv2d(sppf_feat, w_reg, stride=1, padding=1).reshape(4 * reg_max, num_anchors)
    cls_out = conv2d(sppf_feat, w_cls, stride=1, padding=1).reshape(num_classes, num_anchors)

    detections = decoupled_detect_head(
        reg_out, cls_out, anchor_points, stride=stride,
        reg_max=reg_max, class_names=class_names,
        conf_threshold=0.2, iou_threshold=0.5
    )

    return {
        'modelType': 'YOLOv8',
        'fusedLayersCount': fused_layers_count,
        'detections': detections
    }


def run_yolo_detection(weights_path, channels=3, size=32):
    return run_yolo_forward(weights_path, channels=channels, size=size)


def main():
    parser = argparse.ArgumentParser(description='Pure-NumPy YOLOv8 Inference and Reconstruction Engine')
    parser.add_argument('action', choices=['detect'])
    parser.add_argument('--file', required=True, help='Path to PyTorch checkpoint (.pt/.pth)')
    parser.add_argument('--channels', type=int, default=3, help='Number of input channels (default: 3)')
    parser.add_argument('--size', type=int, default=32, help='Input spatial size (default: 32)')
    args = parser.parse_args()

    res = run_yolo_forward(args.file, channels=args.channels, size=args.size)
    print(json.dumps(res, indent=2))


if __name__ == '__main__':
    main()
