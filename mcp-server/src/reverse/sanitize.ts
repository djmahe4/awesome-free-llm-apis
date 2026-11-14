/**
 * Output from an analysis engine describes untrusted samples, so it is hostile data (docs/plans/rev_tool.md section 2).
 * sanitizeText removes what hides or reorders text, cuts long encoded blobs, caps the length, and reports what it did
 * so the caller can show it. It does not make the text safe to follow as instructions; the control for that is the
 * tool allowlist.
 *
 * The flag logic lives here; each step below is a small pure function.
 */

export type SanitizeFlag = 'control_chars' | 'zero_width' | 'bidi' | 'long_base64' | 'truncated';

export interface SanitizeResult {
  text: string;
  flags: SanitizeFlag[];
}

/** Removes ANSI escape sequences (ESC [ ... letter) and every other control character except tab and newline. */
function removeControl(text: string): string {
  const withoutAnsi = text.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '');
  return withoutAnsi.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Removes zero-width characters. */
function removeZeroWidth(text: string): string {
  return text.replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
}

/** Removes bidirectional marks, embeddings, overrides and isolates. */
function removeBidi(text: string): string {
  return text.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

/** Replaces every run of 200 or more base64 characters with a marker that says how long the run was. */
function maskBase64(text: string): string {
  return text.replace(/[A-Za-z0-9+\/]{200,}={0,2}/g, run => `[encoded blob of ${run.length} characters removed]`);
}

/** Cuts text longer than maxChars to maxChars and appends a truncation note. */
function capLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated at ${maxChars} characters]`;
}

export function sanitizeText(input: string, maxChars = 200000): SanitizeResult {
  const flags: SanitizeFlag[] = [];
  let text = typeof input === 'string' ? input.normalize('NFC') : '';
  // a flag is added only when its step actually changed the text
  const apply = (flag: SanitizeFlag, step: (t: string) => string) => {
    const next = step(text);
    if (next !== text) {
      text = next;
      flags.push(flag);
    }
  };
  apply('control_chars', removeControl);
  apply('zero_width', removeZeroWidth);
  apply('bidi', removeBidi);
  apply('long_base64', maskBase64);
  apply('truncated', t => capLength(t, maxChars));
  return { text, flags };
}
