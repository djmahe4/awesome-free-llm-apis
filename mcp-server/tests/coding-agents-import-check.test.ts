import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { newImportProblems } from '../src/tools/coding-agents/import-check.js';

// The in-memory TS gate ignores "cannot find module" (it has no real filesystem, so every import failed
// there). That also hid a genuinely wrong path. New imports are now resolved against the real workspace.

let ws = '';
beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'import-check-'));
    const write = (rel: string, c = '') => fs.outputFile(path.join(ws, rel), c);
    await write('src/browser/dispatch.ts');
    await write('src/browser/unsupported.ts');
    await write('src/utils/index.ts');
    await write('node_modules/zod/package.json', '{}');
    await write('node_modules/@scope/pkg/package.json', '{}');
    await write('shop/__init__.py');
    await write('shop/money.py');
    await write('shop/sub/__init__.py');
});
afterAll(async () => { await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const ts = (body: string) => `import { a } from './unsupported.js';\n${body}`;

describe('newImportProblems: JS/TS', () => {
    it('accepts relative imports that exist (.js written for a .ts source, index files, packages, node builtins)', async () => {
        const after = ts("import { b } from '../utils';\nimport { z } from 'zod';\nimport x from '@scope/pkg/deep';\nimport fs from 'node:fs';\nimport path from 'path';");
        expect(await newImportProblems('src/browser/dispatch.ts', ts(''), after, ws)).toEqual([]);
    });

    it('reports a relative path that does not exist, with the closest real file', async () => {
        const after = ts("import { f } from './unsuported.js';");
        const p = await newImportProblems('src/browser/dispatch.ts', ts(''), after, ws);
        expect(p).toHaveLength(1);
        expect(p[0]).toMatch(/'\.\/unsuported\.js' does not exist/);
        expect(p[0]).toMatch(/did you mean '\.\/unsupported\.js'/);
    });

    it('reports a package that is not installed, and require() too', async () => {
        const p = await newImportProblems('src/browser/dispatch.ts', '', "const l = require('lodash-nope');", ws);
        expect(p[0]).toMatch(/package 'lodash-nope' is not installed/);
    });

    it('only judges imports the edit added', async () => {
        const before = "import { gone } from './missing-already.js';";
        expect(await newImportProblems('src/browser/dispatch.ts', before, before + '\nconst x = 1;', ws)).toEqual([]);
    });
});

describe('newImportProblems: Python', () => {
    it('accepts a local package module and relative imports that exist; leaves installed packages alone', async () => {
        const after = 'from shop.money import format_price\nfrom . import money\nfrom .sub import thing\nimport requests\n';
        expect(await newImportProblems('shop/cart.py', '', after, ws)).toEqual([]);
    });

    it('reports a missing module inside a local package', async () => {
        const p = await newImportProblems('shop/cart.py', '', 'from shop.moneyy import format_price\n', ws);
        expect(p[0]).toMatch(/'shop\.moneyy' does not exist/);
        expect(p[0]).toMatch(/did you mean 'shop\.money'/);
    });
});
