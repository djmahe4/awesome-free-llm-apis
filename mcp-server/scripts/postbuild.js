import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const copies = [
  { from: 'src/providers/gemini_client.py', to: 'dist/providers/gemini_client.py' },
  { from: 'scripts/update_prompt_json.py', to: 'dist/scripts/update_prompt_json.py' },
];

console.log('Running post-build tasks...');

for (const { from, to } of copies) {
  const src = resolve(root, from);
  const dest = resolve(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`  copied ${from} → ${to}`);
}

// Step 2: Run Python prompt extraction
try {
    console.log('Synchronizing system prompt via Python...');
    const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
    const scriptPath = resolve(root, 'scripts/update_prompt_json.py');
    execSync(`${pythonPath} "${scriptPath}"`, { stdio: 'inherit' });
} catch (err) {
    console.error('Warning: Prompt synchronization failed. Details:', err.message);
}
