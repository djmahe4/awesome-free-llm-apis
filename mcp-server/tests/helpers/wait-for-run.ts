import type { HarnessStore } from '../../src/harness/store.js';

/**
 * Polls until a harness run's detached background work settles (status
 * leaves 'running'), instead of a fixed sleep guessing how long that takes.
 * A fixed sleep (200-400ms) passed reliably in isolation but flaked under
 * full-suite parallel load, where CPU contention across ~130 test files
 * pushed real settle time past the margin — this fixes the actual race
 * instead of enlarging the magic number again.
 */
export async function waitForSettled(store: HarnessStore, timeoutMs = 5000, stepMs = 20) {
  const start = Date.now();
  for (;;) {
    const run = await store.loadRun();
    if (run && run.status !== 'running') return run;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for run to leave 'running' (last status: ${run?.status})`);
    }
    await new Promise(r => setTimeout(r, stepMs));
  }
}
