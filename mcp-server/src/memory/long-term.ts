import { promises as fs } from 'fs';
import path from 'path';
import { debounce } from '../utils/debounce.js';
import { withFileLock } from '../utils/file-lock.js';

export class LongTermMemory {
  private storePath: string;
  private data: Record<string, unknown> = {};
  private loaded = false;

  private debouncedPersist: (() => void) & { flush: () => void };

  constructor(storePath = './data/memory.json') {
    this.storePath = storePath;
    this.debouncedPersist = debounce(() => {
      this.persist().catch(err => console.error('Failed to persist memory:', err));
    }, 1000);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.storePath, 'utf-8');
      this.data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  private persistPromise: Promise<void> | null = null;

  private async persist(): Promise<void> {
    if (this.persistPromise) return this.persistPromise;

    this.persistPromise = (async () => {
      try {
        await fs.mkdir(path.dirname(this.storePath), { recursive: true });
        const tmpPath = `${this.storePath}.${Date.now()}.${Math.random().toString(36).substring(7)}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
        await fs.rename(tmpPath, this.storePath);
      } finally {
        this.persistPromise = null;
      }
    })();

    return this.persistPromise;
  }

  async save(key: string, value: unknown): Promise<void> {
    await withFileLock(this.storePath, async () => {
      this.loaded = false; // Force reloading from disk inside lock
      await this.ensureLoaded();
      this.data[key] = value;
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      const tmpPath = `${this.storePath}.${Date.now()}.${Math.random().toString(36).substring(7)}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
      await fs.rename(tmpPath, this.storePath);
    }, 5000);
  }

  async load(key: string): Promise<unknown | undefined> {
    await this.ensureLoaded();
    return this.data[key];
  }

  async delete(key: string): Promise<void> {
    await withFileLock(this.storePath, async () => {
      this.loaded = false; // Force reloading from disk inside lock
      await this.ensureLoaded();
      delete this.data[key];
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      const tmpPath = `${this.storePath}.${Date.now()}.${Math.random().toString(36).substring(7)}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
      await fs.rename(tmpPath, this.storePath);
    }, 5000);
  }

  async flush(): Promise<void> {
    await this.debouncedPersist.flush();
  }

  async list(): Promise<string[]> {
    await this.ensureLoaded();
    return Object.keys(this.data);
  }

  async getStats(): Promise<{ totalKeys: number; totalSizeBytes: number }> {
    await this.ensureLoaded();
    const json = JSON.stringify(this.data);
    return {
      totalKeys: Object.keys(this.data).length,
      totalSizeBytes: Buffer.byteLength(json, 'utf-8'),
    };
  }
}
