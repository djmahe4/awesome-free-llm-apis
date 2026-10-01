import fetch from 'node-fetch';
import { getModelInfo } from '../services/llmfit.js';

/**
 * Standalone helper for a genuinely LOCAL Ollama server (http://localhost:11434
 * by default) — distinct from src/providers/ollama-cloud.ts's OllamaCloudProvider,
 * which talks to Ollama's hosted cloud API with Bearer auth. This one has no auth
 * (local servers don't need it) and a 2-endpoint surface (`/api/tags`, `/api/chat`),
 * so it uses node-fetch directly rather than pulling in the `ollama` npm package —
 * matching this repo's existing preference for minimal-dependency HTTP clients
 * (see ollama-cloud.ts's own plain-fetch approach).
 *
 * Deliberately NOT registered into ProviderRegistry/TextRouterMiddleware's normal
 * routing: it's localhost-only and optional (no server running = every call
 * fails), and the general fallback loop shouldn't try-and-fail against a host
 * that may not exist. Tools that want it (local-llm-patch.ts) call it directly.
 */

export interface OllamaLocalMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaLocalChatResult {
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
}

function getBaseUrl(): string {
  return (process.env.OLLAMA_LOCAL_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
}

const LIST_MODELS_TIMEOUT_MS = 5_000;
// Chat generation can legitimately run long on local hardware for a large prompt/diff —
// and "large prompt" here includes whatever ContextGatherer/memory/DAG-task-history
// injection stacked onto the instruction before it got here, not just the user's own
// text, so a flat ceiling either starves a heavily-context-injected call or is too
// generous for a trivial one. Scale with the actual serialized prompt size instead.
// coding_agents now runs non-dry-run execution as a background, pollable run (see
// CodingAgentsHandler), so this no longer needs to protect a blocking client call —
// it only needs to eventually terminate a truly stuck request rather than leak the
// background run forever. callers (local-llm-patch.ts) loop over multiple candidate
// models on failure, so this is a per-model ceiling, not a per-request one.
const CHAT_TIMEOUT_BASE_MS = 60_000;
const CHAT_TIMEOUT_MAX_MS = 15 * 60_000;
// ~12ms of extra generation budget per prompt character — loose heuristic (local
// coder models run well under 1 char/ms of *output*, but a long prompt also costs
// prefill time before any output starts), capped by CHAT_TIMEOUT_MAX_MS regardless.
const CHAT_TIMEOUT_MS_PER_CHAR = 12;

function computeChatTimeoutMs(messages: OllamaLocalMessage[]): number {
  const promptChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  return Math.min(CHAT_TIMEOUT_MAX_MS, CHAT_TIMEOUT_BASE_MS + promptChars * CHAT_TIMEOUT_MS_PER_CHAR);
}

/** Lists model tags available on the local Ollama server, e.g. ["qwen2.5-coder:7b", "llama3.1:8b"]. */
export async function listLocalModels(): Promise<string[]> {
  const url = `${getBaseUrl()}/api/tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_MODELS_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal as any });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama local server did not respond within ${LIST_MODELS_TIMEOUT_MS}ms for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`Ollama local server responded HTTP ${response.status} for ${url}`);
  }
  const data = await response.json() as { models?: Array<{ name: string }> };
  return (data.models || []).map(m => m.name);
}

/**
 * Orders the available tags list with coding-oriented names first — a
 * preference ranking only, NOT a filter. /api/tags has no reliable field
 * saying "this is an embedding-only model" (nomic-embed-text, bge-*, etc. —
 * name conventions vary and aren't guaranteed), so whether a model actually
 * supports /api/chat can only be determined empirically by trying it. Callers
 * should walk this list in order, attempt a real chatLocal() call, and fall
 * through to the next candidate on failure (see local-llm-patch.ts) — that
 * failure IS the chat-capability check, not a name guess.
 */
export function rankCandidateModels(availableModels: string[]): string[] {
  // local_llm_patch / coding_agents never send image content — they're
  // pure-text code-editing tools — so a vision-tuned model brings no
  // benefit and has demonstrated real harm: observed live, when the top
  // coding-pattern candidate errored mid-call, the fallback loop landed on
  // a vision-language model (qwen2.5vl:3b) for a strict text-format
  // (SEARCH/REPLACE) request, which degenerated into a repetition loop and
  // never produced a valid response. Excluded outright, not just
  // deprioritized, since no text-editing task ever benefits from one.
  const visionPatterns = [/vision/i, /llava/i, /vl[:\-]/i];
  const textModels = availableModels.filter(m => !visionPatterns.some(p => p.test(m)));

  const codingPatterns = [/codellama/i, /qwen.*coder/i, /devstral/i, /deepseek.*coder/i, /coder/i];
  const preferred: string[] = [];
  const rest: string[] = [];
  for (const m of textModels) {
    if (codingPatterns.some(p => p.test(m))) preferred.push(m);
    else rest.push(m);
  }
  return [...preferred, ...rest];
}

export async function chatLocal(model: string, messages: OllamaLocalMessage[], options?: { temperature?: number; maxTokens?: number; numCtx?: number }): Promise<OllamaLocalChatResult> {
  const url = `${getBaseUrl()}/api/chat`;
  const timeoutMs = computeChatTimeoutMs(messages);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let numCtx = options?.numCtx;
  if (!numCtx) {
    const promptChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedPromptTokens = Math.ceil(promptChars / 3.5);
    const headroom = options?.maxTokens ?? 4096;
    const needed = estimatedPromptTokens + headroom;

    if (process.env.OLLAMA_CONTEXT_LENGTH) {
      const envCtx = parseInt(process.env.OLLAMA_CONTEXT_LENGTH, 10);
      if (!isNaN(envCtx) && envCtx > 0) numCtx = Math.max(envCtx, needed);
    }

    if (!numCtx) {
      try {
        const fitInfo = await getModelInfo(model);
        const maxSupported = fitInfo?.contextLength ?? 32768;
        numCtx = Math.min(Math.max(2048, needed), maxSupported);
      } catch {
        numCtx = Math.min(Math.max(2048, needed), 32768);
      }
    }
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: options?.temperature,
          num_predict: options?.maxTokens,
          num_ctx: numCtx,
        },
      }),
      signal: controller.signal as any,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama local model '${model}' did not respond within ${timeoutMs}ms (scaled to prompt size).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Ollama local server responded HTTP ${response.status}: ${text}`);
  }
  const data = await response.json() as {
    model: string;
    message: { role: string; content: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  return {
    model: data.model,
    content: data.message?.content || '',
    promptTokens: data.prompt_eval_count ?? 0,
    completionTokens: data.eval_count ?? 0,
  };
}

export interface PatchOptions {
  teachMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  coachTool?: any;
}

export interface PatchWithReinforceResult {
  patchResult: OllamaLocalChatResult;
  explanationFrame?: any;
  reflection?: string;
}

/**
 * Executes a patch request with optional teachMode integration and Phase 4 reinforce reflection.
 */
export async function patch(
  model: string,
  filePath: string,
  fileContent: string,
  instruction: string,
  options?: PatchOptions
): Promise<OllamaLocalChatResult> {
  let promptText = instruction;
  if (options?.teachMode && options?.coachTool) {
    const frame = options.coachTool.explainInstruction(instruction);
    promptText = `${instruction}\n\n[Coach Mode Active]\nConcept: ${frame.concept}\nExample: ${frame.example}\nExercise: ${frame.exercise}\nHint: ${frame.hint}`;
  }

  const messages: OllamaLocalMessage[] = [
    { role: 'system', content: 'You are a precise code-editing assistant. Return only the complete new file content in a single code fence.' },
    { role: 'user', content: `## File: ${filePath}\n\`\`\`\n${fileContent}\n\`\`\`\n\n## Instruction\n${promptText}` },
  ];

  return chatLocal(model, messages, { temperature: options?.temperature, maxTokens: options?.maxTokens });
}

/**
 * Higher-level helper that applies a patch and records Phase 4 reinforcement.
 */
export async function applyPatchWithReinforce(
  model: string,
  filePath: string,
  fileContent: string,
  instruction: string,
  coachTool?: any,
  options?: PatchOptions
): Promise<PatchWithReinforceResult> {
  const effectiveOptions: PatchOptions = { ...options, coachTool };
  const patchResult = await patch(model, filePath, fileContent, instruction, effectiveOptions);
  
  let reflection: string | undefined;
  let explanationFrame: any;

  if (coachTool) {
    explanationFrame = coachTool.getHistory().slice(-1)[0]?.explanation;
    reflection = coachTool.reinforce(instruction, `Patched ${filePath} successfully`);
  }

  return {
    patchResult,
    explanationFrame,
    reflection,
  };
}

