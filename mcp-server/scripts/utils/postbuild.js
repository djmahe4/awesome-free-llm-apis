/**
 * @file postbuild.js
 * @description Handles post-build cleanup, script synchronization, and directory preparation for the production distribution.
 * Usage: node scripts/utils/postbuild.js
 */
import fs, { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { torchInstallPlan } from './optional-deps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const copies = [
  { from: 'src/providers/gemini_client.py', to: 'dist/providers/gemini_client.py' },
  { from: 'scripts/utils/update_prompt_json.py', to: 'dist/scripts/update_prompt_json.py' },
  { from: 'scripts/utils/pdf_screenshot.py', to: 'dist/scripts/pdf_screenshot.py' },
  { from: 'scripts/model_inspector.py', to: 'dist/scripts/model_inspector.py' },
  { from: 'scripts/quant_engine.py', to: 'dist/scripts/quant_engine.py' },
  { from: 'scripts/moe_engine.py', to: 'dist/scripts/moe_engine.py' },
  { from: 'scripts/reasoning_engine.py', to: 'dist/scripts/reasoning_engine.py' },
  { from: 'scripts/yolo_nn_engine.py', to: 'dist/scripts/yolo_nn_engine.py' },
  { from: 'scripts/torch_nn_engine.py', to: 'dist/scripts/torch_nn_engine.py' },
  { from: 'scripts/weight_space_programmer.py', to: 'dist/scripts/weight_space_programmer.py' },
  { from: 'scripts/scene_augmentation.py', to: 'dist/scripts/scene_augmentation.py' },
  { from: 'scripts/vlm_reverse_generator.py', to: 'dist/scripts/vlm_reverse_generator.py' },
  { from: 'scripts/audio_separator.py', to: 'dist/scripts/audio_separator.py' },
  { from: 'scripts/depth_parallax_engine.py', to: 'dist/scripts/depth_parallax_engine.py' },
  { from: 'scripts/headless_media_compiler.py', to: 'dist/scripts/headless_media_compiler.py' },
  { from: 'scripts/sandboxes/python-sandbox-runner.py', to: 'dist/scripts/sandboxes/python-sandbox-runner.py' },
  { from: 'scripts/utils/generate_model_fixtures.py', to: 'dist/scripts/utils/generate_model_fixtures.py' },
];

console.log('Running post-build tasks...');

// Step 1: Ensure Python virtual environment and dependencies exist
try {
  console.log('Setting up Python virtual environment...');
  const venvDir = resolve(root, 'venv');
  const isWin = process.platform === 'win32';
  const pythonPath = isWin
    ? resolve(venvDir, 'Scripts', 'python.exe')
    : resolve(venvDir, 'bin', 'python');

  if (!existsSync(venvDir)) {
    console.log('Creating virtual environment...');
    const sysPython = isWin ? 'python' : 'python3';
    execSync(`"${sysPython}" -m venv "${venvDir}"`, { stdio: 'inherit' });
  }

  console.log('Installing/upgrading Python dependencies (pymupdf, google-genai, duckduckgo-mcp-server, kokoro-onnx, soundfile, llmfit, numpy, RestrictedPython)...');
  execSync(`"${pythonPath}" -m pip install pymupdf google-genai duckduckgo-mcp-server kokoro-onnx soundfile llmfit numpy RestrictedPython`, { stdio: 'inherit' });
  console.log('Python virtual environment setup complete.');
} catch (err) {
  console.error('Warning: Python virtual environment setup failed. Details:', err.message);
}

// Step 1b (optional): PyTorch lets the model inspector read .pt checkpoints. It is a large download, so it is
// skipped in CI and with SKIP_TORCH=1, and a failed install only warns.
try {
  const venvPython = process.platform === 'win32'
    ? resolve(root, 'venv', 'Scripts', 'python.exe')
    : resolve(root, 'venv', 'bin', 'python');
  let torchPresent = false;
  try { execSync(`"${venvPython}" -c "import torch"`, { stdio: 'ignore' }); torchPresent = true; } catch { /* not installed */ }
  const plan = torchInstallPlan({ env: process.env, platform: process.platform, torchPresent });
  if (plan.install) {
    console.log('Installing optional PyTorch (' + plan.reason + '); set SKIP_TORCH=1 to skip...');
    execSync(`"${venvPython}" -m pip ${plan.args.join(' ')}`, { stdio: 'inherit' });
  } else {
    console.log('Skipping optional PyTorch: ' + plan.reason + '.');
  }
} catch (err) {
  console.warn('Warning: optional PyTorch install failed; .pt checkpoints will not be readable. Details:', err.message);
}

for (const { from, to } of copies) {
  const src = resolve(root, from);
  const dest = resolve(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  if (fs.existsSync(src)) {
    copyFileSync(src, dest);
    console.log(`  copied ${from} → ${to}`);

  } else {
    console.warn(`Warning: source file missing, skipping copy: ${src}`);
  }

}

// Step 1.5: Pre-download embedding models
try {
    console.log('Pre-downloading embedding models...');
    const downloadScript = resolve(root, 'scripts/utils/download-models.js');
    execSync(`node "${downloadScript}"`, { stdio: 'inherit' });
} catch (err) {
    console.warn('Warning: Model download failed. Details:', err.message);
}

// Step 2: Run Python prompt extraction
try {
    console.log('Synchronizing system prompt via Python...');
    const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
    const scriptPath = resolve(root, 'scripts/utils/update_prompt_json.py');

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

// Step 3: Deploy SearXNG Docker container if docker --version is available
try {
  console.log('Checking Docker availability for SearXNG deployment...');
  const { ensureSearxngContainer } = await import('../../dist/search/searxng-deploy.js');
  ensureSearxngContainer();
} catch (err) {
  console.warn('Warning: SearXNG Docker deployment check skipped. Details:', err.message);
}

// Step 4: Ensure cyber tools index is synchronized
try {
  const cyberToolsPath = resolve(root, 'external/cyber-tools-index/tools_config.json');
  if (!existsSync(cyberToolsPath)) {
    console.log('Synchronizing cyber-tools-index from remote repository...');
    const { fetchCyberToolsIndex } = await import('../fetch-cyber-tools.js');
    await fetchCyberToolsIndex();
  }
} catch (err) {
  console.warn('Warning: Cyber tools index sync skipped. Details:', err.message);
}
