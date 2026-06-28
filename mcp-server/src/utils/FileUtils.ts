import { promises as fsp } from 'fs';
import * as path from 'path';

// In-memory locks per file path to prevent concurrent rename collisions (especially on Windows)
const fileLocks = new Map<string, Promise<void>>();

/**
 * Writes content to a file atomically by writing to a temporary file first
 * and then renaming it. This prevents corruption from concurrent writes.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    
    // Wait for any existing write on this file path to complete
    const existingLock = fileLocks.get(absolutePath);
    let resolveLock: (() => void) | undefined;
    const newLock = new Promise<void>(resolve => {
        resolveLock = resolve;
    });
    fileLocks.set(absolutePath, newLock);

    if (existingLock) {
        await existingLock;
    }

    try {
        const dir = path.dirname(absolutePath);
        // Ensure directory exists
        await fsp.mkdir(dir, { recursive: true });
        
        const tempPath = `${absolutePath}.${Math.random().toString(36).substring(2, 8)}.tmp`;
        try {
            await fsp.writeFile(tempPath, content, 'utf-8');
            await fsp.rename(tempPath, absolutePath);
        } catch (err) {
            // Cleanup temp file if write/rename failed
            try {
                await fsp.unlink(tempPath);
            } catch {}
            throw err;
        }
    } finally {
        // Clean up the lock map if we are the latest lock
        if (fileLocks.get(absolutePath) === newLock) {
            fileLocks.delete(absolutePath);
        }
        resolveLock?.();
    }
}
