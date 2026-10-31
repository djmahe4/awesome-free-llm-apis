import fs from 'node:fs/promises';

/**
 * Remove a temp directory a test created. A background task (a deployed harness run, a debounced save) can
 * still be writing for a moment after the test body returns, and a single removal then fails with ENOTEMPTY
 * on Windows CI. Retrying for about a second covers that without hiding a real failure for long.
 */
export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
