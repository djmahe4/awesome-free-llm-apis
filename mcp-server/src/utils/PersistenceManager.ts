import fs from 'fs-extra';
import path from 'path';
import os from 'os';

/**
 * Tracks usage data that needs to be persisted across sessions and processes.
 */
export interface PersistentUsage {
  lastResetDate: string; // YYYY-MM-DD
  dailyTotalRequests: number;
  dailyTotalTokens: number;
  lifetimeTotalRequests: number;
  lifetimeTotalTokens: number;
  providers: Record<string, {
    lastSyncTime: number;
    localTotalRequests: number;
    localTotalTokens: number;
    // We might also want to cache the last known global remaining counts
    remainingRequests?: number | null;
    remainingTokens?: number | null;
  }>;
}

export class PersistenceManager {
  private filePath: string;
  private isLocal: boolean = false;

  constructor(customPath?: string) {
    this.filePath = customPath || this.resolvePath();
  }

  /**
   * Resolves the persistence path:
   * 1. Check current directory for .mcp-usage.json
   * 2. Fallback to ~/.free-llm-mcp/usage-stats.json
   */
  private resolvePath(): string {
    const localPath = path.join(process.cwd(), '.mcp-usage.json');
    try {
      if (fs.existsSync(localPath)) {
        // Test writability
        fs.accessSync(localPath, fs.constants.W_OK);
        this.isLocal = true;
        return localPath;
      }
    } catch (e) {
      // Not writable or doesn't exist
    }

    const homeDir = os.homedir();
    const globalDir = path.join(homeDir, '.free-llm-mcp');
    const globalPath = path.join(globalDir, 'usage-stats.json');

    return globalPath;
  }

  /**
   * Initializes the directory if it doesn't exist
   */
  async ensureStorage(): Promise<boolean> {
    try {
      if (!this.isLocal) {
        await fs.ensureDir(path.dirname(this.filePath));
      }
      return true;
    } catch (e) {
      console.error('Failed to ensure storage directory:', e);
      return false;
    }
  }

  /**
   * Reads and merges stats from disk with memory
   */
  async load(): Promise<PersistentUsage> {
    const emptyState: PersistentUsage = {
      lastResetDate: new Date().toISOString().split('T')[0],
      dailyTotalRequests: 0,
      dailyTotalTokens: 0,
      lifetimeTotalRequests: 0,
      lifetimeTotalTokens: 0,
      providers: {}
    };

    try {
      if (await fs.pathExists(this.filePath)) {
        const data = await fs.readJson(this.filePath);
        return this.handleDailyReset(data);
      }
    } catch (e) {
      console.error('Error loading usage stats:', e);
    }

    return emptyState;
  }

  /**
   * Checks for date rollover and resets daily counters if needed
   */
  private handleDailyReset(data: PersistentUsage): PersistentUsage {
    const today = new Date().toISOString().split('T')[0];
    if (data.lastResetDate !== today) {
      return {
        ...data,
        lastResetDate: today,
        dailyTotalRequests: 0,
        dailyTotalTokens: 0
      };
    }
    return data;
  }

  /**
   * Saves usage stats to disk using Read-Merge-Write for atomicity
   */
  async save(memoryState: PersistentUsage): Promise<void> {
    try {
      await this.ensureStorage();

      // Read current disk state for merging
      let diskState: PersistentUsage;
      try {
        diskState = await fs.readJson(this.filePath);
      } catch (e) {
        diskState = memoryState;
      }

      const merged = this.merge(diskState, memoryState);
      
      // Atomic write: write to tmp, then rename
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeJson(tmpPath, merged, { spaces: 2 });
      await fs.rename(tmpPath, this.filePath);
    } catch (e) {
      console.error('Error saving usage stats:', e);
    }
  }

  /**
   * Merges two usage states, favoring the most progress/latest sync
   */
  private merge(disk: PersistentUsage, memory: PersistentUsage): PersistentUsage {
    const today = new Date().toISOString().split('T')[0];
    
    // Determine the base state (handle reset if needed)
    const base = disk.lastResetDate === today ? disk : this.handleDailyReset(disk);
    
    // Merge global totals (additive)
    // Note: Since both processes might have incremented their locals, 
    // we should ideally track "deltas", but for simplicity here we favor max
    // if we assume they are independent counters. 
    // BETTER: If processes are concurrent, they each see a 'base' and add their session usage.
    // For this implementation, we assume memory is always the 'current session' state.
    
    const result: PersistentUsage = {
      lastResetDate: today,
      dailyTotalRequests: Math.max(base.dailyTotalRequests, memory.dailyTotalRequests),
      dailyTotalTokens: Math.max(base.dailyTotalTokens, memory.dailyTotalTokens),
      lifetimeTotalRequests: Math.max(base.lifetimeTotalRequests, memory.lifetimeTotalRequests),
      lifetimeTotalTokens: Math.max(base.lifetimeTotalTokens, memory.lifetimeTotalTokens),
      providers: { ...base.providers }
    };

    // Merge providers
    for (const [id, mProv] of Object.entries(memory.providers)) {
      const dProv = base.providers[id];
      if (!dProv || mProv.lastSyncTime > dProv.lastSyncTime) {
        result.providers[id] = mProv;
      } else {
        // Favor higher lifetime counts even if sync time is older (protection against clock skew)
        result.providers[id] = {
          ...dProv,
          localTotalRequests: Math.max(dProv.localTotalRequests, mProv.localTotalRequests),
          localTotalTokens: Math.max(dProv.localTotalTokens, mProv.localTotalTokens)
        };
      }
    }

    return result;
  }
}

export const persistence = new PersistenceManager();
