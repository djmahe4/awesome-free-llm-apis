import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('Weight-Space Programming: Spectral Analysis & Attractor Surgery', () => {
  const scriptPath = path.resolve(__dirname, '../scripts/weight_space_programmer.py');
  const pythonBin = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

  // test spectrum on planted rank-1 attractor
  it('inspects weight spectrum of synthetic matrix with planted rank-1 attractor', () => {
    const pyCode = [
      'import sys, os, json',
      `sys.path.insert(0, os.path.dirname(r"""${scriptPath}"""))`,
      'from weight_space_programmer import create_synthetic_weight_matrix, inspect_weight_spectrum',
      'W = create_synthetic_weight_matrix(dim=64, rank=1, attractor_strength=12.0, seed=42)',
      'spec = inspect_weight_spectrum(W, top_k=10)',
      'print(json.dumps(spec))'
    ].join('\n');

    const raw = execFileSync(pythonBin, ['-c', pyCode], { timeout: 15000, encoding: 'utf8' });
    const spec = JSON.parse(raw);

    // S[0] dominates
    expect(spec.singularValues.length).toBeGreaterThanOrEqual(2);
    expect(spec.singularValues[0]).toBeGreaterThan(spec.singularValues[1] * 5);

    // effective rank small compared to full dim 64
    expect(spec.effectiveRank).toBeLessThan(45);
    expect(spec.effectiveRank).toBeGreaterThan(1);

    // top-1 energy high (>50% of total Frobenius energy)
    expect(spec.energyConcentration.top1).toBeGreaterThan(0.5);
    expect(spec.energyConcentration.top3).toBeGreaterThan(spec.energyConcentration.top1);
  });

  // test attractor ablation
  it('ablates rank-1 attractor direction: reduces S[0] by (1-alpha), increases effective rank, lowers frobenius', () => {
    const pyCode = [
      'import sys, os, json',
      `sys.path.insert(0, os.path.dirname(r"""${scriptPath}"""))`,
      'import numpy as np',
      'from weight_space_programmer import create_synthetic_weight_matrix, inspect_weight_spectrum, ablate_attractor_direction',
      'W = create_synthetic_weight_matrix(dim=64, rank=1, attractor_strength=10.0, seed=42)',
      'orig_spec = inspect_weight_spectrum(W, top_k=5)',
      'alpha = 0.5',
      'ablated_half, meta_half = ablate_attractor_direction(W, rank=1, alpha=alpha)',
      'spec_half = inspect_weight_spectrum(ablated_half, top_k=5)',
      'ablated_full, meta_full = ablate_attractor_direction(W, rank=1, alpha=1.0)',
      'spec_full = inspect_weight_spectrum(ablated_full, top_k=5)',
      'print(json.dumps({',
      '  "orig": orig_spec,',
      '  "half": spec_half,',
      '  "full": spec_full,',
      '  "meta_half": meta_half,',
      '  "meta_full": meta_full,',
      '  "alpha": alpha',
      '}))'
    ].join('\n');

    const raw = execFileSync(pythonBin, ['-c', pyCode], { timeout: 15000, encoding: 'utf8' });
    const res = JSON.parse(raw);

    const s0Orig = res.orig.singularValues[0];
    const s0Half = res.half.singularValues[0];

    // confirms S[0] reduced by factor (1 - alpha)
    const expectedHalf = (1.0 - res.alpha) * s0Orig;
    expect(Math.abs(s0Half - expectedHalf)).toBeLessThan(0.01);

    // confirms effective rank increases (recovering diversity / entropy)
    expect(res.half.effectiveRank).toBeGreaterThan(res.orig.effectiveRank);
    expect(res.full.effectiveRank).toBeGreaterThan(res.half.effectiveRank);

    // confirms Frobenius norm decreases
    expect(res.half.frobeniusNorm).toBeLessThan(res.orig.frobeniusNorm);
    expect(res.full.frobeniusNorm).toBeLessThan(res.half.frobeniusNorm);
  });

  // test loop attractor suppression
  it('suppresses loop attractor and verifies output activation along loop direction is attenuated by >50%', () => {
    const pyCode = [
      'import sys, os, json',
      `sys.path.insert(0, os.path.dirname(r"""${scriptPath}"""))`,
      'import numpy as np',
      'from weight_space_programmer import suppress_loop_attractor',
      'dim = 64',
      'rng = np.random.RandomState(42)',
      'W = rng.randn(dim, dim).astype(np.float32)',
      'loop_vec = rng.randn(dim).astype(np.float32)',
      'v_norm = loop_vec / (np.linalg.norm(loop_vec) + 1e-12)',
      'alpha = 0.6',
      'steered_W = suppress_loop_attractor(W, loop_vec, alpha=alpha)',
      'x = rng.randn(dim).astype(np.float32)',
      'y_orig = W @ x',
      'y_steered = steered_W @ x',
      'act_orig = float(np.dot(v_norm, y_orig))',
      'act_steered = float(np.dot(v_norm, y_steered))',
      'attenuation = float(1.0 - abs(act_steered) / (abs(act_orig) + 1e-12))',
      'print(json.dumps({',
      '  "act_orig": act_orig,',
      '  "act_steered": act_steered,',
      '  "attenuation": attenuation,',
      '  "alpha": alpha',
      '}))'
    ].join('\n');

    const raw = execFileSync(pythonBin, ['-c', pyCode], { timeout: 15000, encoding: 'utf8' });
    const res = JSON.parse(raw);

    // verifies output activation along loop direction attenuated by > 50%
    expect(res.attenuation).toBeGreaterThan(0.5);
    expect(Math.abs(res.attenuation - res.alpha)).toBeLessThan(1e-4);
  });

  // test CLI demo clean JSON output
  it('executes CLI demo command and produces valid clean JSON', () => {
    const raw = execFileSync(pythonBin, [scriptPath, 'demo'], { timeout: 15000, encoding: 'utf8' });
    const result = JSON.parse(raw);

    expect(result.status).toBe('success');
    expect(result.demo.dim).toBe(64);
    expect(result.demo.rank).toBe(1);
    expect(result.original_spectrum.effective_rank).toBeDefined();
    expect(result.ablated_spectrum.effective_rank).toBeGreaterThan(result.original_spectrum.effective_rank);
    expect(result.loop_suppression.attenuation).toBeGreaterThan(0.5);
    expect(result.loop_suppression.attenuated_over_50_pct).toBe(true);
  });

  // test SafeTensors file inspection & ablation roundtrip
  it('roundtrips SafeTensors inspection and ablated persistence', () => {
    const tmpSafeTensors = path.resolve(__dirname, 'fixtures/temp_layer.safetensors');
    try {
      const pyCode = [
        'import sys, os, json',
        `sys.path.insert(0, os.path.dirname(r"""${scriptPath}"""))`,
        'import numpy as np',
        'from weight_space_programmer import save_safetensors_layer, load_safetensors_layer, inspect_weight_spectrum',
        `tmp_path = r"""${tmpSafeTensors}"""`,
        'W = np.random.randn(32, 32).astype(np.float32)',
        'save_safetensors_layer(tmp_path, "layers.0.attn.weight", W, {"source": "unit_test"})',
        'loaded, info = load_safetensors_layer(tmp_path, "layers.0.attn.weight")',
        'spec = inspect_weight_spectrum(loaded)',
        'print(json.dumps({"info": info, "spec": spec, "equal": bool(np.allclose(W, loaded))}))'
      ].join('\n');

      const raw = execFileSync(pythonBin, ['-c', pyCode], { timeout: 15000, encoding: 'utf8' });
      const res = JSON.parse(raw);
      expect(res.equal).toBe(true);
      expect(res.info.name).toBe('layers.0.attn.weight');
      expect(res.spec.shape).toEqual([32, 32]);
    } finally {
      if (fs.existsSync(tmpSafeTensors)) {
        fs.unlinkSync(tmpSafeTensors);
      }
    }
  });
});
