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
    remainingRequests?: number | null;
    remainingTokens?: number | null;
    // Health Tracking Persistence
    failures?: number;
    lastFailure?: number;
    cooldownUntil?: number;
    totalErrors?: number;
  }>;
}

export class PersistenceManager {
  private filePath: string;
  private isLocal: boolean = false;
  private lastSavedState: PersistentUsage | null = null;

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
        const resetData = this.handleDailyReset(data);
        this.lastSavedState = JSON.parse(JSON.stringify(resetData));
        return resetData;
      }
    } catch (e) {
      console.error('Error loading usage stats:', e);
    }

    this.lastSavedState = JSON.parse(JSON.stringify(emptyState));
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
      const today = new Date().toISOString().split('T')[0];

      // Read current disk state for merging
      let diskState: PersistentUsage;
      try {
        diskState = await fs.readJson(this.filePath);
      } catch (e) {
        diskState = {
          lastResetDate: today,
          dailyTotalRequests: 0,
          dailyTotalTokens: 0,
          lifetimeTotalRequests: 0,
          lifetimeTotalTokens: 0,
          providers: {}
        };
      }

      const merged = this.merge(diskState, memoryState);
      
      // Atomic write: write to tmp, then rename
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeJson(tmpPath, merged, { spaces: 2 });
      await fs.rename(tmpPath, this.filePath);

      // Update baseline for next delta calculation
      this.lastSavedState = JSON.parse(JSON.stringify(memoryState));
    } catch (e) {
      console.error('Error saving usage stats:', e);
    }
  }

  /**
   * Merges two usage states, favoring the most progress/latest sync
   */
  private merge(disk: PersistentUsage, memory: PersistentUsage): PersistentUsage {
    const today = new Date().toISOString().split('T')[0];
    const base = disk.lastResetDate === today ? disk : this.handleDailyReset(disk);
    
    // Calculate deltas from last saved state
    const prev = this.lastSavedState || {
      lastResetDate: today,
      dailyTotalRequests: 0,
      dailyTotalTokens: 0,
      lifetimeTotalRequests: 0,
      lifetimeTotalTokens: 0,
      providers: {}
    };

    // If day changed locally, previous daily stats are irrelevant for delta
    const prevDailyReq = prev.lastResetDate === today ? prev.dailyTotalRequests : 0;
    const prevDailyTok = prev.lastResetDate === today ? prev.dailyTotalTokens : 0;

    const deltaDailyReq = Math.max(0, memory.dailyTotalRequests - prevDailyReq);
    const deltaDailyTok = Math.max(0, memory.dailyTotalTokens - prevDailyTok);
    const deltaLifetimeReq = Math.max(0, memory.lifetimeTotalRequests - prev.lifetimeTotalRequests);
    const deltaLifetimeTok = Math.max(0, memory.lifetimeTotalTokens - prev.lifetimeTotalTokens);
    
    const result: PersistentUsage = {
      lastResetDate: today,
      dailyTotalRequests: base.dailyTotalRequests + deltaDailyReq,
      dailyTotalTokens: base.dailyTotalTokens + deltaDailyTok,
      lifetimeTotalRequests: base.lifetimeTotalRequests + deltaLifetimeReq,
      lifetimeTotalTokens: base.lifetimeTotalTokens + deltaLifetimeTok,
      providers: { ...base.providers }
    };

    // Merge providers
    for (const [id, mProv] of Object.entries(memory.providers)) {
      const dProv = base.providers[id] || { lastSyncTime: 0, localTotalRequests: 0, localTotalTokens: 0 };
      const pProv = prev.providers[id] || { localTotalRequests: 0, localTotalTokens: 0 };
      
      const deltaReq = Math.max(0, mProv.localTotalRequests - pProv.localTotalRequests);
      const deltaTok = Math.max(0, mProv.localTotalTokens - pProv.localTotalTokens);

      result.providers[id] = {
        ...dProv,
        lastSyncTime: Math.max(dProv.lastSyncTime || 0, mProv.lastSyncTime || 0),
        localTotalRequests: (dProv.localTotalRequests || 0) + deltaReq,
        localTotalTokens: (dProv.localTotalTokens || 0) + deltaTok,
        remainingRequests: mProv.remainingRequests !== undefined ? mProv.remainingRequests : dProv.remainingRequests,
        remainingTokens: mProv.remainingTokens !== undefined ? mProv.remainingTokens : dProv.remainingTokens,
        failures: mProv.failures ?? dProv.failures,
        lastFailure: mProv.lastFailure ?? dProv.lastFailure,
        cooldownUntil: mProv.cooldownUntil ?? dProv.cooldownUntil,
        totalErrors: mProv.totalErrors ?? dProv.totalErrors
      };
    }

    return result;
  }
}

export const persistence = new PersistenceManager();
