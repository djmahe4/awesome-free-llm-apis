#!/usr/bin/env python3
"""Separate audio into actual Demucs htdemucs stems using local weights only."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from typing import Any

import numpy as np

STEM_NAMES = ("vocals", "drums", "bass", "other")
WINDOW_SECONDS = 20
MAX_DURATION_SECONDS = 600


def _wav_info(path: str) -> tuple[int, int, int, int] | None:
    """Return sample rate, channels, sample width, and frame count for PCM WAV."""
    try:
        with wave.open(path, "rb") as wf:
            if wf.getcomptype() != "NONE":
                return None
            return wf.getframerate(), wf.getnchannels(), wf.getsampwidth(), wf.getnframes()
    except Exception:
        return None


def _probe_duration_frames(path: str, sample_rate: int) -> int:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe is required to enforce duration limits for compressed audio")
    completed = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError("ffprobe could not inspect input duration: " + completed.stderr.strip()[:500])
    try:
        duration = float(completed.stdout.strip())
    except ValueError as exc:
        raise RuntimeError("ffprobe returned an invalid input duration") from exc
    if not np.isfinite(duration) or duration <= 0:
        raise RuntimeError("Input audio has invalid or zero duration")
    return int(round(duration * sample_rate))


def _prepare_audio(path: str, sample_rate: int, channels: int, duration_cap_seconds: int) -> tuple[str, bool, int, int]:
    """Prepare seekable PCM while limiting compressed-input decoding to the requested duration."""
    info = _wav_info(path)
    if info and info[0] == sample_rate and info[1] == channels and info[2] in (1, 2, 4):
        return path, False, info[3], info[2]

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to decode or convert this input audio")
    total_frames = info[3] * sample_rate // info[0] if info else _probe_duration_frames(path, sample_rate)
    fd, converted_path = tempfile.mkstemp(prefix="audio-input-", suffix=".wav")
    os.close(fd)
    try:
        completed = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", path, "-t", str(duration_cap_seconds), "-vn", "-ar", str(sample_rate),
             "-ac", str(channels), "-acodec", "pcm_s16le", converted_path],
            capture_output=True,
            text=True,
            check=False,
            timeout=max(120, duration_cap_seconds * 2),
        )
        if completed.returncode != 0:
            raise RuntimeError("ffmpeg could not decode input audio: " + completed.stderr.strip()[:500])
        converted_info = _wav_info(converted_path)
        if not converted_info or converted_info[:2] != (sample_rate, channels) or converted_info[2] != 2:
            raise RuntimeError("ffmpeg produced an unreadable or incompatible WAV file")
        return converted_path, True, max(total_frames, converted_info[3]), converted_info[2]
    except Exception:
        if os.path.exists(converted_path):
            os.unlink(converted_path)
        raise


def _decode_pcm(raw: bytes, sample_width: int, channels: int) -> np.ndarray:
    dtypes = {1: np.uint8, 2: np.int16, 4: np.int32}
    if sample_width not in dtypes:
        raise RuntimeError("Unsupported PCM sample width")
    samples = np.frombuffer(raw, dtype=dtypes[sample_width]).astype(np.float32)
    if sample_width == 1:
        samples = (samples - 128.0) / 128.0
    else:
        samples /= float(2 ** (8 * sample_width - 1))
    return samples.reshape(-1, channels)


def _pcm_bytes(audio: np.ndarray) -> bytes:
    samples = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    return (samples * 32767.0).astype("<i2").tobytes()


def _new_metrics() -> dict[str, Any]:
    return {
        "energy": 0.0,
        "sample_count": 0,
        "magnitude_sum": 0.0,
        "weighted_magnitude_sum": 0.0,
        "crossings": 0,
        "comparisons": 0,
        "last_sample": None,
    }


def _update_metrics(metrics: dict[str, Any], audio: np.ndarray, sample_rate: int) -> None:
    mono = np.mean(audio, axis=1) if audio.ndim > 1 else audio
    magnitude = np.abs(np.fft.rfft(mono))
    frequencies = np.fft.rfftfreq(len(mono), 1.0 / sample_rate)
    metrics["energy"] += float(np.sum(np.square(audio)))
    metrics["sample_count"] += int(audio.size)
    metrics["magnitude_sum"] += float(np.sum(magnitude))
    metrics["weighted_magnitude_sum"] += float(np.sum(frequencies * magnitude))
    crossings = int(np.count_nonzero(np.signbit(mono[1:]) != np.signbit(mono[:-1])))
    comparisons = max(len(mono) - 1, 0)
    previous = metrics["last_sample"]
    if previous is not None and len(mono):
        crossings += int(np.signbit(previous) != np.signbit(mono[0]))
        comparisons += 1
    metrics["crossings"] += crossings
    metrics["comparisons"] += comparisons
    metrics["last_sample"] = float(mono[-1]) if len(mono) else previous


def _finish_metrics(metrics: dict[str, Any]) -> dict[str, float]:
    sample_count = max(int(metrics["sample_count"] or 0), 1)
    magnitude_sum = float(metrics["magnitude_sum"] or 0.0)
    return {
        "rms_power": round(float(metrics["energy"] or 0.0) / sample_count, 6),
        "spectral_centroid": round(
            float(metrics["weighted_magnitude_sum"] or 0.0) / (magnitude_sum + 1e-10), 4
        ),
        "zero_crossing_rate": round(
            int(metrics["crossings"] or 0) / max(int(metrics["comparisons"] or 0), 1), 6
        ),
    }


def _not_available(message: str) -> dict[str, Any]:
    return {
        "status": "not_available",
        "backend": "demucs",
        "model": "htdemucs",
        "stems": {},
        "error": message,
        "learning_notes": "Real stem separation requires Demucs htdemucs and a configured local checkpoint.",
    }


def separate_audio(
    path: str,
    requested_stems: str,
    output_dir: str | None = None,
    duration_cap_seconds: int = MAX_DURATION_SECONDS,
) -> dict[str, Any]:
    """Run local, windowed Demucs inference and persist complete WAV stems."""
    model_path = os.environ.get("DEMUCS_MODEL_PATH", "").strip()
    if not model_path or not os.path.isfile(model_path):
        return _not_available(
            "Set DEMUCS_MODEL_PATH to an existing local Demucs htdemucs checkpoint; no weights were downloaded."
        )

    try:
        import torch
        from demucs.apply import apply_model
        from demucs.states import load_model
    except Exception as exc:
        return _not_available("Demucs is not installed or usable locally: " + str(exc))

    run_dir = None
    prepared_path = None
    remove_prepared = False
    writers: dict[str, wave.Wave_write] = {}
    try:
        checkpoint = torch.load(model_path, map_location='cpu', weights_only=True)
        model = load_model(checkpoint)
        if not all(hasattr(model, name) for name in ("sources", "samplerate", "audio_channels")):
            raise RuntimeError("The configured checkpoint is not a compatible Demucs model")
        if set(model.sources) != set(STEM_NAMES):
            raise RuntimeError("The configured checkpoint does not provide htdemucs vocals/drums/bass/other stems")
        model.eval()
        model.to("cpu")

        sample_rate = int(model.samplerate)
        channels = int(model.audio_channels)
        cap = min(max(int(duration_cap_seconds), 1), MAX_DURATION_SECONDS)
        prepared_path, remove_prepared, total_frames, sample_width = _prepare_audio(path, sample_rate, channels, cap)
        frames_to_process = min(total_frames, sample_rate * cap)
        if frames_to_process <= 0:
            raise RuntimeError("Input audio contains no frames")

        parent_dir = os.path.abspath(output_dir) if output_dir else tempfile.gettempdir()
        os.makedirs(parent_dir, exist_ok=True)
        if not os.path.isdir(parent_dir):
            raise RuntimeError("Output path is not a directory")
        run_dir = tempfile.mkdtemp(prefix="audio-stems-", dir=parent_dir)

        selected = [name.strip() for name in requested_stems.split(",") if name.strip()]
        if not selected:
            selected = list(STEM_NAMES)
        unknown = [name for name in selected if name not in model.sources]
        if unknown:
            raise RuntimeError("Unsupported stem name(s): " + ", ".join(unknown))
        source_indexes = {name: model.sources.index(name) for name in selected}
        metrics = {name: _new_metrics() for name in selected}
        stem_paths = {name: os.path.join(run_dir, name + ".wav") for name in selected}
        for name, stem_path in stem_paths.items():
            writer = wave.open(stem_path, "wb")
            writer.setnchannels(channels)
            writer.setsampwidth(2)
            writer.setframerate(sample_rate)
            writers[name] = writer

        window_frames = sample_rate * WINDOW_SECONDS
        processed_frames = 0
        with wave.open(prepared_path, "rb") as source:
            while processed_frames < frames_to_process:
                count = min(window_frames, frames_to_process - processed_frames)
                raw = source.readframes(count)
                audio = _decode_pcm(raw, sample_width, channels)
                if len(audio) != count:
                    raise RuntimeError("Input audio ended before its declared frame count")
                mixture = torch.from_numpy(audio.T.copy()).unsqueeze(0)
                with torch.no_grad():
                    separated = apply_model(
                        model, mixture, device="cpu", shifts=1, split=True,
                        overlap=0.25, progress=False, num_workers=0,
                    )
                if separated.ndim == 4:
                    separated = separated[0]
                if separated.ndim != 3 or separated.shape[0] != len(model.sources):
                    raise RuntimeError("Demucs returned an unexpected stem tensor shape")
                if separated.shape[-1] != count:
                    raise RuntimeError("Demucs returned a stem with an unexpected duration")
                separated = separated.detach().cpu().numpy()
                for name in selected:
                    stem_audio = separated[source_indexes[name]].T
                    _update_metrics(metrics[name], stem_audio, sample_rate)
                    writers[name].writeframesraw(_pcm_bytes(stem_audio))
                processed_frames += count

        for writer in writers.values():
            writer.close()
        writers.clear()
        duration = processed_frames / sample_rate
        return {
            "status": "ok",
            "backend": "demucs",
            "model": "htdemucs",
            "output_dir": run_dir,
            "duration_seconds": duration,
            "sample_rate": sample_rate,
            "truncated": processed_frames < total_frames,
            "stems": {
                name: {
                    **_finish_metrics(metrics[name]),
                    "path": os.path.abspath(stem_paths[name]),
                }
                for name in selected
            },
            "learning_notes": "Complete WAV stems were produced by local windowed Demucs htdemucs inference.",
        }
    except Exception as exc:
        for writer in writers.values():
            try:
                writer.close()
            except Exception:
                pass
        if run_dir:
            shutil.rmtree(run_dir, ignore_errors=True)
        return {
            "status": "failure",
            "backend": "demucs",
            "model": "htdemucs",
            "stems": {},
            "error": str(exc),
        }
    finally:
        if remove_prepared and prepared_path and os.path.exists(prepared_path):
            os.unlink(prepared_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Local Demucs audio stem separation")
    parser.add_argument("action", choices=("separate_audio_stems",))
    parser.add_argument("--file", required=True, help="Path to audio file")
    parser.add_argument("--method", default="htdemucs")
    parser.add_argument("--stems", default="vocals,drums,bass,other")
    parser.add_argument("--output-dir", help="Parent directory for persisted WAV stems")
    parser.add_argument(
        "--max-duration-seconds", type=int, default=MAX_DURATION_SECONDS,
        help=f"Maximum processed duration (hard limit: {MAX_DURATION_SECONDS}s)",
    )
    args = parser.parse_args()

    if args.method not in ("htdemucs", "demucs"):
        result = _not_available("Unsupported separation method: " + args.method)
    elif not os.path.isfile(args.file):
        result = {
            "status": "failure", "backend": "demucs", "model": "htdemucs",
            "stems": {}, "error": "Input audio file does not exist: " + args.file,
        }
    else:
        result = separate_audio(
            args.file, args.stems, args.output_dir, args.max_duration_seconds
        )
    json.dump(result, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
