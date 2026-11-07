import { runReverseTool } from '../../src/tools/reverse-tool.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSmoke() {
  console.log('=== RUNNING SMOKE: Reverse Model Artifacts Pipeline ===');
  const gguf = path.resolve(__dirname, '../../tests/fixtures/models/tiny.gguf');
  const pt = path.resolve(__dirname, '../../tests/fixtures/models/tiny.pt');
  const onnx = path.resolve(__dirname, '../../tests/fixtures/models/tiny.onnx');
  const tmpCache = path.join(os.tmpdir(), `smoke-cache-${Date.now()}`);

  // Check 1: GGUF Inspection
  console.log('[1/6] Inspecting GGUF artifact...');
  const resGguf = await runReverseTool({ action: 'inspect_model', target: gguf, authorization: 'lab', options: { format: 'gguf' } });
  if (!resGguf.success || (resGguf.data as any).format !== 'gguf') throw new Error('GGUF inspection failed');
  console.log('   ✓ GGUF validated (architecture: ' + (resGguf.data as any).architecture + ')');

  // Check 2: PyTorch State Dict & Metadata Inspection
  console.log('[2/6] Inspecting PyTorch artifact...');
  const resPt = await runReverseTool({ action: 'inspect_model', target: pt, authorization: 'lab', options: { format: 'pytorch' } });
  if (!resPt.success || (resPt.data as any).format !== 'pytorch') throw new Error('PyTorch inspection failed');
  console.log('   ✓ PyTorch validated (classes: ' + (resPt.data as any).metadata.classes.join(', ') + ')');

  // Check 3: Semantic Layer Purpose Inversion
  console.log('[3/6] Inferring semantic layer roles...');
  const resRoles = await runReverseTool({ action: 'infer_layer_roles', target: gguf, authorization: 'lab', options: { format: 'gguf' } });
  if (!resRoles.success || (resRoles.data as any).layers.length === 0) throw new Error('Layer role inference failed');
  console.log('   ✓ Inferred ' + (resRoles.data as any).totalLayers + ' layer roles (' + (resRoles.data as any).layers[0].semanticRole + ')');

  // Check 4: Sequential Layer Forward Tracing & Cached Handoff
  console.log('[4/6] Tracing forward execution with cached layer handoffs...');
  const resTrace = await runReverseTool({ action: 'trace_layer_execution', target: gguf, authorization: 'lab', options: { cacheDir: tmpCache, format: 'gguf' } });
  if (!resTrace.success || (resTrace.data as any).steps.length < 2) throw new Error('Layer execution trace failed');
  console.log('   ✓ Traced ' + (resTrace.data as any).steps.length + ' layer handoffs with cached activation files');

  // Check 5: Layer Statistics Profiling
  console.log('[5/6] Profiling layer statistics...');
  const resStats = await runReverseTool({ action: 'analyze_model_layer', target: gguf, authorization: 'lab', options: { layer: 'blk.0.attn_q.weight', format: 'gguf' } });
  if (!resStats.success || !(resStats.data as any).frobeniusNorm) throw new Error('Layer analysis failed');
  console.log('   ✓ Frobenius Norm: ' + (resStats.data as any).frobeniusNorm);

  // Check 6: Dataset Exemplar Reconstruction (Activation Maximization)
  console.log('[6/6] Testing dataset exemplar reconstruction (consent gated)...');
  const resRecon = await runReverseTool({
    action: 'reconstruct_training_samples',
    target: pt,
    authorization: 'consent',
    options: { explicitConsentAck: true, targetClass: 0, steps: 10, format: 'pytorch' },
  });
  if (!resRecon.success || (resRecon.data as any).memorizationRiskScore === undefined) throw new Error('Sample reconstruction failed');
  console.log('   ✓ Synthesized prototype for class: ' + (resRecon.data as any).className + ' (Risk: ' + (resRecon.data as any).memorizationRiskScore + ')');

  if (fs.existsSync(tmpCache)) {
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }
  console.log('=== ALL MODEL ARTIFACT SMOKE CHECKS PASSED CLEANLY ===');
}

runSmoke().catch((e) => {
  console.error('Smoke check failed:', e);
  process.exit(1);
});
