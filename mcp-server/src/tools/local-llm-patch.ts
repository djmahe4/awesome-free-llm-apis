import { parseSearchReplaceBlocksDetailed, editsFromRewrittenExcerpt } from './coding-agents/patch-gen.js';
import { caTrace, caTraceDump } from './coding-agents/trace.js';
import { isInsideRoot, real } from '../utils/workspace-roots.js';
import fs from 'fs-extra';
import path from 'node:path';
import { rankNamesForNeed } from '../services/model-router.js';
import { listLocalModels, chatLocal, modelSupportsThinking, parseJsonlContent, type OllamaLocalChatResult } from '../providers/ollama-local.js';
import { ContextGatherer } from '../pipeline/middlewares/context-gatherer.js';
import { logToolCall } from '../utils/ChatLogger.js';

/**
 * local_llm_patch — Ollama-driven single-file patch stub (v1.0.9 scope, per
 * the deferred `coding_agents` split: full LSP-grounded multi-file version is
 * v1.1.0). Explicit non-goals, backed by the v1.0.9 retrospective on local
 * models + repo_graph RAG:
 *  - No multi-file patches — single `filePath` only.
 *  - No dataflow/variable-flow analysis — nothing in this repo does that yet
 *    (no LSP, no AST def-use tracking); a regex shortcut would produce false
 *    confidence, which is worse than admitting the gap.
 *  - No repo_graph.json semantic RAG — ContextGatherer's existing grep+graph
 *    neighborhood lookup is reused as-is; embedding graph nodes into
 *    VectorStore is real, separately-scoped work that doesn't pay off at
 *    single-file granularity.
 *  - No auto-apply to disk — returns a proposed patch; a human/agent applies
 *    it. Diff preview UI is deferred to v1.1.0.
 *  - No LSP validation of the produced patch.
 *  - Local Ollama only — no silent fallback to a cloud provider if no local
 *    server/model is available (fails fast instead), since a silent fallback
 *    would defeat the cost/privacy reasons someone picked this tool.
 */

/**
 * Why a model reply cannot be used, or null when it can. A reply built on a truncated
 * prompt edited a file the model never fully saw; a SEARCH/REPLACE reply with no complete
 * block (prose, or cut off at the output limit) has nothing to apply.
 */
export function rejectReply(r: OllamaLocalChatResult, isSearchReplace: boolean): string | null {
  if (r.promptTruncated) {
    return `prompt truncated: ${r.promptTokens} tokens filled num_ctx ${r.numCtx}; the model did not see the whole input (send a smaller excerpt)`;
  }
  if (!isSearchReplace) return r.outputTruncated ? 'output truncated at the reply token limit' : null;
  // Same block grammar as the applier, so a reply the applier can use is never thrown away here.
  const complete = parseSearchReplaceBlocksDetailed(r.content).blocks.length;
  if (complete === 0) {
    return r.outputTruncated
      ? 'output truncated before any complete SEARCH/REPLACE block'
      : 'reply contained no SEARCH/REPLACE block';
  }
  return null;
}

const VISION_MODEL_NAME = [/vision/i, /llava/i, /vl[:\-]/i, /\bvl\b/i];

/**
 * Local models to try for a code edit, best first. Vision-language models are left out entirely: this
 * tool never sends images, and a VL model never produced a usable edit in traced runs (it only added a
 * model swap and ~7 s per call). Embedding-only models fail the chat call and are skipped by it.
 */
export function codeEditCandidates(availableModels: string[], pinned?: string): string[] {
  const ranked = rankNamesForNeed(availableModels, 'code').filter(m => !VISION_MODEL_NAME.some(p => p.test(m)));
  // A caller-pinned model goes first (its own choice overrides ranking and the VRAM budget); the rest stay
  // as fallbacks. Only an installed model can be pinned: "qwen2.5-coder" matches "qwen2.5-coder:7b".
  const pin = pinned ? availableModels.find(m => m === pinned || m.startsWith(`${pinned}:`)) : undefined;
  return pin ? [pin, ...ranked.filter(m => m !== pin)] : ranked;
}

/**
 * Reply token cap, sized by what the reply can contain (not by model size: a 7B and a 9B need the same
 * tokens for the same text; size only changes the speed). SEARCH/REPLACE blocks are short. A rewritten
 * excerpt or file is about as long as the input (~3 chars per token for code) plus room for the edit;
 * a fixed 8192 let a looping model run for minutes on a 100-line excerpt.
 */
