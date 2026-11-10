#!/usr/bin/env python3
"""OCR Token Bounding & Layout Inspection Engine.

Detects text tokens with spatial bounding coordinates, confidence scoring,
and reading-order/layout-hierarchy reconstruction.

Image inputs use OpenCV preprocessing + Tesseract (pytesseract) when the
binary is present, falling back to connected-component text-region detection
otherwise. PDF/document inputs use PyMuPDF (fitz) for exact vector glyph
coordinates.

Usage:
  python ocr_engine.py inspect_ocr_tokens --file <image_or_pdf_path>
"""

import argparse
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    import cv2
    _HAS_CV2 = True
except Exception:
    _HAS_CV2 = False

try:
    import warnings as _warnings
    with _warnings.catch_warnings():
        _warnings.simplefilter("ignore")
        _HAS_FITZ = False
        try:
            import pymupdf as _pymupdf
            fitz = _pymupdf
            _HAS_FITZ = True
        except Exception:
            try:
                import fitz
                _HAS_FITZ = True
            except Exception:
                pass
except Exception:
    _HAS_FITZ = False

try:
    import pytesseract
    _HAS_TESSERACT = True
except Exception:
    _HAS_TESSERACT = False

if _HAS_TESSERACT:
    try:
        pytesseract.get_tesseract_version()
    except Exception:
        _HAS_TESSERACT = False


def classify_token(text: str) -> str:
    """Syntactic token classification."""
    t = text.strip()
    if not t:
        return "empty"
    lowered = t.lower()
    if t.isupper() and len(t) <= 40:
        return "label"
    if any(ch.isdigit() for ch in t) and sum(ch.isdigit() for ch in t) / max(len(t), 1) > 0.5:
        return "numeric"
    if lowered in {"vs", "live", "home", "away", "final", "half", "score",
                   "odds", "bets", "most"} or lowered.endswith("odds"):
        return "keyword"
    if len(t) > 3 and t[0].isupper():
        return "entity"
    return "word"


