import { promises as fs } from 'fs';
import path from 'path';

export class LongTermMemory {
  private storePath: string;
  private data: Record<string, unknown> = {};
  private loaded = false;

  constructor(storePath = './data/memory.json') {
    this.storePath = storePath;
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

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  async save(key: string, value: unknown): Promise<void> {
    await this.ensureLoaded();
    this.data[key] = value;
    await this.persist();
  }

  async load(key: string): Promise<unknown | undefined> {
    await this.ensureLoaded();
    return this.data[key];
  }

  async delete(key: string): Promise<void> {
    await this.ensureLoaded();
    delete this.data[key];
    await this.persist();
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
