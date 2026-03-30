#!/usr/bin/env node
/**
 * Cross-platform postbuild script.
 * Copies assets that tsc doesn't handle (e.g. .py files) into dist/.
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const copies = [
  { from: 'src/providers/gemini_client.py', to: 'dist/providers/gemini_client.py' },
];

for (const { from, to } of copies) {
  const dest = resolve(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(resolve(root, from), dest);
  console.log(`  copied ${from} → ${to}`);
}
