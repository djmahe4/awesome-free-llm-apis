import fs from 'node:fs';
import path from 'node:path';

/**
 * Timing trace: tracks pipeline events with timestamp offsets.
 * In-memory buffer captures timeline for caller transparency.
 * If CODING_AGENTS_TRACE=1, also logs to stderr.
 */
let started = Date.now();
let inMemoryTraces: Array<{ time: number; event: string; detail?: string }> = [];

export const caTraceOn = () => process.env.CODING_AGENTS_TRACE === '1';

export function caTraceReset(label: string): void {
  started = Date.now();
  inMemoryTraces = [{ time: 0, event: 'start', detail: label }];
  if (caTraceOn()) console.error(`[ca-trace] +0.0s start ${label}`);
}

export function caTrace(event: string, detail = ''): void {
  const elapsed = +((Date.now() - started) / 1000).toFixed(2);
  inMemoryTraces.push({ time: elapsed, event, ...(detail ? { detail } : {}) });
  if (inMemoryTraces.length > 200) inMemoryTraces.shift();
  if (caTraceOn()) {
    console.error(`[ca-trace] +${elapsed.toFixed(1)}s ${event}${detail ? ` ${detail}` : ''}`);
  }
}

export function caGetTraceEvents(): Array<{ time: number; event: string; detail?: string }> {
  return [...inMemoryTraces];
}

export function caTraceDir(): string | undefined {
  const explicit = process.env.CODING_AGENTS_TRACE_DIR;
  if (explicit) return explicit;
  return caTraceOn() ? path.join(process.cwd(), '.free-llm-mcp', 'ca-traces') : undefined;
}

/** With CODING_AGENTS_TRACE_DIR set, saves a full model reply there so a rejected one can be inspected. */
export function caTraceDump(label: string, content: string): void {
  const dir = caTraceDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${Date.now()}-${label.replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`, content);
  } catch { /* tracing must never break a run */ }
}
