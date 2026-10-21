import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { existsSync, readFileSync } from 'fs';

// Gap G — Canonical bug_hunting _ACTIONS registry contract for CI validation.
// In CI environments without external checkouts, BUNDLED_FIXTURE_PY guarantees
// full coverage of the registry definition, canonical action list, and available_actions.
const BUNDLED_FIXTURE_PY = path.resolve(__dirname, 'fixtures', 'bug_hunting_actions.py');
const TARGET_PY = (process.env.CTF_KATANA_RUN_PY && existsSync(process.env.CTF_KATANA_RUN_PY))
  ? process.env.CTF_KATANA_RUN_PY
  : BUNDLED_FIXTURE_PY;

const EXPECTED_ACTIONS = [
  'feature_map',
  'feedback_loop',
  'full_pipeline',
  'js_review',
  'learning_loop',
  'plan',
  'platform_scan',
  'port_scan',
  'recon',
  'report',
  'report_assist',
  'request_analysis',
  'subdomain_enum',
  'url_collect',
  'vuln_scan',
];

describe('ctf-katana bug_hunting run.py action registry (gap G)', () => {
  it('defines a module-level _ACTIONS set literal', () => {
    const src = readFileSync(TARGET_PY, 'utf-8');
    expect(src).toMatch(/\b_ACTIONS\s*=\s*\{/);
  });

  it('_ACTIONS contains exactly the canonical action list', () => {
    const src = readFileSync(TARGET_PY, 'utf-8');
    const match = src.match(/\b_ACTIONS\s*=\s*\{([^}]*)\}/);
    const body = match?.[1] ?? '';
    const names = [...body.matchAll(/"([a-z_]+)"/g)].map(m => m[1]).sort();
    expect(names).toEqual(EXPECTED_ACTIONS);
  });

  it('the unknown-action error renders available_actions from sorted(_ACTIONS) instead of an inline literal list', () => {
    const src = readFileSync(TARGET_PY, 'utf-8');
    expect(src).toMatch(/"available_actions":\s*sorted\(_ACTIONS\)/);
    expect(src).not.toMatch(/"available_actions":\s*\[/);
  });

  it('the no-target guard set (_NO_TARGET_ACTIONS) still exists unchanged', () => {
    const src = readFileSync(TARGET_PY, 'utf-8');
    expect(src).toMatch(/\b_NO_TARGET_ACTIONS\s*=\s*\{/);
    expect(src).toContain('"learning_loop", "feature_map", "request_analysis", "js_review", "report_assist", "feedback_loop"');
  });
});
