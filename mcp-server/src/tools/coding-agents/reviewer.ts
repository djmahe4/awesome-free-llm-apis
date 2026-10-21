/**
 * Independent review of a proposed edit. The reviewer sees ONLY the instruction and the diff (no
 * workspace, no tools, no ability to run anything) and answers in a fixed line format that a small
 * model can follow.
 *
 * A small model's review is noisy, so it is only allowed to stop an edit when it cites a concrete
 * input, the expected result and the actual result. Vague worries are reported as notes.
 */

export interface ReviewFinding {
  blocking: boolean;
  text: string;
}

export interface ReviewResult {
  verdict: 'ok' | 'concerns' | 'blocked' | 'skipped';
  findings: ReviewFinding[];
  /** Feedback text for the next attempt (only when blocked). */
  brief?: string;
  model?: string;
}

const MAX_DIFF_CHARS = 6000;

const FORMAT = [
  'Reply with one line per problem, in exactly this format, or the single word OK if there is none:',
  'BLOCK | input: <a concrete input> | expected: <what the instruction requires> | actual: <what this code does> | why: <one short reason>',
  'NOTE | <minor remark>',
  'Use BLOCK only for a concrete failing case you can state. Do not praise. Do not rewrite the code.',
].join('\n');

export function buildReviewPrompt(instruction: string, diff: string): string {
  const d = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)` : diff;
  return [
    'You are a strict code reviewer. Check whether the diff does what the instruction requires, including edge cases and boundaries.',
    `## Instruction\n${instruction}`,
    `## Diff\n${d}`,
    FORMAT,
  ].join('\n\n');
}

const field = (line: string, name: string) => {
  const m = line.match(new RegExp(`${name}:\\s*([^|]+)`, 'i'));
  return m ? m[1].trim() : '';
};

/** Parses the reviewer's reply. Anything that is not a well-formed BLOCK cannot stop an edit. */
export function parseReview(text: string): ReviewResult {
  const findings: ReviewFinding[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(BLOCK|NOTE)\s*\|\s*(.+)$/i);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    const body = m[2].trim();
    if (kind === 'BLOCK') {
      const concrete = field(body, 'input') && field(body, 'expected') && field(body, 'actual');
      findings.push({ blocking: !!concrete, text: body });
    } else {
      findings.push({ blocking: false, text: body });
    }
  }
  const blocking = findings.filter(f => f.blocking);
  if (blocking.length > 0) {
    return {
      verdict: 'blocked',
      findings,
      brief: `REVIEW (independent reviewer found concrete failing cases; fix the production code, do not edit tests):\n${blocking.map(f => `- ${f.text}`).join('\n')}`,
    };
  }
  return { verdict: findings.length > 0 ? 'concerns' : 'ok', findings };
}

export async function reviewPatch(args: {
  instruction: string;
  diff: string;
  chat: (prompt: string) => Promise<string>;
  model?: string;
}): Promise<ReviewResult> {
  try {
    const reply = await args.chat(buildReviewPrompt(args.instruction, args.diff));
    return { ...parseReview(reply), model: args.model };
  } catch {
    // A reviewer that cannot run must never stop an edit.
    return { verdict: 'skipped', findings: [], model: args.model };
  }
}