export function replyBudget(isSearchReplace: boolean, content: string): number {
  if (isSearchReplace) return 2048;
  return Math.min(8192, Math.max(1024, Math.ceil((content.length / 3) * 1.3) + 512));
}

export interface LocalLlmPatchInput {
  filePath: string;
  instruction: string;
  workspace_root?: string;
  sessionId?: string;
  allowCreate?: boolean;
  /** Sampling temperature (default 0: deterministic edits). */
  temperature?: number;
  // Sliding-window support (orchestrated by coding_agents): when the caller
  // already knows the file is large and has located the relevant region,
  // it passes just that excerpt here instead of letting this function read
  // and send the whole file. Asking a model to reproduce hundreds of
  // unchanged lines verbatim is what causes full-file truncation/hallucination
  // on large files — sending only the excerpt removes that failure mode
  // entirely, since the model never sees (and can't corrupt) the rest.
  /** @internal coding_agents passes a located excerpt. */
  contentOverride?: string;
  /** @internal coding_agents passes a located excerpt. */
  excerptRange?: { startLine: number; endLine: number; totalLines: number };
  // 'search-replace' asks the model for <<<<<<< SEARCH/=======/>>>>>>> REPLACE
  // blocks instead of full file/excerpt content — the caller (coding_agents)
  // parses and applies them against its own full copy of the file. Unlike
  // 'full', the model never has to reproduce unchanged text at all, so it
  // can't collapse/duplicate/truncate it. `patch` on success is the model's
  // raw response text (the blocks), not file content.
  /** @internal chosen by coding_agents. */
  outputFormat?: 'full' | 'search-replace';
  /** Installed Ollama model to try first (e.g. a bigger one for a hard edit); the ranked rest are fallbacks. */
  model?: string;
  /** Reasoning for thinking models: off (default; fastest at the same pass rate when measured), auto (on with budget headroom, retried without if it eats the budget), on. */
  think?: 'auto' | 'on' | 'off';
  /** @internal cancels the model call in flight (coding_agents passes its run's abort signal). */
  signal?: AbortSignal;
}

/** Extra reply tokens for a thinking model's reasoning on top of the edit's own budget. */
export const THINKING_HEADROOM = 3072;

export interface LocalLlmPatchResult {
  success: boolean;
  filePath?: string;
  isNewFile?: boolean;
  modelUsed?: string;
  usedFallbackModel?: boolean;
  patch?: string;
  content?: string;
  markdown?: string;
  error?: string;
}

export function formatLocalLlmPatchMarkdown(result: LocalLlmPatchResult): string {
  if (!result.success) {
    return `### 🩹 Local LLM Patch: Failed\n\n**Error:** ${result.error || 'Unknown error'}`;
  }

  const lines: string[] = [];
  lines.push(`### 🩹 Local LLM Patch: Success\n`);
  if (result.filePath) {
    lines.push(`- **Target File:** \`${result.filePath}\``);
  }
  if (result.modelUsed) {
    lines.push(`- **Model Used:** \`${result.modelUsed}\`${result.usedFallbackModel ? ' _(fallback)_' : ''}`);
  }

  if (result.patch) {
    lines.push(`\n#### Proposed Patch / New Content\n`);
    const trimmed = result.patch.trim();
    if (trimmed.startsWith('---') || trimmed.startsWith('@@') || trimmed.startsWith('diff --git')) {
      lines.push('```diff');
      lines.push(trimmed);
      lines.push('```');
    } else {
      const ext = path.extname(result.filePath || '').replace('.', '') || 'text';
      lines.push(`\`\`\`${ext}`);
      lines.push(trimmed);
      lines.push('```');
    }
  }

  return lines.join('\n');
}

