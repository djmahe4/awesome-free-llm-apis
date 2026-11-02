import { describe, it, expect, vi, afterEach } from 'vitest';
import { requiredLiterals, missingLiterals, workOrderNote, triageDeviation, localTriageAsk } from '../src/tools/coding-agents/work-order.js';

// A goal that supplies the exact replacement text is a work order. Traced live: retries saw only the failing
// assertion, so weak models kept rewriting the regex until the loop cycled.

const NEW_A = 'const withoutAnsi = strip(text);';
const NEW_B = 'return clean(withoutAnsi);';
const GOAL = `In a.ts replace the line \`return text;\` with these two lines: line 1 \`${NEW_A}\` and line 2 \`${NEW_B}\`. Change nothing else.`;

describe('requiredLiterals', () => {
    it('takes the code after "replace ... with", not the code being replaced', () => {
        expect(requiredLiterals(GOAL)).toEqual([NEW_A, NEW_B]);
    });
    it('returns nothing when the goal has no replacement', () => {
        expect(requiredLiterals('Add a `helper` function to a.ts that trims text.')).toEqual([]);
    });
    it('ignores a negated replacement', () => {
        expect(requiredLiterals('Fix the parser. Do not replace `oldThing()` with `newThing()`.')).toEqual([]);
    });
    it('ignores short backticked words after "with"', () => {
        expect(requiredLiterals('Replace the call with one that uses `foo`.')).toEqual([]);
    });
});

describe('requiredLiterals for added lines', () => {
    it('takes the code after "add the line"', () => {
        expect(requiredLiterals('After the import add the line `const answer = 42;`. Change nothing else.')).toEqual(['const answer = 42;']);
    });
    it('takes a chain of lines joined by and or then', () => {
        expect(requiredLiterals('Add these lines: `const first = 1;` then `const second = 2;` and `const third = 3;`.')).toEqual(['const first = 1;', 'const second = 2;', 'const third = 3;']);
    });
    it('does not take code named later in the goal', () => {
        expect(requiredLiterals('Add the line `const first = 1;` directly after `const anchor = 0;`.')).toEqual(['const first = 1;']);
    });
    it('does not read "add a function" as supplied text', () => {
        expect(requiredLiterals('Add a function `helperFunction` to the file.')).toEqual([]);
    });
    it('ignores a negated addition', () => {
        expect(requiredLiterals('Do not add the line `const first = 1;`.')).toEqual([]);
    });
});

describe('missingLiterals', () => {
    it('reports only the text no file contains, ignoring surrounding whitespace', () => {
        expect(missingLiterals(GOAL, [`function f() {\n  ${NEW_A}\n  return wrong;\n}`])).toEqual([NEW_B]);
        expect(missingLiterals(GOAL, [`  ${NEW_A}\n`, `  ${NEW_B}\n`])).toEqual([]);
    });
});

describe('workOrderNote', () => {
    it('quotes the missing text and says to copy it character for character', () => {
        const note = workOrderNote([NEW_B]);
        expect(note).toContain(NEW_B);
        expect(note).toMatch(/character for character/i);
    });
});

describe('triageDeviation', () => {
    const facts = { goal: GOAL, missing: [NEW_B], brief: 'expected a got b' };

    it('passes the goal and the missing text to the local model and returns its cause', async () => {
        const ask = vi.fn(async () => '{"cause":"wrong_place","action":"stop"}');
        expect(await triageDeviation(facts, ask)).toEqual({ cause: 'wrong_place', action: 'stop', source: 'local' });
        const prompt = String((ask.mock.calls as unknown as string[][])[0][0]);
        expect(prompt).toContain(GOAL);
        expect(prompt).toContain(NEW_B);
    });
    it('falls back to the rule when the reply is not one of the causes', async () => {
        expect(await triageDeviation(facts, async () => '{"cause":"cosmic rays"}')).toEqual({ cause: 'not_copied', action: 'reroute', source: 'rule' });
        expect(await triageDeviation(facts, async () => 'not json')).toEqual({ cause: 'not_copied', action: 'reroute', source: 'rule' });
    });
    it('takes the default action of the cause when the model gives no valid action', async () => {
        expect(await triageDeviation(facts, async () => '{"cause":"goal_unclear"}')).toEqual({ cause: 'goal_unclear', action: 'stop', source: 'local' });
        expect(await triageDeviation(facts, async () => '{"cause":"wrong_place","action":"pray"}')).toEqual({ cause: 'wrong_place', action: 'retry', source: 'local' });
    });
    it('falls back to the rule when the local model fails', async () => {
        expect(await triageDeviation(facts, async () => { throw new Error('refused'); })).toEqual({ cause: 'not_copied', action: 'reroute', source: 'rule' });
    });
    it('does not wait past the time limit', async () => {
        const never = () => new Promise<string>(() => undefined);
        expect(await triageDeviation(facts, never, 20)).toEqual({ cause: 'not_copied', action: 'reroute', source: 'rule' });
    });
});

describe('localTriageAsk', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    it('calls Ollama directly, asks for JSON, and returns the reply text', async () => {
        vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama.test:1');
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ response: '{"cause":"goal_unclear"}' })));
        vi.stubGlobal('fetch', fetchMock);
        expect(await localTriageAsk('why')).toBe('{"cause":"goal_unclear"}');
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://ollama.test:1/api/generate');
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ prompt: 'why', format: 'json', stream: false });
    });
    it('throws on an HTTP error so triage can fall back', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
        await expect(localTriageAsk('why')).rejects.toThrow();
    });
});
