import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { runVerifyCommand } from '../src/tools/coding-agents/verify-command.js';
import { loadCodingAgentsSettings, isSkippedTest } from '../src/tools/coding-agents/settings.js';
import { isProtectedWritePath } from '../src/harness/write-guard.js';

// Workspace setting .free-llm-mcp/coding-agents.json { "skipFailingTests": [...] }: known pre-failing tests
// (flaky, needs network, broken upstream) no longer make every check red and send the repair loop chasing them.

const TEST_FILE = `
const test = require('node:test'); const assert = require('node:assert');
test('real behaviour', () => assert.strictEqual(1 + 1, Number(process.env.REAL_EXPECT || 2)));
test('flaky network call', () => assert.fail('no network'));
test('legacy snapshot 3', () => assert.fail('old snapshot'));
`;

let ws = '';
beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'skip-tests-'));
    await fs.outputFile(path.join(ws, 'tests/t.test.js'), TEST_FILE);
});
afterEach(async () => { delete process.env.REAL_EXPECT; await fs.remove(ws); });

const settings = (s: object) => fs.outputFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify(s));

describe('skipFailingTests setting', () => {
    it('patterns match exact names, substrings and /regex/', () => {
        expect(isSkippedTest('flaky network call', ['flaky network call'])).toBe(true);
        expect(isSkippedTest('flaky network call', ['network'])).toBe(true);
        expect(isSkippedTest('legacy snapshot 3', ['/^legacy snapshot \\d+$/'])).toBe(true);
        expect(isSkippedTest('real behaviour', ['network', '/^legacy/'])).toBe(false);
    });

    it('loads from the workspace, and is empty (not an error) when absent or malformed', async () => {
        expect(loadCodingAgentsSettings(ws).skipFailingTests).toEqual([]);
        await settings({ skipFailingTests: ['network', 7, ''] });
        expect(loadCodingAgentsSettings(ws).skipFailingTests).toEqual(['network']);
        await fs.outputFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), '{ not json');
        expect(loadCodingAgentsSettings(ws).skipFailingTests).toEqual([]);
    });

    it('a check whose only failures are skipped counts as passed, and says what it skipped', async () => {
        await settings({ skipFailingTests: ['flaky network call', '/^legacy snapshot/'] });
        const r = await runVerifyCommand('node --test tests/t.test.js', ws);
        expect(r.ok).toBe(true);
        expect(r.failedCases).toEqual([]);
        expect(r.skippedFailures?.sort()).toEqual(['flaky network call', 'legacy snapshot 3']);
    }, 30000);

    it('a real failure still fails, without the skipped ones in its list', async () => {
        await settings({ skipFailingTests: ['flaky network call', '/^legacy snapshot/'] });
        process.env.REAL_EXPECT = '3';
        const r = await runVerifyCommand('node --test tests/t.test.js', ws);
        expect(r.ok).toBe(false);
        expect(r.failedCases).toEqual(['real behaviour']);
    }, 30000);

    it('without the setting nothing changes', async () => {
        const r = await runVerifyCommand('node --test tests/t.test.js', ws);
        expect(r.ok).toBe(false);
        expect(r.failedCases).toContain('flaky network call');
    }, 30000);

    it('the agent cannot edit the settings file (it could otherwise skip its own failing test)', () => {
        expect(isProtectedWritePath(ws, '.free-llm-mcp/coding-agents.json')).toBe(true);
        expect(isProtectedWritePath(ws, '.FREE-LLM-MCP/Coding-Agents.json')).toBe(true);
    });
});

describe('failing-case names across runners', () => {
    it('strips ANSI colour codes and pytest reasons', async () => {
        const { failedCaseName } = await import('../src/tools/coding-agents/verify-command.js');
        const esc = String.fromCharCode(27);
        const line = `${esc}[31mFAILED${esc}[0m tests/test_x.py::${esc}[1mtest_flaky_network${esc}[0m - AssertionError: no network`;
        expect(failedCaseName(line)).toBe('tests/test_x.py::test_flaky_network');
        expect(failedCaseName('FAILED tests/test_x.py::TestCart::test_eur[1,50] - assert 0')).toBe('tests/test_x.py::TestCart::test_eur[1,50]');
    });

    it('pytest: a check whose only failure is skipped is green (needs pytest installed)', async () => {
        const { spawnSync } = await import('node:child_process');
        if (spawnSync('pytest', ['--version'], { shell: process.platform === 'win32' }).status !== 0) return;
        await fs.outputFile(path.join(ws, 'tests/test_x.py'), 'def test_real():\n    assert 1 + 1 == 2\n\ndef test_flaky_network():\n    assert False, "no network"\n');
        await settings({ skipFailingTests: ['test_flaky_network'] });
        const r = await runVerifyCommand('pytest -q tests/test_x.py', ws);
        expect(r.skippedFailures).toEqual(['tests/test_x.py::test_flaky_network']);
        expect(r.ok).toBe(true);
    }, 60000);
});
