import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const pythonBin = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const scriptsDir = path.resolve(__dirname, '../scripts');

function runPy(code: string): Record<string, any> {
  const raw = execFileSync(pythonBin, ['-c', code], {
    timeout: 30000,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: scriptsDir },
  });
  return JSON.parse(raw.trim());
}

describe('Scenario-adaptable 3D parallax & boundary noise removal (TDD)', () => {
  it('Scenario 1 (Sphere): rejects corner shirt/stripe leaks and produces genuine 3D spherical wrap', () => {
    const res = runPy(`
import json, numpy as np
import depth_parallax_engine as dpe

H, W = 220, 220
img = np.full((H, W, 3), 18.0, dtype=np.float32)
# White shirt collar/stripe in top-right bbox corner right outside the ball circle
img[12:48, 165:205] = [245.0, 245.0, 245.0]
yy, xx = np.indices((H, W), dtype=np.float32)
r = np.hypot(xx - 110.0, yy - 110.0)
in_ball = r <= 78.0
img[in_ball] = [235.0, 235.0, 235.0]
# Vertical red stripe right through ball center so 3D rotation shift is unmistakable
stripe = in_ball & (np.abs(xx - 110.0) <= 10.0)
img[stripe] = [210.0, 25.0, 25.0]

# Saturated/flat foreground depth on ball like Depth Anything V2 Small on close spheres
dm = np.full((H, W), 0.72, dtype=np.float32)
dm[in_ball] = 0.99

bbox = (25, 25, 195, 195)
mask = dpe.create_object_mask(img, bbox, mask_type="sphere", depth_map=dm)
corner_leak = float(mask[26:48, 168:194].mean())

rot, metrics = dpe.run_bbox_object_pseudo3d_transform(
    img, bbox=bbox, yaw=30.0, pitch=10.0, mask_type="sphere", inpaint_background=False, depth_map=dm
)
# Track red stripe centroid shift inside central ball band y in [95..125]
band = rot[95:125, 40:180]
red_score = band[:, :, 0].astype(np.float32) - 0.5 * (band[:, :, 1].astype(np.float32) + band[:, :, 2].astype(np.float32))
col_weights = np.maximum(red_score.mean(axis=0) - 20.0, 0.0)
xs_band = np.arange(40, 180, dtype=np.float32)
new_cx = float((xs_band * col_weights).sum() / max(float(col_weights.sum()), 1e-5))
print(json.dumps({"corner_leak": corner_leak, "stripe_shift_px": new_cx - 110.0, "rot_pixels": metrics["object_pixels_transformed"]}))
`);
    expect(res.corner_leak).toBeLessThan(0.05);
    expect(Math.abs(res.stripe_shift_px)).toBeGreaterThanOrEqual(12.0);
  });

  it('Scenario 2 (Fullbody 3D Relief): protruding center body features shift relative to torso plane instead of flat paper tilt', () => {
    const res = runPy(`
import json, numpy as np
import depth_parallax_engine as dpe

H, W = 260, 220
img = np.full((H, W, 3), [35.0, 90.0, 45.0], dtype=np.float32)
# Body rectangle + bright vertical nose/chest marker sticking out in depth
img[40:230, 65:155] = [25.0, 25.0, 30.0]
img[85:175, 106:114] = [240.0, 210.0, 180.0]

dm = np.full((H, W), 0.15, dtype=np.float32)
dm[40:230, 65:155] = 0.64
# Protruding nose/hand/chest relief like frame_0001 referee depth
dm[80:180, 96:124] = 0.88

bbox = (55, 30, 165, 240)
rot_3d, _ = dpe.run_bbox_object_pseudo3d_transform(
    img, bbox=bbox, yaw=25.0, pitch=0.0, mask_type="rect", inpaint_background=False, depth_map=dm
)
# Compare against planar paper rotation (flat depth)
dm_flat = np.full((H, W), 0.70, dtype=np.float32)
rot_flat, _ = dpe.run_bbox_object_pseudo3d_transform(
    img, bbox=bbox, yaw=25.0, pitch=0.0, mask_type="rect", inpaint_background=False, depth_map=dm_flat
)
band3d = rot_3d[110:150, 60:160].mean(axis=0)[:, 0]
band_fl = rot_flat[110:150, 60:160].mean(axis=0)[:, 0]
xs = np.arange(60, 160, dtype=np.float32)
w3d = np.maximum(band3d - 60.0, 0.0)
wfl = np.maximum(band_fl - 60.0, 0.0)
c3d = float((xs * w3d).sum() / max(float(w3d.sum()), 1e-5))
cfl = float((xs * wfl).sum() / max(float(wfl.sum()), 1e-5))
print(json.dumps({"diff_vs_paper_px": abs(c3d - cfl)}))
`);
    expect(res.diff_vs_paper_px).toBeGreaterThanOrEqual(4.5);
  });

  it('Scenario 3 (Scene Parallax + Boundary Noise Removal): suppresses goalkeeper/midground ghosts and staircase edge noise', () => {
    const res = runPy(`
import json, numpy as np
import depth_parallax_engine as dpe

H, W = 240, 320
img = np.zeros((H, W, 3), dtype=np.float32)
# Deep dark crowd on left/top
img[:, :] = [28.0, 26.0, 30.0]
# Red arch pillar right of center (matches frame_0050 geometry where x > cx)
img[40:230, 195:290] = [195.0, 50.0, 42.0]
# Blue goalkeeper straddling dark crowd (x=175..195) & red arch (x=195..235) on right side
img[60:210, 175:235] = [20.0, 58.0, 185.0]
# Strong foreground referee on left
img[20:230, 35:95] = [20.0, 20.0, 22.0]

dm = np.full((H, W), 0.03, dtype=np.float32)
dm[40:230, 195:290] = 0.38
dm[60:210, 175:235] = 0.33
dm[20:230, 35:95] = 0.74

out, _ = dpe.run_continuous_pseudo3d_parallax(
    img, depth_map=dm, azimuth=4.0, elevation=2.0, dolly=15.0, pan=5.0, depth_layers=16
)
# 1) Blue goalkeeper shifts rightward (> cx=160); exposed crowd gap immediately left (x=155..175) must stay dark, no blue ghost
gap = out[80:180, 155:175]
blue_dom = np.maximum(gap[:, :, 2].astype(np.float32) - gap[:, :, 0].astype(np.float32), 0.0)
blue_leak_mean = float(blue_dom.mean())
# 2) Red arch right border transition (x=285..315) should stay clean (no jagged high-frequency salt/pepper noise)
edge_strip = out[50:220, 285:315, :].astype(np.float32)
lap = float(np.abs(np.diff(edge_strip, axis=0)).mean())
print(json.dumps({"blue_leak_mean": blue_leak_mean, "arch_edge_noise": lap}))
`);
    expect(res.blue_leak_mean).toBeLessThan(8.0);
    expect(res.arch_edge_noise).toBeLessThan(6.0);
  });
});
