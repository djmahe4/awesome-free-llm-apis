import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { withFileLock } from '../utils/file-lock.js';

export type EisenhowerQuadrant = 'do' | 'schedule' | 'delegate' | 'delete';

export interface EisenhowerTask {
  id: string;
  task: string;
  urgent: boolean;
  important: boolean;
  quadrant: EisenhowerQuadrant;
  tags: string[];
  createdAt: number;
  completedAt: number | null;
  workspaceHash: string;
}

export interface PomodoroSession {
  id: string;
  label: string;
  durationMinutes: number;
  startedAt: number;
  stoppedAt: number | null;
  status: 'running' | 'completed' | 'aborted';
  actualMinutes: number | null;
  workspaceHash: string;
}

export class ProductivityMemory {
  private baseDir: string;
  private workspaceHash: string;
  private eisenhowerPath: string;
  private pomodoroPath: string;

  constructor(workspaceHash: string, baseDir?: string) {
    this.workspaceHash = workspaceHash;
    this.baseDir = baseDir ?? process.cwd();
    this.eisenhowerPath = path.join(this.baseDir, '.free-llm-mcp', 'memory', 'productivity', workspaceHash, 'eisenhower.json');
    this.pomodoroPath = path.join(this.baseDir, '.free-llm-mcp', 'memory', 'productivity', workspaceHash, 'pomodoro.json');
  }

  private async loadEisenhower(): Promise<EisenhowerTask[]> {
    try {
      return JSON.parse(await fs.readFile(this.eisenhowerPath, 'utf8')) as EisenhowerTask[];
    } catch (e) {
      return [];
    }
  }

  private async saveEisenhower(tasks: EisenhowerTask[]): Promise<void> {
    await withFileLock(this.eisenhowerPath, async () => {
      await fs.writeFile(this.eisenhowerPath, JSON.stringify(tasks, null, 2), 'utf8');
    });
  }

  private async loadPomodoro(): Promise<PomodoroSession[]> {
    try {
      return JSON.parse(await fs.readFile(this.pomodoroPath, 'utf8')) as PomodoroSession[];
    } catch (e) {
      return [];
    }
  }

  private async savePomodoro(sessions: PomodoroSession[]): Promise<void> {
    await withFileLock(this.pomodoroPath, async () => {
      await fs.writeFile(this.pomodoroPath, JSON.stringify(sessions, null, 2), 'utf8');
    });
  }

  private computeQuadrant(urgent: boolean, important: boolean): EisenhowerQuadrant {
    if (urgent && important) return 'do';
    if (!urgent && important) return 'schedule';
    if (urgent && !important) return 'delegate';
    return 'delete';
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(path.dirname(this.eisenhowerPath))) {
      await fs.mkdir(path.dirname(this.eisenhowerPath), { recursive: true });
    }
    if (!existsSync(path.dirname(this.pomodoroPath))) {
      await fs.mkdir(path.dirname(this.pomodoroPath), { recursive: true });
    }
  }

  async addTask(task: string, urgent: boolean, important: boolean, tags?: string[]): Promise<EisenhowerTask> {
    await this.ensureDir();
    const quadrant = this.computeQuadrant(urgent, important);
    const newTask: EisenhowerTask = {
      id: crypto.randomUUID(),
      task,
      urgent,
      important,
      quadrant,
      tags: tags ?? [],
      createdAt: Date.now(),
      completedAt: null,
      workspaceHash: this.workspaceHash,
    };
    const tasks = await this.loadEisenhower();
    tasks.push(newTask);
    await this.saveEisenhower(tasks);
    return newTask;
  }

  async listTasks(quadrant?: EisenhowerQuadrant, includeCompleted = false): Promise<EisenhowerTask[]> {
    await this.ensureDir();
    let tasks = await this.loadEisenhower();
    if (!includeCompleted) {
      tasks = tasks.filter(t => t.completedAt === null);
    }
    if (quadrant) {
      tasks = tasks.filter(t => t.quadrant === quadrant);
    }
    return tasks;
  }

  async completeTask(id: string): Promise<EisenhowerTask | null> {
    await this.ensureDir();
    const tasks = await this.loadEisenhower();
    const taskIndex = tasks.findIndex(t => t.id === id);
    if (taskIndex !== -1) {
      tasks[taskIndex].completedAt = Date.now();
      await this.saveEisenhower(tasks);
      return tasks[taskIndex];
    }
    return null;
  }

  async startPomodoro(label: string, durationMinutes = 25): Promise<PomodoroSession> {
    await this.ensureDir();
    const newSession: PomodoroSession = {
      id: crypto.randomUUID(),
      label,
      durationMinutes,
      startedAt: Date.now(),
      stoppedAt: null,
      status: 'running',
      actualMinutes: null,
      workspaceHash: this.workspaceHash,
    };
    const sessions = await this.loadPomodoro();
    sessions.push(newSession);
    await this.savePomodoro(sessions);
    return newSession;
  }

  async stopPomodoro(id: string, aborted = false): Promise<PomodoroSession | null> {
    await this.ensureDir();
    const sessions = await this.loadPomodoro();
    const sessionIndex = sessions.findIndex(s => s.id === id);
    if (sessionIndex !== -1) {
      const session = sessions[sessionIndex];
      session.stoppedAt = Date.now();
      session.status = aborted ? 'aborted' : 'completed';
      session.actualMinutes = Math.round((session.stoppedAt - session.startedAt) / 60000);
      await this.savePomodoro(sessions);
      return session;
    }
    return null;
  }

  async listPomodoros(limit = 20): Promise<PomodoroSession[]> {
    await this.ensureDir();
    const sessions = await this.loadPomodoro();
    return sessions.slice(-limit).reverse();
  }
}