/** Strips a single ```lang\n...\n``` fence if the model wrapped its answer in one, else returns the text unchanged. */
function extractCodeFromResponse(text: string): string {
  const fenced = text.match(/```(?:[a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}

export async function localLlmPatch(input: LocalLlmPatchInput): Promise<LocalLlmPatchResult> {
  const start = Date.now();
  const sessionId = input.sessionId || 'local-llm-patch-adhoc';
  let result: LocalLlmPatchResult;
  let isError = false;

  try {
    if (!input.filePath) throw new Error('filePath is required');
    if (!input.instruction) throw new Error('instruction is required');

    // With a workspace_root the target must live inside it (a relative path resolves against it): the file's
    // content is sent to a model, so a path that climbs out would exfiltrate an arbitrary local file.
    const absPath = input.workspace_root ? path.resolve(input.workspace_root, input.filePath) : path.resolve(input.filePath);
    if (input.workspace_root) {
      const rootReal = real(path.resolve(input.workspace_root));
      if (!isInsideRoot(absPath, rootReal) && !isInsideRoot(absPath, path.resolve(input.workspace_root))) {
        throw new Error(`filePath is outside workspace_root: ${absPath}`);
      }
      if (!isInsideRoot(real(absPath), rootReal)) throw new Error(`filePath is outside workspace_root (via a link): ${absPath}`);
    }
    const fileExists = await fs.pathExists(absPath);
    if (!fileExists && input.allowCreate === false) {
      throw new Error(`File not found: ${absPath}`);
    }

    let availableModels: string[];
    try {
      availableModels = await listLocalModels();
    } catch (err: any) {
      throw new Error(`Could not reach a local Ollama server (${process.env.OLLAMA_LOCAL_BASE_URL || 'http://localhost:11434'}): ${err.message}. Install/start Ollama and pull a model, e.g. \`ollama pull qwen2.5-coder\`.`);
    }
    if (availableModels.length === 0) {
      throw new Error('No models available on the local Ollama server. Pull one first, e.g. `ollama pull qwen2.5-coder`.');
    }

    // Capability-aware order (real /api/show capabilities when the router has seen the models,
    // else name heuristics): code-specialised first, vision/embedding models last, over-budget last.
    const candidateModels = codeEditCandidates(availableModels, input.model);
    if (candidateModels.length === 0) {
      throw new Error(`No local text model can edit code (found only: ${availableModels.join(', ')}). Pull one, e.g. \`ollama pull qwen2.5-coder\`.`);
    }

    // A windowed excerpt (see excerptRange) stands in for reading the real
    // file — the caller has already located the relevant region and is
    // asking the model to edit only that slice, so skip the disk read.
    const fileContent = input.contentOverride !== undefined
      ? input.contentOverride
      : (fileExists ? await fs.readFile(absPath, 'utf-8') : '');
    const workspaceRoot = input.workspace_root || path.dirname(absPath);

    let context: string[] = [];
    // Skip for brand-new files (no anchor) and for non-code file types.
    // CSS/HTML/JSON/YAML/text edits are structural/style goals — ContextGatherer's
    // TF-IDF grep returns cross-language snippets that are irrelevant-by-default
    // for these extensions. Observed: 5/6 real CSS/JS patch goals with injected
    // context failed (model hallucinates or summarises injected noise); 1 success
    // was the case where context injection was skipped. Extension gate is the
    // cheapest evidence-backed fix.
    const CODE_CONTEXT_EXTS = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.c', '.h',
      '.rb', '.php', '.swift', '.kt', '.scala', '.ex', '.exs',
    ]);
    const targetExt = path.extname(absPath).toLowerCase();
    // A windowed excerpt already IS the relevant region — skip whole-repo
    // context gathering, which would only dilute a prompt that's already
    // scoped down to exactly what needs editing.
    const shouldGatherContext = fileExists && CODE_CONTEXT_EXTS.has(targetExt) && !input.excerptRange;

    if (shouldGatherContext) {
      try {
        context = await ContextGatherer.gatherContext({
          workspaceRoot,
          query: `${path.basename(absPath)} ${input.instruction}`,
          limit: 3,
          sessionId,
        });
      } catch (err: any) {
        // Context enrichment is best-effort — a failure here (e.g. no git repo,
        // ripgrep unavailable) shouldn't block patch generation from the file
        // content alone.
        console.error(`[local-llm-patch] Context gathering failed, proceeding with file content only: ${err.message}`);
      }
    }

    const contextBlock = context.length > 0
      ? `\n\n## Related workspace context\n${context.join('\n\n')}`
      : '';

    const isSearchReplace = input.outputFormat === 'search-replace';

    // Excerpt wording explicitly forbids reproducing the rest of the file —
    // this is the actual fix: a model asked for "the complete file" on a
    // 1000-line file will truncate/hallucinate the parts it doesn't touch;
    // asking for just the excerpt removes that temptation entirely.
    const fileNotice = isSearchReplace
      ? `You are editing ${path.basename(absPath)}${input.excerptRange ? ` (an excerpt is shown below, lines ${input.excerptRange.startLine}–${input.excerptRange.endLine} of ${input.excerptRange.totalLines} total)` : ''}. The content below is shown ONLY so you can find exact text to change — you do not need to reproduce it.`
      : input.excerptRange
        ? `You are editing a specific section of ${path.basename(absPath)} (${input.excerptRange.totalLines} lines total). The excerpt below is lines ${input.excerptRange.startLine}–${input.excerptRange.endLine} of the file (${input.excerptRange.endLine - input.excerptRange.startLine + 1} lines). Your reply REPLACES this excerpt verbatim, line for line — reproduce every unchanged line exactly as shown, and only alter the specific line(s) the instruction targets. Do NOT summarize, abbreviate, or omit any line, and do NOT return just the changed line(s) alone — that would delete the rest of the excerpt. Wrap the full ${input.excerptRange.endLine - input.excerptRange.startLine + 1}-line reply in a single code fence with no other commentary. The file's content outside this excerpt is separate and must NOT be reproduced.`
        : fileExists
          ? `You are patching a single file. Apply the instruction and return the COMPLETE new file content only, wrapped in a single code fence. Do not include explanations outside the fence.`
          : `You are creating a new file: ${path.basename(absPath)}. Implement the instruction and return the COMPLETE file content only, wrapped in a single code fence. Do not include explanations outside the fence.`;

    const searchReplaceFormatBlock = isSearchReplace
      ? [
          '## Output format',
          'Return one or more blocks in EXACTLY this format and nothing else — no explanations, no code fence around the blocks:',
          '<<<<<<< SEARCH',
          '(exact existing text to find, copied verbatim character-for-character from above, including original whitespace/indentation)',
          '=======',
          '(the replacement text)',
          '>>>>>>> REPLACE',
          'Rules:',
          '1. SEARCH text must match the shown content exactly and must be unique (usually 1–5 lines — include enough surrounding text to make it unambiguous).',
          '2. Do not paraphrase or reformat SEARCH text.',
          '3. To ADD lines while retaining existing code: include the anchor line(s) in SEARCH, and in REPLACE include both the anchor line(s) AND the new lines. NEVER leave SEARCH empty.',
          '4. Emit multiple blocks if the instruction requires edits in more than one place.',
        ].join('\n')
      : '';

    const prompt = [
      fileNotice,
      input.excerptRange
        ? `## Excerpt: lines ${input.excerptRange.startLine}–${input.excerptRange.endLine} of ${path.basename(absPath)}`
        : `## File: ${path.basename(absPath)}`,
      '```',
      fileContent,
      '```',
      `## Instruction\n${input.instruction}`,
      contextBlock,
      searchReplaceFormatBlock,
    ].filter(Boolean).join('\n\n');

    // Try candidates in rankCandidateModels' preference order, calling the
    // real /api/chat endpoint each time — a model that can't actually chat
    // (e.g. an embedding-only model with a name that doesn't look like one)
    // reveals that by failing the call itself, not by a name-pattern guess.
    let chatResult: OllamaLocalChatResult | null = null;
    let modelUsed = '';
    let usedFallback = false;
    const attemptErrors: string[] = [];

    for (let i = 0; i < candidateModels.length; i++) {
      const candidate = candidateModels[i];
      try {
        const messages = [
          {
            role: 'system' as const,
            content: isSearchReplace
              ? 'You are a precise code-editing assistant. Reply with ONLY the requested SEARCH/REPLACE blocks.'
              : input.excerptRange
                ? 'You are a precise code-editing assistant. Return ONLY the updated excerpt lines inside one code fence. Do NOT return the rest of the file.'
                : 'You are a precise code-editing assistant. Return only the complete new file content in a single code fence.',
          },
          { role: 'user' as const, content: prompt },
        ];
        // Thinking models: off by default (in the cross-file matrix thinking had the same pass rate and was
        // 4-7x slower). 'auto'/'on' keep it, with room for the reasoning in the reply budget: traced, Qwythos
        // spent a bare 2048-token budget reasoning and returned nothing.
        const thinkMode = input.think ?? 'off';
        const supportsThinking = await modelSupportsThinking(candidate);
        const canThink = thinkMode !== 'off' && supportsThinking;
        const base = replyBudget(isSearchReplace, fileContent);
        // Only a model that can think gets the flag: off -> false, on -> true, auto -> the model's own default.
        const thinkFlag = !supportsThinking ? undefined : !canThink ? false : thinkMode === 'on' ? true : undefined;
        chatResult = await chatLocal(candidate, messages, {
          // Deterministic edits; explicit reply budget so num_ctx is sized for it.
          temperature: input.temperature ?? 0,
          maxTokens: canThink ? base + THINKING_HEADROOM : base,
          signal: input.signal,
          ...(thinkFlag !== undefined ? { think: thinkFlag } : {}),
        });
        // Reasoning still used the whole budget and nothing was answered: one retry with thinking off.
        if (canThink && thinkMode === 'auto' && !chatResult.content.trim() && chatResult.outputTruncated) {
          caTrace('thinking used the whole reply budget; retrying without thinking', candidate);
          chatResult = await chatLocal(candidate, messages, { temperature: input.temperature ?? 0, maxTokens: base, think: false, signal: input.signal });
        }
        // A small model often answers a SEARCH/REPLACE request with the edited excerpt instead; recover
        // the edit from it (SEARCH text taken from the original) rather than discarding a right answer.
        if (isSearchReplace && !chatResult.promptTruncated && !chatResult.outputTruncated
          && parseSearchReplaceBlocksDetailed(chatResult.content).blocks.length === 0) {
          const recovered = editsFromRewrittenExcerpt(fileContent, chatResult.content).blocks;
          if (recovered.length > 0) {
            caTrace('excerpt reply converted to SEARCH/REPLACE', `${candidate}: ${recovered.length} block(s)`);
            chatResult = { ...chatResult, content: recovered.map(b => `<<<<<<< SEARCH\n${b.search}\n=======\n${b.replace}\n>>>>>>> REPLACE`).join('\n\n') };
          }
        }
        caTraceDump(`reply-${candidate}-${path.basename(absPath)}`, chatResult.content);
        const rejection = rejectReply(chatResult, isSearchReplace);
        if (rejection) {
          caTraceDump(`rejected-${candidate}`, chatResult.content);
          caTrace('reply rejected',`${candidate}: ${rejection} | reply starts: ${JSON.stringify(chatResult.content.slice(0, 300))} | ends: ${JSON.stringify(chatResult.content.slice(-200))}`);
          attemptErrors.push(`${candidate}: ${rejection}`);
          chatResult = null;
          continue;
        }
        modelUsed = candidate;
        usedFallback = i > 0;
        break;
      } catch (err: any) {
        attemptErrors.push(`${candidate}: ${err.message}`);
        // aborted by the caller: do not move on to the next candidate model
        if (input.signal?.aborted) break;
      }
    }

    if (!chatResult) {
      throw new Error(`No candidate model could handle /api/chat. Tried: ${attemptErrors.join('; ')}`);
    }

    // SEARCH/REPLACE blocks aren't wrapped in a code fence (the format
    // explicitly forbids one) — extractCodeFromResponse would find no fence
    // and return the text unchanged anyway, but skip it outright for clarity.
    const rawContent = parseJsonlContent(chatResult.content);
    const patch = isSearchReplace ? rawContent : extractCodeFromResponse(rawContent);

    // Guard against canned refusal responses ("I'm sorry, but I can't assist with that request.")
    const refusalPatterns = [
      /I(?:'m| am)? sorry(?:,| but)? I can(?:'t| not) assist/i,
      /I cannot fulfill this request/i,
      /I am unable to assist with/i,
      /as an ai language model/i,
    ];
    const isRefusal = refusalPatterns.some(p => p.test(chatResult.content) || p.test(patch || ''));
    if (isRefusal) {
      throw new Error(
        `Model refused code modification: "${chatResult.content.trim()}". Context or instruction may have triggered safety filter. Retry with refined technical instruction.`
      );
    }

    result = {
      success: true,
      filePath: absPath,
      isNewFile: !fileExists,
      modelUsed,
      usedFallbackModel: usedFallback,
      patch,
    };
  } catch (err: any) {
    isError = true;
    result = { success: false, error: err?.message || String(err) };
  }

  result.content = formatLocalLlmPatchMarkdown(result);
  result.markdown = result.content;

  await logToolCall(sessionId, 'local_llm_patch', input, result, Date.now() - start, isError).catch(() => {});
  return result;
}
