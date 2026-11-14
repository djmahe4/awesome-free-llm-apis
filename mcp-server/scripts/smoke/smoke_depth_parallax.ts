/**
 * @file smoke_depth_parallax.ts
 * @description End-to-End Smoke Test for Reverse Tool Depth Parallax & Boundary-Aware 3D Volumetric Engine.
 * Aligned with docs/plans/rev_tool.md Section 5.2 (animate_still / pseudo-3D parallax).
 *
 * Verifies on real 1080p footage (tests/fixtures/media/frames/):
 * 1. Scene Parallax + Homography: Continuous layered depth field with projective camera tilt, dolly, and pan.
 * 2. Scope 1 (Ball): Explicit-bbox 3D volumetric spin (yaw=30, pitch=10).
 * 3. Scope 2 (Referee): Full-body GrabCut with intact hairline to shorts, rotated in 3D relief (yaw=18, pitch=6, roll=-4).
 * 4. Scope 3 (Goalkeeper): Orange kit player explicit-bbox 3D rotation with Telea background inpainting (yaw=-15).
 * 5. Scope 4 (Profile): Close-up profile frame_0150.jpg isolated 3D turn (yaw=-15, pitch=4).
 * 6. Scope 5 (animate_still Orbit): 12-frame, 12 fps orbital camera trajectory outputting animated GIF.
 * 7. Scope 6 (animate_still Ball Spin): 12-frame, 12 fps volumetric 3D ball spin sequence outputting animated GIF.
 * 8. Scope 7 (animate_still Referee Spin): Multi-frame object_spin on frame_0001.jpg explicit referee bbox.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { handleReverseTool } from '../../src/tools/reverse-tool.js';

interface SmokeResult {
  scope: string;
  action: string;
  target: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  transformedPixels?: number;
  stabilityScore?: number;
  outputFile?: string;
  notes?: string;
}

const results: SmokeResult[] = [];

async function run() {
  console.log('=======================================================================');
  console.log('=== Reverse Tool: 3D Boundary-Aware Parallax Engine Smoke Test Suite ===');
  console.log('=======================================================================');

  const framesDir = path.resolve(process.cwd(), 'tests/fixtures/media/frames');
  const frame0001 = path.join(framesDir, 'frame_0001.jpg');
  const frame0050 = path.join(framesDir, 'frame_0050.jpg');
  const frame0150 = path.join(framesDir, 'frame_0150.jpg');
  const outDir = path.resolve(process.cwd(), 'tests/tmp/smoke');
  const depthMode = process.env.DEPTH_ANYTHING_MODEL_PATH ? 'model' : 'heuristic';

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (const frame of [frame0001, frame0050, frame0150]) {
    if (!fs.existsSync(frame)) {
      console.error(`[-] Fixture frame not found at ${frame}`);
      process.exit(1);
    }
  }

  console.log(`[+] Found 1080p real match frames in ${framesDir}`);
  console.log(`[+] Depth mode: ${depthMode} (DEPTH_ANYTHING_MODEL_PATH=${process.env.DEPTH_ANYTHING_MODEL_PATH || 'unset'})`);

  // Test 1: Continuous Scene Parallax + Projective Homography
  {
    console.log('\n[1/8] Testing Continuous Scene Parallax + Homography (yaw=4°, pitch=2°, dolly=15mm, pan=5px)...');
    const t0 = Date.now();
    const outImg = path.join(outDir, 'smoke_scene_parallax.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'continuous_parallax',
        depthMode,
        yaw: 4.0,
        pitch: 2.0,
        dolly: 15.0,
        pan: 5.0,
        output: outImg,
        syncBudgetMs: 90000,
      },
    });

    const duration = Date.now() - t0;
    const data = res.data as any;
    const ok = res.success && data?.ok === true && fs.existsSync(outImg) && data?.metrics?.homography_applied === true;
    results.push({
      scope: 'Scene Parallax',
      action: 'run_depth_parallax',
      target: 'frame_0050.jpg (Layered Scene)',
      status: ok ? 'PASS' : 'FAIL',
      durationMs: duration,
      outputFile: path.basename(outImg),
      notes: `Backend=${data?.depth_backend}, Entropy=${data?.metrics?.depth_entropy_bits}, OutOfFrame=${data?.metrics?.out_of_frame_ratio}`,
    });
  }

  // Test 2: Boundary-Aware Match Ball 3D Rotation
  {
    console.log('\n[2/8] Testing Boundary-Aware 3D Volumetric Match Ball Spin (yaw=30°, pitch=10°)...');
    const t0 = Date.now();
    const outImg = path.join(outDir, 'smoke_ball_boundary_aware.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode,
        bbox: [652, 465, 896, 675],
        maskType: 'sphere',
        yaw: 30.0,
        pitch: 10.0,
        output: outImg,
        syncBudgetMs: 90000,
      },
    });

    const duration = Date.now() - t0;
    const data = res.data as any;
    const ok = res.success && data?.ok === true && fs.existsSync(outImg) && (data?.metrics?.object_pixels_transformed > 5000);
    results.push({
      scope: 'Object 3D (Ball)',
      action: 'run_depth_parallax',
      target: 'frame_0050.jpg [652,465,896,675]',
      status: ok ? 'PASS' : 'FAIL',
      durationMs: duration,
      transformedPixels: data?.metrics?.object_pixels_transformed,
      stabilityScore: data?.metrics?.background_stability_score,
      outputFile: path.basename(outImg),
      notes: `Retention=${data?.metrics?.foreground_retention_ratio}, Homography=${data?.metrics?.homography_applied}`,
    });
  }

  // Test 3: Full-Body Referee 3D Rotation (head-to-shorts, no hairline slice)
  {
    console.log('\n[3/8] Testing Full-Body Referee 3D Rotation (head to shorts, yaw=18°, pitch=6°, roll=-4°)...');
    const t0 = Date.now();
    const outImg = path.join(outDir, 'smoke_referee_fullbody.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode,
        bbox: [470, 35, 1060, 1075],
        maskType: 'grabcut',
        yaw: 18.0,
        pitch: 6.0,
        roll: -4.0,
        output: outImg,
        syncBudgetMs: 90000,
      },
    });

    const duration = Date.now() - t0;
    const data = res.data as any;
    const ok = res.success && data?.ok === true && fs.existsSync(outImg) && (data?.metrics?.object_pixels_transformed > 150000) && (data?.metrics?.foreground_retention_ratio > 0.85);
    results.push({
      scope: 'Object 3D (Referee)',
      action: 'run_depth_parallax',
      target: 'frame_0050.jpg [470,35,1060,1075]',
      status: ok ? 'PASS' : 'FAIL',
      durationMs: duration,
      transformedPixels: data?.metrics?.object_pixels_transformed,
      stabilityScore: data?.metrics?.background_stability_score,
      outputFile: path.basename(outImg),
      notes: `Retention=${data?.metrics?.foreground_retention_ratio}, Source=${data?.metrics?.depth_source}`,
    });
  }

  // Test 4: Goalkeeper Isolated 3D Transform
  {
    console.log('\n[4/8] Testing Goalkeeper Orange Kit 3D Rotation (yaw=-15°)...');
    const t0 = Date.now();
    const outImg = path.join(outDir, 'smoke_goalkeeper_3d.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode,
        bbox: [1470, 330, 1730, 990],
        maskType: 'grabcut',
        yaw: -15.0,
        output: outImg,
        syncBudgetMs: 90000,
      },
    });

    const duration = Date.now() - t0;
    const data = res.data as any;
    const ok = res.success && data?.ok === true && fs.existsSync(outImg) && (data?.metrics?.object_pixels_transformed > 20000);
    results.push({
      scope: 'Object 3D (Goalkeeper)',
      action: 'run_depth_parallax',
      target: 'frame_0050.jpg [1470,330,1730,990]',
      status: ok ? 'PASS' : 'FAIL',
      durationMs: duration,
      transformedPixels: data?.metrics?.object_pixels_transformed,
      stabilityScore: data?.metrics?.background_stability_score,
      outputFile: path.basename(outImg),
      notes: `Retention=${data?.metrics?.foreground_retention_ratio}, Stability=${data?.metrics?.background_stability_score}`,
    });
  }

  // Test 5: Close-up Profile (frame_0150.jpg) 3D Rotation
  {
    console.log('\n[5/8] Testing Profile Portrait 3D Rotation on frame_0150.jpg (yaw=-15°, pitch=4°)...');
    const t0 = Date.now();
    const outImg = path.join(outDir, 'smoke_profile_3d.png');
    const res = await handleReverseTool({
      action: 'run_depth_parallax',
      target: frame0150,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode,
        bbox: [0, 10, 820, 1080],
        maskType: 'grabcut',
        yaw: -15.0,
        pitch: 4.0,
        output: outImg,
        syncBudgetMs: 90000,
      },
    });

    const duration = Date.now() - t0;
    const data = res.data as any;
    const ok = res.success && data?.ok === true && fs.existsSync(outImg) && (data?.metrics?.foreground_retention_ratio > 0.80);
    results.push({
      scope: 'Object 3D (Profile)',
      action: 'run_depth_parallax',
      target: 'frame_0150.jpg [0,10,820,1080]',
      status: ok ? 'PASS' : 'FAIL',
      durationMs: duration,
      transformedPixels: data?.metrics?.object_pixels_transformed,
      stabilityScore: data?.metrics?.background_stability_score,
      outputFile: path.basename(outImg),
      notes: `Retention=${data?.metrics?.foreground_retention_ratio}`,
    });
  }

  // Test 6: animate_still Multi-Frame Orbital Camera Trajectory
  {
    console.log('\n[6/8] Testing animate_still Orbital Camera Path (12 frames, 12 fps, looping GIF)...');
    const t0 = Date.now();
    const outGif = path.join(outDir, 'smoke_animate_still_orbit.gif');
    const res = await handleReverseTool({
      action: 'animate_still',
      target: frame0050,
      authorization: 'lab',
      options: {
        depthMode,
        frames: 12,
        fps: 12,
        trajectory: 'orbit',
        azimuthAmp: 5.0,
        elevationAmp: 2.0,
        output: outGif,
        syncBudgetMs: 120000,
      },
    });

    const duration = Date.now() - t0;
    const data = res.data as any;
    const ok = res.success && data?.ok === true && fs.existsSync(outGif) && data?.frames_count === 12;
    results.push({
      scope: 'animate_still (Orbit)',
      action: 'animate_still',
      target: 'frame_0050.jpg (12f Orbit)',
      status: ok ? 'PASS' : 'FAIL',
      durationMs: duration,
      outputFile: path.basename(outGif),
      notes: `12-frame loop, size=${Math.round((data?.metrics?.file_size_bytes || 0) / 1024)}KB, duration=${data?.duration_sec}s`,
    });
  }

  // Test 7: animate_still Volumetric 3D Ball Spin
  {
    console.log('\n[7/8] Testing animate_still Volumetric 3D Ball Spin (12 frames, object_spin)...');
    const t0 = Date.now();
    const outGif = path.join(outDir, 'smoke_animate_still_ball_spin.gif');
    const res = await handleReverseTool({
      action: 'animate_still',
      target: frame0050,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode,
        bbox: [652, 465, 896, 675],
        maskType: 'sphere',
        frames: 12,
        fps: 12,
        trajectory: 'object_spin',
        output: outGif,
        syncBudgetMs: 120000,
      },
    });

    const duration = Date.now() - t0;
    const data = res.data as any;
    const ok = res.success && data?.ok === true && fs.existsSync(outGif) && data?.frames_count === 12;
    results.push({
      scope: 'animate_still (Ball)',
      action: 'animate_still',
      target: 'frame_0050.jpg [652,465,896,675]',
      status: ok ? 'PASS' : 'FAIL',
      durationMs: duration,
      outputFile: path.basename(outGif),
      notes: `12-frame ball spin, size=${Math.round((data?.metrics?.file_size_bytes || 0) / 1024)}KB`,
    });
  }

  // Test 8: animate_still Full Referee Spin on frame_0001.jpg
  {
    console.log('\n[8/8] Testing animate_still Referee 3D Spin on frame_0001.jpg (4 frames, object_spin)...');
    const t0 = Date.now();
    const outGif = path.join(outDir, 'smoke_animate_still_referee.gif');
    const res = await handleReverseTool({
      action: 'animate_still',
      target: frame0001,
      authorization: 'lab',
      options: {
        mode: 'object_3d_rotation',
        depthMode,
        bbox: [620, 20, 1220, 1080],
        maskType: 'grabcut',
        frames: 4,
        fps: 4,
        trajectory: 'object_spin',
        output: outGif,
        syncBudgetMs: 120000,
      },
    });

    const duration = Date.now() - t0;
    const data = res.data as any;
    const ok = res.success && data?.ok === true && fs.existsSync(outGif) && data?.frames_count === 4;
    results.push({
      scope: 'animate_still (Referee)',
      action: 'animate_still',
      target: 'frame_0001.jpg [620,20,1220,1080]',
      status: ok ? 'PASS' : 'FAIL',
      durationMs: duration,
      outputFile: path.basename(outGif),
      notes: `4-frame spin, size=${Math.round((data?.metrics?.file_size_bytes || 0) / 1024)}KB`,
    });
  }

  // Summary Table
  console.log('\n=======================================================================');
  console.log('=== Smoke Test Results Summary                                      ===');
  console.log('=======================================================================');

  let allPassed = true;
  for (const r of results) {
    const durStr = `${r.durationMs}ms`.padStart(7);
    const pixStr = r.transformedPixels ? `[${r.transformedPixels} px]` : '';
    const fileStr = r.outputFile ? `-> ${r.outputFile}` : '';
    console.log(`[${r.status}] [${r.scope.padEnd(23)}] ${durStr} ${pixStr} ${fileStr}`);
    if (r.notes) {
      console.log(`       └─ ${r.notes}`);
    }
    if (r.status !== 'PASS') allPassed = false;
  }

  console.log('=======================================================================');
  if (allPassed) {
    console.log('ALL 8 SMOKE TESTS PASSED!');
  } else {
    console.error('SOME SMOKE TESTS FAILED. Review outputs above.');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error running smoke tests:', err);
  process.exit(1);
});
