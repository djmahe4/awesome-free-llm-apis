import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
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

    // Resolve agent prompt path deterministically for monorepo and standalone layouts.
    const localPromptDir = resolve(root, 'external/agent-prompt');
    const repoPromptDir = resolve(root, '../external/agent-prompt');
    const candidates = [process.env.AGENT_PROMPT_PATH, localPromptDir, repoPromptDir]
      .filter(Boolean);

    const resolvedPromptDir = candidates.find((dir) => existsSync(resolve(dir, 'README.md')));
    if (resolvedPromptDir) {
      console.log(`Using AGENT_PROMPT_PATH=${resolvedPromptDir}`);
    } else {
      console.warn('Warning: Could not auto-resolve AGENT_PROMPT_PATH from expected locations.');
    }

    execSync(`${pythonPath} "${scriptPath}"`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(resolvedPromptDir ? { AGENT_PROMPT_PATH: resolvedPromptDir } : {}),
      },
    });
} catch (err) {
    console.error('Warning: Prompt synchronization failed. Details:', err.message);
}
