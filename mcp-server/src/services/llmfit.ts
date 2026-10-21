import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import { resolveConfigDir } from '../utils/config-path.js';

export interface LlmFitModelInfo {
  name: string;
  ollamaName?: string;
  contextLength?: number;
  effectiveContextLength?: number;
  usableContext?: number;
  score?: number;
  fitLevel?: string;
  runMode?: string;
  memoryRequiredGb?: number;
  bestQuant?: string;
  useCase?: string;
  /** Minimum VRAM for the catalog's quantization (`llmfit list`), a hint, not the installed file's need. */
  minVramGb?: number;
}

export interface LlmFitSystemInfo {
  totalRamGb?: number;
  availableRamGb?: number;
  hasGpu?: boolean;
  gpuName?: string;
  gpuVramGb?: number;
  cpuCores?: number;
}

export interface LlmFitRecommendResult {
  system?: LlmFitSystemInfo;
  models: LlmFitModelInfo[];
}

/**
 * Resolves the path to the Python or llmfit executable inside venv/Scripts.
 */
export function resolveLlmFitExecutable(startDir?: string): { binaryPath?: string; pythonPath?: string } {
  const isWin = process.platform === 'win32';
  const binDirName = isWin ? 'Scripts' : 'bin';
  const exeName = isWin ? 'llmfit.exe' : 'llmfit';
  const pyName = isWin ? 'python.exe' : 'python';

  const candidates = [
    startDir ? path.resolve(startDir, 'venv', binDirName) : null,
    startDir ? path.resolve(startDir, '..', 'venv', binDirName) : null,
    path.resolve(process.cwd(), 'venv', binDirName),
    path.resolve(process.cwd(), '..', 'venv', binDirName),
    // Fallback: check both Scripts and bin regardless of platform
    startDir ? path.resolve(startDir, 'venv', 'bin') : null,
    path.resolve(process.cwd(), 'venv', 'bin'),
    startDir ? path.resolve(startDir, 'venv', 'Scripts') : null,
    path.resolve(process.cwd(), 'venv', 'Scripts'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    const exe = path.join(dir, exeName);
    const py = path.join(dir, pyName);
    const exeFallback = path.join(dir, 'llmfit');
    const pyFallback = path.join(dir, 'python');

    if (fs.existsSync(exe)) {
      return { binaryPath: exe, pythonPath: fs.existsSync(py) ? py : undefined };
    }
    if (fs.existsSync(exeFallback)) {
      return { binaryPath: exeFallback, pythonPath: fs.existsSync(pyFallback) ? pyFallback : undefined };
    }
    if (fs.existsSync(py)) {
      return { pythonPath: py };
    }
    if (fs.existsSync(pyFallback)) {
      return { pythonPath: pyFallback };
    }
  }

  return {};
}

let recommendCache: { data: LlmFitRecommendResult; timestamp: number } | null = null;
const modelInfoCache = new Map<string, { data: LlmFitModelInfo | null; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Runs a command asynchronously, collecting stdout/stderr with a timeout.
 */
function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 30000
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command '${cmd} ${args.join(' ')}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Comparison key for an Ollama tag: llmfit's catalog uses Hugging Face names, so
 * `qwen2.5-coder:7b` has to be compared with `Qwen/Qwen2.5-Coder-7B-Instruct`.
 * Registry and org prefixes go, size tags (`:7b`) stay, other tags (`:latest`, `:Q4_K_M`) go, as do
 * `-GGUF` and every non-alphanumeric character.
 */
export function ollamaTagKey(tag: string): string {
  let t = String(tag || '').trim().toLowerCase().replace(/^hf\.co\//, '');
  if (!t) return '';
  t = t.split('/').pop() as string;
  const [name, rawTag] = t.split(':');
  const size = rawTag && /^\d+(?:\.\d+)?[bm]$/.test(rawTag) ? rawTag : '';
  return (name.replace(/-?gguf$/, '') + size).replace(/[^a-z0-9]/g, '');
}

const catalogKey = (name: string) => String(name || '').toLowerCase().split('/').pop()!.replace(/[^a-z0-9]/g, '');

/** Finds the llmfit catalog entry for an Ollama tag (shortest name wins: the plain model, not a quantized variant). */
export function pickLlmfitMatch<T extends { name?: string }>(tag: string, catalog: T[]): T | null {
  const key = ollamaTagKey(tag);
  if (!key) return null;
  let best: { m: T; len: number } | null = null;
  for (const m of catalog) {
    const k = catalogKey(m.name ?? '');
    if (k.startsWith(key) && (!best || k.length < best.len)) best = { m, len: k.length };
  }
  return best ? best.m : null;
}

let catalogCache: { models: any[]; timestamp: number } | null = null;
const CATALOG_TTL_MS = 30 * 60 * 1000;

/** Maps one `llmfit list --json` entry (fast: no subprocess per model). */
export function catalogEntryToInfo(m: any): LlmFitModelInfo {
  return {
    name: m.name,
    contextLength: m.context_length,
    minVramGb: m.min_vram_gb,
    bestQuant: m.quantization,
    useCase: m.use_case,
  };
}

function parseModelItem(m: any): LlmFitModelInfo {
  return {
    name: m.name,
    ollamaName: m.ollama_name,
    contextLength: m.context_length,
    effectiveContextLength: m.effective_context_length,
    usableContext: m.usable_context,
    score: m.score,
    fitLevel: m.fit_level,
    runMode: m.run_mode,
    memoryRequiredGb: m.memory_required_gb,
    bestQuant: m.best_quant,
    useCase: m.use_case,
  };
}

/**
 * Recommends models for the host system using llmfit.
 */
export async function recommendModels(options?: {
  useCase?: string;
  limit?: number;
  workspaceRoot?: string;
}): Promise<LlmFitRecommendResult> {
  const { binaryPath, pythonPath } = resolveLlmFitExecutable(options?.workspaceRoot);
  const limit = options?.limit ?? 5;
  const useCase = options?.useCase ?? 'coding';

  if (recommendCache && (Date.now() - recommendCache.timestamp < CACHE_TTL_MS)) {
    return {
      system: recommendCache.data.system,
      models: recommendCache.data.models.slice(0, limit),
    };
  }

  let rawOutput = '';

  try {
    if (binaryPath) {
      const args = ['recommend', '--json', '--use-case', useCase, '--limit', String(limit)];
      const res = await runCommand(binaryPath, args);
      rawOutput = res.stdout;
    } else if (pythonPath) {
      const code = `import subprocess, sys; res = subprocess.run(['llmfit', 'recommend', '--json', '--use-case', '${useCase}', '--limit', '${limit}'], capture_output=True, text=True); sys.stdout.write(res.stdout)`;
      const res = await runCommand(pythonPath, ['-c', code]);
      rawOutput = res.stdout;
    } else {
      throw new Error('llmfit is not installed in venv/Scripts');
    }
  } catch (err: any) {
    throw new Error(`llmfit execution failed: ${err.message || err}`);
  }

  const data = JSON.parse(rawOutput);
  const models = (data.models || []).map(parseModelItem);
  const result: LlmFitRecommendResult = {
    system: data.system ? {
      totalRamGb: data.system.total_ram_gb,
      availableRamGb: data.system.available_ram_gb,
      hasGpu: data.system.has_gpu,
      gpuName: data.system.gpu_name,
      gpuVramGb: data.system.gpu_vram_gb,
      cpuCores: data.system.cpu_cores,
    } : undefined,
    models,
  };

  recommendCache = { data: result, timestamp: Date.now() };
  return result;
}

async function loadCatalog(binaryPath?: string, pythonPath?: string): Promise<any[]> {
  if (catalogCache && Date.now() - catalogCache.timestamp < CATALOG_TTL_MS) return catalogCache.models;
  let rawOutput = '';
  if (binaryPath) {
    rawOutput = (await runCommand(binaryPath, ['list', '--json'], 60000)).stdout;
  } else if (pythonPath) {
    const code = `import subprocess, sys; res = subprocess.run(['llmfit', 'list', '--json'], capture_output=True, text=True); sys.stdout.write(res.stdout)`;
    rawOutput = (await runCommand(pythonPath, ['-c', code], 60000)).stdout;
  } else {
    throw new Error('llmfit is not installed in venv/Scripts');
  }
  const models = JSON.parse(rawOutput) as any[];
  catalogCache = { models, timestamp: Date.now() };
  return models;
}

/**
 * Searches models in the llmfit database (the ~14k-entry catalog is cached for 30 minutes).
 */
export async function searchModels(
  query: string,
  options?: { limit?: number; workspaceRoot?: string }
): Promise<LlmFitModelInfo[]> {
  const { binaryPath, pythonPath } = resolveLlmFitExecutable(options?.workspaceRoot);
  const limit = options?.limit ?? 10;
  const allModels = await loadCatalog(binaryPath, pythonPath);
  const q = query.toLowerCase();
  const matched = allModels.filter((m: any) =>
    (m.name && m.name.toLowerCase().includes(q)) ||
    (m.provider && m.provider.toLowerCase().includes(q)) ||
    (m.ollama_name && m.ollama_name.toLowerCase().includes(q))
  );

  return matched.slice(0, limit).map(parseModelItem);
}

/**
 * Retrieves detailed info (including max/effective context size) for a model name or ollama tag.
 * Ollama tags are mapped to llmfit's Hugging Face catalog names first (`qwen2.5-coder:7b` ->
 * `Qwen/Qwen2.5-Coder-7B-Instruct`); `llmfit info` does not understand Ollama tags itself.

 * `memoryBudgetGb` scores fit against that VRAM budget (llmfit --memory) instead of the whole GPU.
 *
 * `fast: true` answers from the cached catalog only (about 0.3 s once, then instant). The full
 * `llmfit info` call reloads llmfit's database on every invocation and takes about 4 s per model,
 * which is too slow for discovery across several models; use it only when the fit label is needed.
 */
export async function getModelInfo(
  modelName: string,
  options?: { workspaceRoot?: string; memoryBudgetGb?: number; fast?: boolean }
): Promise<LlmFitModelInfo | null> {
  const cacheKey = `${modelName}|${options?.memoryBudgetGb ?? ''}|${options?.fast ? 'fast' : 'full'}`;
  const cached = modelInfoCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  const { binaryPath, pythonPath } = resolveLlmFitExecutable(options?.workspaceRoot);
  if (!binaryPath && !pythonPath) return null;

  const memoryArgs = options?.memoryBudgetGb ? ['--memory', `${options.memoryBudgetGb}G`] : [];
  const tryQuery = async (query: string): Promise<string> => {
    if (binaryPath) {
      const res = await runCommand(binaryPath, [...memoryArgs, 'info', query, '--json']);
      return res.stdout;
    }
    const code = `import subprocess, sys; res = subprocess.run(['llmfit', ${memoryArgs.map(a => `'${a}'`).concat(["'info'", `'${query.replace(/'/g, "")}'`, "'--json'"]).join(', ')}], capture_output=True, text=True); sys.stdout.write(res.stdout)`;
    const res = await runCommand(pythonPath!, ['-c', code]);
    return res.stdout;
  };

  try {
    let resolved: LlmFitModelInfo | null = null;
    const catalog = await loadCatalog(binaryPath, pythonPath).catch(() => [] as any[]);
    const match = pickLlmfitMatch(modelName, catalog);
    if (options?.fast) {
      const fastInfo = match ? catalogEntryToInfo(match) : null;
      modelInfoCache.set(cacheKey, { data: fastInfo, timestamp: Date.now() });
      return fastInfo;
    }
    const query = match?.name ?? modelName;
    const out = await tryQuery(query);
    const data = out ? JSON.parse(out) : null;
    if (data?.models && data.models.length > 0) {
      resolved = parseModelItem(data.models[0]);
    } else if (match) {
      resolved = parseModelItem(match);
    }

    modelInfoCache.set(cacheKey, { data: resolved, timestamp: Date.now() });
    return resolved;
  } catch {
    // Return null if model not found or parsing failed
  }

  modelInfoCache.set(cacheKey, { data: null, timestamp: Date.now() });
  return null;
}
