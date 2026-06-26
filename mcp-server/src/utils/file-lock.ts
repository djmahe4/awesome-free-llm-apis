import { promises as fs } from 'fs';
import path from 'path';

/**
 * Executes a function holding an exclusive lock on the specified file.
 * Uses atomic file creation (flag 'wx') to ensure concurrency safety.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
    const lockPath = `${filePath}.lock`;
    const start = Date.now();
    
    while (true) {
        try {
            // Ensure the directory exists
            await fs.mkdir(path.dirname(lockPath), { recursive: true });
            // Attempt to create the lock file atomically
            await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
            break; // Lock acquired successfully
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                if (Date.now() - start > timeoutMs) {
                    throw new Error(`Timeout waiting for lock on file: ${filePath}`);
                }
                // Wait and retry
                await new Promise(resolve => setTimeout(resolve, 50));
            } else {
                throw err;
            }
        }
    }
    
    try {
        return await fn();
    } finally {
        try {
            await fs.unlink(lockPath);
        } catch {
            // Non-blocking cleanup fallback
        }
    }
}