def _line_reading_order(words: List[Dict[str, Any]]) -> List[int]:
    """Order token indices by Top-to-Bottom then Left-to-Right."""
    enumerated = sorted(
        range(len(words)),
        key=lambda i: (words[i]["bbox"][1] // 12, words[i]["bbox"][0]),
    )
    return enumerated


def group_layout_lines(words: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Cluster words into text lines, then cluster lines into blocks.

    Returns list of blocks: {block_bbox, line_count, line_bboxes} ordered by
    reading order. Each line gets mean-token classification synergy later.
    """
    # Group by mid-Y with tolerance (line bucket via rounded y center)
    lines: List[Tuple[int, List[int]]] = []
    order = _line_reading_order(words)
    for idx in order:
        y_mid = words[idx]["bbox"][1] + words[idx]["bbox"][3] // 2
        placed = False
        for li, (bucket_y, members) in enumerate(lines):
            if abs(bucket_y - y_mid) <= max(8, words[idx]["bbox"][3] // 2 + 4):
                members.append(idx)
                lines[li] = (bucket_y, members)
                placed = True
                break
        if not placed:
            lines.append((y_mid, [idx]))

    blocks: List[Dict[str, Any]] = []
    pending: List[Tuple[int, List[int]]] = []
    for bucket_y, members in lines:
        members = sorted(members, key=lambda i: words[i]["bbox"][0])
        line_bbox = merge_bboxes([words[i]["bbox"] for i in members])
        if pending and abs(bucket_y - pending[-1][0]) <= 18:
            pending.append((bucket_y, members))
        else:
            if pending:
                blocks.append(_make_block(pending, words))
            pending = [(bucket_y, members)]
    if pending:
        blocks.append(_make_block(pending, words))
    return blocks


def _make_block(pending: List[Tuple[int, List[int]]], words: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """Build one layout block from clustered lines."""
    line_bboxes: List[List[int]] = []
    block_members: List[int] = []
    for _, members in pending:
        line_bbox = merge_bboxes([words[i]["bbox"] for i in members])
        line_bboxes.append(line_bbox)
        block_members.extend(members)
    block_members = sorted(block_members, key=lambda i: (words[i]["bbox"][1], words[i]["bbox"][0]))
    return {
        "type": "text_block",
        "bbox": merge_bboxes(line_bboxes),
        "line_count": len(line_bboxes),
        "line_bboxes": line_bboxes,
        "token_ids": block_members,
        "representative_type": classify_token(
            " ".join(words[i]["text"] for i in block_members[:6])
        ),
    }


def merge_bboxes(bboxes: List[List[int]]) -> List[int]:
    """Merge [x, y, w, h] boxes into the union box."""
    x0 = min(b[0] for b in bboxes)
    y0 = min(b[1] for b in bboxes)
    x1 = max(b[0] + b[2] for b in bboxes)
    y1 = max(b[1] + b[3] for b in bboxes)
    return [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]


def detect_regions_connected_components(img: np.ndarray) -> List[Tuple[int, int, int, int]]:
    """Fallback text-region detection via MSER-like connected components."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 100, 200)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (13, 5))
    dilated = cv2.dilate(edges, kernel, iterations=1)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dilated, connectivity=8)
    return [(s[0], s[1], s[2], s[3]) for s in stats[1:] if s[2] > 8 and s[3] > 6]


def inspect_ocr_tokens(file_path: str) -> Dict[str, Any]:
    """Main OCR inspection routine for image or PDF targets."""
    lower = file_path.lower()
    if lower.endswith(".pdf") and _HAS_FITZ:
        return _inspect_pdf_tokens(file_path)
    if _HAS_CV2:
        return _inspect_image_tokens(file_path)
    return {
        "tokens": [],
        "reading_order": [],
        "layout_blocks": [],
        "learning_notes": (
            "OCR token bounding engine requires OpenCV (cv2) or PyMuPDF (fitz). "
            "Neither dependency is importable in this environment; spatial "
            "grounding indices returned empty."
        ),
    }


def _classify_word_line_groups(words: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return group_layout_lines(words)


def ocr_error_result(reason: str) -> Dict[str, Any]:
    return {
        "tokens": [],
        "reading_order": [],
        "layout_blocks": [],
        "learning_notes": (
            "OCR engine could not extract tokens from the provided target. "
            f"Reason: {reason}. Spatial grounding requires a decodable raster "
            "image or structured PDF with extracted glyph coordinates."
        ),
    }


def _inspect_image_tokens(file_path: str) -> Dict[str, Any]:
    if not os.path.isfile(file_path):
        return ocr_error_result("file does not exist")

    img = cv2.imread(file_path)
    if img is None:
        return ocr_error_result("cv2.imread returned None (unsupported or corrupt image)")

    tokens: List[Dict[str, Any]] = []
    if _HAS_TESSERACT:
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

        def _collect(data: Optional[Dict[str, Any]], psm: int, min_conf: float) -> List[Dict[str, Any]]:
            collected: List[Dict[str, Any]] = []
            if data is None:
                return collected
            for i in range(len(data.get("text", []))):
                text = str(data["text"][i]).strip()
                try:
                    conf_f = float(data["conf"][i])
                except (TypeError, ValueError):
                    conf_f = -1.0
                if not text or conf_f < min_conf:
                    continue
                collected.append({
                    "text": text,
                    "bbox": [int(data["left"][i]), int(data["top"][i]),
                             int(data["width"][i]), int(data["height"][i])],
                    "confidence": round(conf_f / 100.0, 4),
                    "source": "tesseract",
                    "ocr_psm": psm,
                })
            return collected

        try:
            raw = pytesseract.image_to_data(rgb, output_type=pytesseract.Output.DICT)
        except Exception:
            raw = None
        tokens = _collect(raw, 6, 0.0)
        if len(tokens) < 3:
            # Sparse-text mode for video-frame overlays and scattered content
            try:
                raw11 = pytesseract.image_to_data(
                    rgb, config="--psm 11", output_type=pytesseract.Output.DICT
                )
            except Exception:
                raw11 = None
            tokens = _collect(raw11, 11, 50.0)

    if not tokens:
        # Fallback: connected-component text regions (no symbol recognition)
        regions = detect_regions_connected_components(img)
        for x, y, w, h in regions[:120]:
            tokens.append({
                "text": "",
                "bbox": [int(x), int(y), int(w), int(h)],
                "confidence": 0.3,
                "source": "connected_components",
            })
        learning_tail = (
            "OCR token bounding engine (OpenCV connected-component fallback). "
            "Tesseract symbol recognition is unavailable in this environment, so "
            "text regions are detected geometrically without glyph transcription. "
        )
    else:
        learning_tail = (
            "OCR token bounding engine (OpenCV preprocessing + Tesseract). "
        )

    tokens = tokens[:400]

    # Classification and synergy
    for tok in tokens:
        tok["token_type"] = classify_token(tok["text"]) if tok["source"] == "tesseract" else "text_region"

    reading_order = _line_reading_order(tokens)
    layout_blocks = _classify_word_line_groups(tokens)

    h_img, w_img = img.shape[:2]
    result: Dict[str, Any] = {
        "image_size": {"width": int(w_img), "height": int(h_img)},
        "tokens": tokens,
        "reading_order": reading_order,
        "layout_blocks": layout_blocks,
        "learning_notes": (
            "Spatial Grounding: Vision-Language Models (DocVQA, LayoutLM, Qwen-VL) "
            "fuse 2D bounding coordinates with token embeddings so each symbol "
            "becomes a grounded spatial event. Linear language modeling orders "
            "tokens along a single axis; document comprehension additionally uses "
            "2D spatial cross-attention over [x, y, w, h] boxes and layout "
            "hierarchies (lines -> blocks -> regions). Confidence scoring reflects "
            "per-glyph recognition reliability. "
            + learning_tail
        ),
    }
    return result


def _inspect_pdf_tokens(file_path: str) -> Dict[str, Any]:
    if not os.path.isfile(file_path):
        return ocr_error_result("file does not exist")

    tokens: List[Dict[str, Any]] = []
    try:
        doc = fitz.open(file_path)
    except Exception as exc:
        return ocr_error_result(f"pdf open failed: {exc}")

    page_count = min(doc.page_count, 3)
    for page_index, page in enumerate(doc):
        words = page.get_text("words") or []
        for x0, y0, x1, y1, text, *_rest in words:
            text = str(text).strip()
            if not text:
                continue
            conf = 0.97
            if len(text) > 0 and text[0].isupper() and text[-1].isalnum():
                conf = 0.98
            tokens.append({
                "text": text,
                "bbox": [int(x0), int(y0), int(max(x1 - x0, 1)), int(max(y1 - y0, 1))],
                "confidence": conf,
                "source": "pymupdf_glyph",
                "token_type": classify_token(text),
                "page": page_index + 1,
            })
        if page_index >= 2:
            break
    doc.close()

    reading_order = _line_reading_order(tokens)
    layout_blocks = _classify_word_line_groups(tokens)

    return {
        "pages_examined": page_count,
        "tokens": tokens[:400],
        "reading_order": reading_order,
        "layout_blocks": layout_blocks,
        "learning_notes": (
            "Spatial Grounding: PyMuPDF extracts exact vector glyph coordinates "
            "from PDF text objects, yielding oracle-strength bounding boxes with "
            "near-perfect confidence. This teaches layout-vs-OCR tradeoffs: "
            "structured document formats carry their own 2D geometry while raster "
            "scenes require learned detection. LayoutLM-style models pretrain on "
            "[x, y, w, h] coordinates projected into the embedding space via "
            "separate 2D position encodings."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", type=str, help="Engine action, e.g. inspect_ocr_tokens")
    parser.add_argument("--file", type=str, required=True, help="Target image or PDF path")
    parser.add_argument("--format", type=str, default=None)
    parser.add_argument("--output", type=str, default=None)
    args = parser.parse_args()

    if args.action != "inspect_ocr_tokens":
        result = ocr_error_result(f"unknown action '{args.action}'")
        json.dump(result, sys.stdout, separators=(",", ":"))
        sys.exit(1)

    result = inspect_ocr_tokens(args.file)

    if args.output:
        with open(os.path.abspath(args.output), "w", encoding="utf-8") as fh:
            json.dump(result, fh, separators=(",", ":"))
        sys.exit(0)

    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.exit(0)


if __name__ == "__main__":
    main()
