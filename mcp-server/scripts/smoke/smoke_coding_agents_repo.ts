/**
 * Live smoke test: coding_agents (qwen2.5-coder via Ollama) doing real work on a throwaway repo,
 * driven through the dashboard HTTP API the way a user would.
 *
 *   PORT=3111 npx tsx --env-file=.env src/server.ts --sse     # in another terminal
 *   npx tsx scripts/smoke/smoke_coding_agents_repo.ts [--tasks ip,counter,slug,tests] [--port 3111] [--attempts 2]
 *
 * Each task has a hidden-from-the-model test file (tests/*.test.js, node:test) that is the ground truth.
 * The agent is given a verifyCommand pointing at it. After the run the script runs the tests ITSELF
 * and reports whether the repo is really green, regardless of what the agent claims.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = arg('port', '3111');
const ATTEMPTS = Number(arg('attempts', '4'));
const SAMPLES = Number(arg('samples', '3'));
const WANT = (arg('tasks', 'counter,slug,tests,roman,duration,unique') as string).split(',');
const MODEL = arg('model'); // pin an installed local model, e.g. a bigger one for cross-file tasks
const DURATION_MS = Number(arg('duration-ms', '300000'));
const THINK = arg('think') as 'auto' | 'on' | 'off' | undefined;
const REPEAT = Number(arg('repeat', '1'));
const BASE = `http://localhost:${PORT}`;

type Task = {
  id: string;
  goal: string;
  files: Record<string, string>;
  target: string;
  /** Cross-file tasks: every file the change must touch (default: [target]). */
  targets?: string[];
  test: string; // test file the agent's verifyCommand runs
  expect: 'green' | 'needs_user';
};

/** Tasks kept as real files under coding-agents-tasks/<id>/ (task.json + the repo), no string escaping. */
function loadFixtureTasks(): Task[] {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'coding-agents-tasks');
  if (!fs.existsSync(root)) return [];
  const tasks: Task[] = [];
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name !== 'task.json') files[path.relative(dir, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    tasks.push({ id: meta.id ?? id, goal: meta.goal, files, target: meta.targets[0], targets: meta.targets, test: meta.test, expect: meta.expect ?? 'green' });
  }
  return tasks;
}

const IP_TEST = `
const test = require('node:test'); const assert = require('node:assert');
const { isPrivateIPv4 } = require('../src/ip.js');
const priv = ['0.0.0.0','0.255.255.255','10.1.2.3','100.64.0.1','100.127.255.255','127.0.0.1','169.254.169.254','172.16.0.1','172.31.255.255','192.0.0.8','192.168.1.1','198.18.0.1','198.19.255.255','224.0.0.1','255.255.255.255'];
const pub = ['8.8.8.8','1.1.1.1','93.184.216.34','172.15.0.1','172.32.0.1','100.63.255.255','100.128.0.1','192.0.2.1','198.17.0.1','198.20.0.1'];
for (const ip of priv) test('private ' + ip, () => assert.strictEqual(isPrivateIPv4(ip), true));
for (const ip of pub) test('public ' + ip, () => assert.strictEqual(isPrivateIPv4(ip), false));
for (const bad of ['', 'abc', '1.2.3', '256.1.1.1', '1.2.3.4.5']) test('unparsable ' + JSON.stringify(bad), () => assert.strictEqual(isPrivateIPv4(bad), true));
`;

