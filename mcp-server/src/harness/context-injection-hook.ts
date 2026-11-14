import { readFileSync } from 'node:fs';

export interface ThoughtBundle {
  id: string;
  text: string;
  source: 'rea' | 'reasoning' | 'external';
  timestamp: number;
  tool?: string;
  action?: string;
  goal?: string;
}

export interface InjectionContext {
  folded: boolean;
  summary?: string;
  thoughts?: ThoughtBundle[];
}

export interface HookCallContext {
  tool: string;
  action: string;
  goal?: string;
  thoughts: ThoughtBundle[];
}

export interface HookCallResult {
  injectedContext: InjectionContext;
}

export interface ContextInjectionHookOptions {
  foldByDefault?: boolean;
  triggers?: string[];
  tasksPrefill?: string[];
}

function summarizePrefill(lines: string[]): string {
  if (lines.length === 0) return 'No open tasks.';
  const heads = lines.slice(0, 5).map((l) => l.trim()).filter(Boolean);
  return `Pending tasks (${lines.length}): ${heads.join('; ')}`;
}

export class ContextInjectionHook {
  private readonly foldByDefault: boolean;
  private readonly triggers: string[];
  private prefill: ThoughtBundle[];
  private counter = 0;

  constructor(opts: ContextInjectionHookOptions = {}) {
    this.foldByDefault = opts.foldByDefault ?? true;
    this.triggers = (opts.triggers ?? []).map((t) => t.toLowerCase());
    this.prefill = (opts.tasksPrefill ?? []).map((line, i) => ({
      id: `prefill-${i}-${Date.now()}`,
      text: line.trim(),
      source: 'rea' as const,
      timestamp: Date.now(),
    }));
  }

  static fromTasksFile(path: string, opts: ContextInjectionHookOptions = {}): ContextInjectionHook {
    let prefill: string[] = [];
    try {
      const raw = readFileSync(path, 'utf8');
      prefill = raw
        .split(/\r?\n/)
        .filter((line) => /^\s*[-*]\s*\[( |x)\]/.test(line))
        .map((line) => line.replace(/^\s*[-*]\s*\[( |x)\]\s*/, ''));
    } catch {
      prefill = [];
    }
    return new ContextInjectionHook({ ...opts, tasksPrefill: prefill });
  }

  private isTriggerMatch(ctx: HookCallContext): boolean {
    if (this.triggers.length === 0) return false;
    const haystack = `${ctx.tool} ${ctx.action} ${ctx.goal ?? ''}`.toLowerCase();
    return this.triggers.some((t) => haystack.includes(t));
  }

  async before(ctx: HookCallContext): Promise<HookCallResult> {
    const expanded = this.isTriggerMatch(ctx);
    if (expanded) {
      const thoughts = ctx.thoughts.length > 0 ? ctx.thoughts : this.prefill;
      return { injectedContext: { folded: false, thoughts } };
    }
    if (this.foldByDefault) {
      const summary =
        this.prefill.length > 0
          ? summarizePrefill(this.prefill.map((t) => t.text))
          : `Goal: ${ctx.goal ?? 'unspecified'} | tool: ${ctx.tool}.${ctx.action} | prior thoughts: ${ctx.thoughts.length}`;
      return { injectedContext: { folded: true, summary } };
    }
    return { injectedContext: { folded: false, thoughts: ctx.thoughts } };
  }

  async after(ctx: HookCallResultContext, result: unknown): Promise<ThoughtBundle | null> {
    this.counter += 1;
    const durationStr = ctx.durationMs != null ? ` +${ctx.durationMs}ms` : '';
    const errorStr = ctx.error ? ` [ERROR: ${ctx.error}]` : '';
    const text = `Tool ${ctx.tool}.${ctx.action} (${ctx.goal ?? ''})${durationStr}${errorStr}: ${stringifyResult(result)}`;
    if (!/\S/.test(text)) return null;
    return {
      id: `rea-${ctx.tool}-${ctx.action}-${this.counter}-${Date.now()}`,
      text,
      source: 'rea',
      timestamp: Date.now(),
      tool: ctx.tool,
      action: ctx.action,
      goal: ctx.goal,
    };
  }
}

export interface HookCallResultContext extends HookCallContext {
  durationMs?: number;
  error?: string;
}

function stringifyResult(result: unknown): string {
  if (result == null) return 'no result';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
