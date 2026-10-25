/**
 * Opt-in timing trace (CODING_AGENTS_TRACE=1): one stderr line per pipeline event with the time since the
 * run started, so a slow run shows which stage the minutes went to. Off by default, no cost when off.
 */
let started = Date.now();

export const caTraceOn = () => process.env.CODING_AGENTS_TRACE === '1';

export function caTraceReset(label: string): void {
  started = Date.now();
  if (caTraceOn()) console.error(`[ca-trace] +0.0s start ${label}`);
}

export function caTrace(event: string, detail = ''): void {
  if (!caTraceOn()) return;
  console.error(`[ca-trace] +${((Date.now() - started) / 1000).toFixed(1)}s ${event}${detail ? ` ${detail}` : ''}`);
}