const TASKS: Task[] = [
  {
    id: 'ip',
    goal: 'Implement isPrivateIPv4(ip) in src/ip.js. It takes a dotted-quad string and returns true when the address is private, loopback, link-local, CGNAT, multicast or reserved (0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, and everything from 224.0.0.0 up), false for public addresses, and true for anything that does not parse as four decimal octets 0-255.',
    files: { 'src/ip.js': 'module.exports = {\n  isPrivateIPv4(ip) {\n    throw new Error("not implemented");\n  },\n};\n', 'tests/ip.test.js': IP_TEST },
    target: 'src/ip.js', test: 'tests/ip.test.js', expect: 'green',
  },
  {
    id: 'counter',
    goal: 'Add a method reset() to class Counter in src/counter.js that sets the count back to 0. Keep all existing methods.',
    files: {
      'src/counter.js': 'class Counter {\n  constructor() {\n    this.count = 0;\n  }\n  inc() {\n    this.count += 1;\n    return this.count;\n  }\n  value() {\n    return this.count;\n  }\n}\n\nmodule.exports = { Counter };\n',
      'tests/counter.test.js': 'const test = require("node:test"); const assert = require("node:assert");\nconst { Counter } = require("../src/counter.js");\ntest("inc and value still work", () => { const c = new Counter(); c.inc(); c.inc(); assert.strictEqual(c.value(), 2); });\ntest("reset sets back to zero", () => { const c = new Counter(); c.inc(); c.reset(); assert.strictEqual(c.value(), 0); });\ntest("reset on a fresh counter", () => { const c = new Counter(); c.reset(); assert.strictEqual(c.value(), 0); c.inc(); assert.strictEqual(c.value(), 1); });\n',
    },
    target: 'src/counter.js', test: 'tests/counter.test.js', expect: 'green',
  },
  {
    id: 'slug',
    goal: 'Fix slugify(text) in src/slug.js so it lowercases, replaces every run of non-alphanumeric characters with a single "-", and strips leading and trailing "-". Example: "  Hello,   World!! " becomes "hello-world".',
    files: {
      'src/slug.js': 'function slugify(text) {\n  return text.replace(" ", "-");\n}\n\nmodule.exports = { slugify };\n',
      'tests/slug.test.js': 'const test = require("node:test"); const assert = require("node:assert");\nconst { slugify } = require("../src/slug.js");\ntest("basic", () => assert.strictEqual(slugify("Hello World"), "hello-world"));\ntest("runs and punctuation", () => assert.strictEqual(slugify("  Hello,   World!! "), "hello-world"));\ntest("already a slug", () => assert.strictEqual(slugify("a-b-c"), "a-b-c"));\ntest("empty", () => assert.strictEqual(slugify(""), ""));\ntest("only symbols", () => assert.strictEqual(slugify("!!!"), ""));\n',
    },
    target: 'src/slug.js', test: 'tests/slug.test.js', expect: 'green',
  },
  {
    id: 'tests',
    goal: 'Add a test to tests/counter.test.js that checks inc() returns the new count.',
    files: {
      'src/counter.js': 'class Counter {\n  constructor() {\n    this.count = 0;\n  }\n  inc() {\n    this.count += 1;\n    return this.count;\n  }\n}\n\nmodule.exports = { Counter };\n',
      'tests/counter.test.js': 'const test = require("node:test"); const assert = require("node:assert");\nconst { Counter } = require("../src/counter.js");\ntest("starts at zero", () => { assert.strictEqual(new Counter().count, 0); });\n',
    },
    target: 'tests/counter.test.js', test: 'tests/counter.test.js', expect: 'needs_user',
  },

  {
    id: 'roman',
    goal: 'Implement toRoman(n) in src/roman.js: convert an integer from 1 to 3999 to a Roman numeral string (subtractive notation, e.g. 4 is IV, 9 is IX, 1994 is MCMXCIV). Throw a RangeError for anything outside 1..3999 or that is not an integer.',
    files: {
      'src/roman.js': 'function toRoman(n) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { toRoman };\n',
      'tests/roman.test.js': 'const test = require("node:test"); const assert = require("node:assert");\nconst { toRoman } = require("../src/roman.js");\nconst cases = [[1,"I"],[4,"IV"],[9,"IX"],[14,"XIV"],[40,"XL"],[90,"XC"],[400,"CD"],[900,"CM"],[1994,"MCMXCIV"],[2024,"MMXXIV"],[3999,"MMMCMXCIX"]];\nfor (const [n, r] of cases) test("roman " + n, () => assert.strictEqual(toRoman(n), r));\nfor (const bad of [0, -1, 4000, 1.5, NaN, "5"]) test("range " + String(bad), () => assert.throws(() => toRoman(bad), RangeError));\n',
    },
    target: 'src/roman.js', test: 'tests/roman.test.js', expect: 'green',
  },
  {
    id: 'duration',
    goal: 'Implement parseDuration(text) in src/duration.js: parse strings like "1h30m", "45s", "2h", "1h 5m 10s" (units h, m, s, optional spaces, each unit at most once, in that order) into a total number of seconds. Throw an Error for an empty string, unknown units, repeated units or text that is not a duration.',
    files: {
      'src/duration.js': 'function parseDuration(text) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { parseDuration };\n',
      'tests/duration.test.js': 'const test = require("node:test"); const assert = require("node:assert");\nconst { parseDuration } = require("../src/duration.js");\nconst ok = [["1h30m",5400],["45s",45],["2h",7200],["1h 5m 10s",3910],["0s",0],["10m",600]];\nfor (const [t, n] of ok) test("parses " + t, () => assert.strictEqual(parseDuration(t), n));\nfor (const bad of ["", "abc", "5x", "1h1h", "30m1h", "h", "1.5h", "-5s"]) test("rejects " + JSON.stringify(bad), () => assert.throws(() => parseDuration(bad), Error));\n',
    },
    target: 'src/duration.js', test: 'tests/duration.test.js', expect: 'green',
  },
  {
    id: 'unique',
    goal: 'Implement uniqueBy(items, keyFn) in src/unique.js: return a new array with the first item for each distinct key (keyFn(item)), keeping the original order, without mutating the input. If keyFn is omitted use the item itself.',
    files: {
      'src/unique.js': 'function uniqueBy(items, keyFn) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { uniqueBy };\n',
      'tests/unique.test.js': 'const test = require("node:test"); const assert = require("node:assert");\nconst { uniqueBy } = require("../src/unique.js");\ntest("by key", () => assert.deepStrictEqual(uniqueBy([{id:1,v:"a"},{id:2,v:"b"},{id:1,v:"c"}], x => x.id), [{id:1,v:"a"},{id:2,v:"b"}]));\ntest("identity", () => assert.deepStrictEqual(uniqueBy([3,1,3,2,1]), [3,1,2]));\ntest("does not mutate", () => { const a = [1,1,2]; uniqueBy(a); assert.deepStrictEqual(a, [1,1,2]); });\ntest("empty", () => assert.deepStrictEqual(uniqueBy([]), []));\ntest("NaN and 0/-0 keys", () => assert.deepStrictEqual(uniqueBy([NaN, NaN, 0, -0]), [NaN, 0]));\n',
    },
    target: 'src/unique.js', test: 'tests/unique.test.js', expect: 'green',
  },

  {
    id: 'lastmile',
    goal: 'parseDuration in src/duration.js is almost right but fails the tests. Fix it so it satisfies every case in tests/duration.test.js without breaking the ones that already pass.',
    files: {
      // correct except it accepts decimals like "1.5h" (parseFloat) and negative numbers
      'src/duration.js': 'function parseDuration(text) {\n  const m = /^(?:(\\d+(?:\\.\\d+)?)h)?\\s*(?:(\\d+)m)?\\s*(?:(\\d+)s)?$/.exec(text.trim());\n  if (!text.trim() || !m) throw new Error("invalid duration: " + text);\n  const [, h, mi, se] = m;\n  return Math.round((h ? parseFloat(h) * 3600 : 0) + (mi ? Number(mi) * 60 : 0) + (se ? Number(se) : 0));\n}\n\nmodule.exports = { parseDuration };\n',
      'tests/duration.test.js': 'const test = require("node:test"); const assert = require("node:assert");\nconst { parseDuration } = require("../src/duration.js");\nconst ok = [["1h30m",5400],["45s",45],["2h",7200],["1h 5m 10s",3910],["0s",0],["10m",600]];\nfor (const [t, n] of ok) test("parses " + t, () => assert.strictEqual(parseDuration(t), n));\nfor (const bad of ["", "abc", "5x", "1h1h", "30m1h", "h", "1.5h", "-5s"]) test("rejects " + JSON.stringify(bad), () => assert.throws(() => parseDuration(bad), Error));\n',
    },
    target: 'src/duration.js', test: 'tests/duration.test.js', expect: 'green',
  },
];

