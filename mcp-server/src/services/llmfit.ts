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
  const candidates = [
    startDir ? path.resolve(startDir, 'venv', 'Scripts') : null,
    startDir ? path.resolve(startDir, '..', 'venv', 'Scripts') : null,
    path.resolve(process.cwd(), 'venv', 'Scripts'),
    path.resolve(process.cwd(), '..', 'venv', 'Scripts'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    const exe = path.join(dir, 'llmfit.exe');
    const py = path.join(dir, 'python.exe');
    if (fs.existsSync(exe)) {
      return { binaryPath: exe, pythonPath: fs.existsSync(py) ? py : undefined };
    }
    if (fs.existsSync(py)) {
      return { pythonPath: py };
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

/**
 * Searches models in the llmfit database.
 */
export async function searchModels(
  query: string,
  options?: { limit?: number; workspaceRoot?: string }
): Promise<LlmFitModelInfo[]> {
  const { binaryPath, pythonPath } = resolveLlmFitExecutable(options?.workspaceRoot);
  const limit = options?.limit ?? 10;

  let rawOutput = '';
  if (binaryPath) {
    const args = ['list', '--json'];
    const res = await runCommand(binaryPath, args);
    rawOutput = res.stdout;
  } else if (pythonPath) {
    const code = `import subprocess, sys; res = subprocess.run(['llmfit', 'list', '--json'], capture_output=True, text=True); sys.stdout.write(res.stdout)`;
    const res = await runCommand(pythonPath, ['-c', code]);
    rawOutput = res.stdout;
  } else {
    throw new Error('llmfit is not installed in venv/Scripts');
  }

  const allModels: any[] = JSON.parse(rawOutput);
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
 */
export async function getModelInfo(
  modelName: string,
  options?: { workspaceRoot?: string }
): Promise<LlmFitModelInfo | null> {
  const cached = modelInfoCache.get(modelName);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  const { binaryPath, pythonPath } = resolveLlmFitExecutable(options?.workspaceRoot);
  if (!binaryPath && !pythonPath) return null;

  const tryQuery = async (query: string): Promise<string> => {
    if (binaryPath) {
      const res = await runCommand(binaryPath, ['info', query, '--json']);
      return res.stdout;
    }
    const code = `import subprocess, sys; res = subprocess.run(['llmfit', 'info', '${query}', '--json'], capture_output=True, text=True); sys.stdout.write(res.stdout)`;
    const res = await runCommand(pythonPath!, ['-c', code]);
    return res.stdout;
  };

  try {
    let out = await tryQuery(modelName);
    let data = out ? JSON.parse(out) : null;
    let resolved: LlmFitModelInfo | null = null;
    if (data?.models && data.models.length > 0) {
      resolved = parseModelItem(data.models[0]);
    } else {
      // If query was an Ollama tag like "qwen2.5-coder:7b", try resolving via search
      const results = await searchModels(modelName, options);
      if (results.length > 0) {
        out = await tryQuery(results[0].name);
        data = out ? JSON.parse(out) : null;
        if (data?.models && data.models.length > 0) {
          resolved = parseModelItem(data.models[0]);
        } else {
          resolved = results[0];
        }
      }
    }

    modelInfoCache.set(modelName, { data: resolved, timestamp: Date.now() });
    return resolved;
  } catch {
    // Return null if model not found or parsing failed
  }

  modelInfoCache.set(modelName, { data: null, timestamp: Date.now() });
  return null;
}