async function post(body: unknown): Promise<any> {
  const r = await fetch(`${BASE}/api/coding_agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

function runTests(ws: string, test: string) {
  const r = spawnSync('node', ['--test', test], { cwd: ws, encoding: 'utf8' });
  return { green: r.status === 0, tail: ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /fail|not ok|expected|actual|✖/i.test(l)).slice(0, 6).join(' | ') };
}

async function runTask(t: Task) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `ca-smoke-${t.id}-`));
  for (const [rel, content] of Object.entries(t.files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  }
  spawnSync('git', ['init', '-q'], { cwd: ws }); spawnSync('git', ['add', '-A'], { cwd: ws });
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: ws });

  const sessionId = `smoke-${t.id}-${Date.now()}`;
  const started = Date.now();
  const verifyCommand = `node --test ${t.test}`;
  await post({ goal: t.goal, workspaceRoot: ws, dryRun: false, topKFiles: 1, targetFiles: t.targets ?? [t.target], sessionId, resolve: { action: 'apply' }, verifyCommand, maxRepairAttempts: ATTEMPTS, samples: SAMPLES, maxDurationMs: DURATION_MS, ...(MODEL ? { model: MODEL } : {}), ...(THINK ? { think: THINK } : {}) });
  let res: any;
  for (let i = 0; i < Math.ceil(DURATION_MS / 5000) + 24; i++) {
    res = await post({ action: 'status', workspaceRoot: ws, sessionId });
    if (res.status !== 'running') break;
    await new Promise(r => setTimeout(r, 5000));
  }
  const truth = runTests(ws, t.test);
  const attempts = (res.repair?.attempts ?? []).map((a: any) => `${a.attempt}:${a.outcome}${a.failing !== undefined ? `(${a.failing} failing${a.rewrite ? ',rewrite' : ''})` : ''}`).join(' ');
  const ok = t.expect === 'green' ? truth.green : res.verification?.status === 'needs_user' && res.applied === true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.id.padEnd(8)} ${Math.round((Date.now() - started) / 1000)}s  applied=${res.applied} repair=${res.repair?.outcome ?? '-'} [${attempts}] review=${res.review?.verdict ?? '-'} verify=${res.verification?.status ?? '-'} repoGreen=${truth.green}${truth.green ? '' : '  ' + truth.tail}`);
  const stuckOn = (res.repair?.attempts ?? []).map((a: any) => String(a.brief ?? '').match(/Failing cases \(\d+\):\r?\n([^\r\n]*)/)?.[1]).filter(Boolean);
  if (stuckOn.length) console.log(`        failing per attempt: ${stuckOn.map((c: string) => c.replace(/\s+\d+(\.\d+)?ms$/, '')).join(' | ')}`);
  if (res.review?.findings?.length) console.log(`        review: ${res.review.findings.map((f: any) => (f.blocking ? 'BLOCK ' : 'note ') + f.text).join(' || ').slice(0, 300)}`);
  if (!ok && res.message) console.log(`        message: ${String(res.message).slice(0, 300)}`);
  if (!ok && process.argv.includes('--verbose')) {
    console.log(['--- last proposal ---', String(res.patchSummary ?? '').slice(0, 1800)].join('\n'));
    console.log(['--- brief ---', String(res.verification?.repairBrief ?? '').slice(0, 1200)].join('\n'));
  }
  if (!ok && res.error) console.log(`        error: ${String(res.error).slice(0, 300)}`);
  return { id: t.id, ok, seconds: Math.round((Date.now() - started) / 1000), attempts: res.repair?.attemptCount ?? 1, outcome: res.repair?.outcome, repoGreen: truth.green, ws };
}

async function main() {
  console.log(`dashboard ${BASE}, repair budget ${ATTEMPTS}\n`);
  const results = [];
  console.log(`model ${MODEL ?? 'auto'}, think ${THINK ?? 'default'}, samples ${SAMPLES}, time budget ${DURATION_MS / 1000}s, repeat ${REPEAT}`);
  for (let rep = 0; rep < REPEAT; rep++) {
    for (const t of [...TASKS, ...loadFixtureTasks()].filter(x => WANT.includes(x.id))) results.push(await runTask(t));
  }
  const out = path.join(process.cwd(), 'scratch'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `smoke-coding-agents-${Date.now()}.json`), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} tasks as expected`);
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
}
main().catch(e => { console.error(e); process.exit(2); });
