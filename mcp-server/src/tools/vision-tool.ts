import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { toMarkdownResponse } from '../utils/markdown.js';
import { PipelineExecutor, TaskType, type PipelineContext } from '../pipeline/middleware.js';
import {
  getStructuralMarkdownMiddleware,
  getSharedResponseCache,
  getWorkspaceContextMiddleware,
  getSharedImageRouter,
} from '../pipeline/instances.js';
import { RunRegistry } from '../pipeline/middlewares/RunRegistry.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { renderPdfPage } from '../utils/PdfRenderer.js';

const VISION_TASK_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_WAIT_MS = 25_000;
const VISION_RUN_PREFIX = 'vision_tool:';
const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024;

export interface VisionToolInput {
  workspace_root?: string;
  /** Required for a new run; not needed when polling or aborting by taskId. */
  image_path?: string;
  prompt?: string;
  model?: string;
  action?: 'run' | 'status' | 'continue' | 'abort';
  /** Returned by run; use it for status, continue, or abort. */
  taskId?: string;
  /** Alias for taskId, useful to callers that already track tools by session. */
  sessionId?: string;
}

export interface VisionToolResult {
  ok: boolean;
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'aborted';
  taskId: string;
  response?: string;
  content?: string;
  markdown?: string;
  model?: string;
  error?: { code: string; message: string; stage?: string };
  progress?: { completed: number; total: number; label?: string };
  pdf?: {
    page: number;
    totalPages: number;
    textExtracted: boolean;
    visualPageRendered: boolean;
    imageCoverageRatio?: number;
  };
  warnings?: string[];
}

type VisionRunInput = Omit<VisionToolInput, 'action' | 'taskId' | 'sessionId'> & { image_path: string };

const taskInputs = new BoundedMap<string, VisionRunInput>(100);
const taskResults = new BoundedMap<string, VisionToolResult>(100);

class VisionTaskError extends Error {
  constructor(readonly code: string, message: string, readonly stage?: string) {
    super(message);
    this.name = 'VisionTaskError';
  }
}

function taskKey(taskId: string): string {
  return `${VISION_RUN_PREFIX}${taskId}`;
}

function responseWaitMs(): number {
  const configured = Number(process.env.VISION_TOOL_RESPONSE_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0
    ? Math.min(configured, DEFAULT_RESPONSE_WAIT_MS)
    : DEFAULT_RESPONSE_WAIT_MS;
}

function resolveInputPath(input: VisionToolInput): { imageFsPath: string; pageNum: number; isPdf: boolean } {
  if (!input.image_path) throw new Error('vision_tool requires image_path for action "run".');
  if (!input.image_path.startsWith('file:///')) throw new Error('image_path must use file:/// scheme.');

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(input.image_path.replace(/^file:\/\//, ''));
  } catch {
    throw new Error('image_path contains invalid URI encoding.');
  }
  if (decodedPath.startsWith('/') && /^\/[A-Za-z]:\//.test(decodedPath)) decodedPath = decodedPath.substring(1);

  const pageMatch = decodedPath.match(/^(.*\.pdf):(\d+)$/i);
  const cleanPath = pageMatch ? pageMatch[1] : decodedPath;
  const pageNum = pageMatch ? Number.parseInt(pageMatch[2], 10) : 1;
  if (!Number.isInteger(pageNum) || pageNum < 1) throw new Error('PDF page number must be a positive integer.');

  const imageFsPath = path.resolve(cleanPath);
  if (input.workspace_root) {
    const workspacePath = path.resolve(input.workspace_root);
    const relative = path.relative(workspacePath, imageFsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('image_path must be inside workspace_root boundaries.');
    }
  }
  return { imageFsPath, pageNum, isPdf: imageFsPath.toLowerCase().endsWith('.pdf') };
}

function runningResult(taskId: string, run: ReturnType<typeof RunRegistry.get>): VisionToolResult {
  return {
    ok: true,
    status: 'running',
    taskId,
    progress: {
      completed: run?.completedCount ?? 0,
      total: run?.totalCount ?? 1,
      label: run?.lastSubtask,
    },
  };
}

function failedResult(taskId: string, error: unknown, status?: VisionToolResult['status']): VisionToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const visionError = error instanceof VisionTaskError ? error : undefined;
  const inferred = !visionError && /no usable assistant content|without usable assistant content/i.test(message)
    ? { code: 'VISION_EMPTY_RESPONSE', stage: 'response_validation' }
    : !visionError && /provider marked the response as an error|provider returned an error response/i.test(message)
      ? { code: 'VISION_PROVIDER_ERROR', stage: 'provider' }
      : !visionError && /no available providers for vision routing/i.test(message)
        ? { code: 'VISION_NO_PROVIDER', stage: 'provider' }
        : undefined;
  return {
    ok: false,
    status: status || (visionError?.code === 'VISION_TIMEOUT' ? 'timed_out' : 'failed'),
    taskId,
    error: {
      code: visionError?.code || inferred?.code || 'VISION_FAILED',
      message,
      ...((visionError?.stage || inferred?.stage) ? { stage: visionError?.stage || inferred?.stage } : {}),
    },
  };
}

function completedResult(taskId: string, response: string, model: string, pdf?: VisionToolResult['pdf']): VisionToolResult {
  const markdown = toMarkdownResponse(response);
  const warnings = pdf && !pdf.textExtracted
    ? ['No text was extracted from this PDF page; analysis is based on the rendered page image only.']
    : [];
  return {
    ok: true,
    status: 'completed',
    taskId,
    response: markdown,
    content: markdown,
    markdown,
    model,
    ...(pdf ? { pdf } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

async function executeVision(
  input: VisionRunInput,
  taskId: string,
  run: NonNullable<ReturnType<typeof RunRegistry.get>>,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<VisionToolResult> {
  const { imageFsPath, pageNum, isPdf } = resolveInputPath(input);
  const stat = await fs.stat(imageFsPath).catch(() => null);
  if (!stat?.isFile()) throw new VisionTaskError('VISION_FILE_NOT_FOUND', 'image_path does not point to a readable file.', 'input');
  if (!isPdf && stat.size > MAX_VISION_IMAGE_BYTES) {
    throw new VisionTaskError('IMAGE_TOO_LARGE', `Image size ${(stat.size / (1024 * 1024)).toFixed(1)} MB exceeds the 20 MB vision limit.`, 'input');
  }
  if (signal.aborted) throw new VisionTaskError('VISION_ABORTED', 'Vision task was aborted.', 'cancel');

  const userPrompt = input.prompt || 'Analyze this image and provide a concise technical markdown report.';
  const warnings: string[] = [];
  let effectiveImageUrl: string;
  let effectivePrompt = userPrompt;
  let extractedPdfText: string | undefined;
  let pdfInfo: VisionToolResult['pdf'];

  if (isPdf) {
    if (RunRegistry.get(taskKey(taskId)) === run) RunRegistry.progress(taskKey(taskId), `Rendering PDF page ${pageNum}`, 0, 2);
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const renderResult = await renderPdfPage(imageFsPath, pageNum, { timeoutMs: remainingMs, signal });
    if (!renderResult) {
      if (deadlineAt <= Date.now()) throw new VisionTaskError('VISION_TIMEOUT', `PDF rendering exceeded the ${VISION_TASK_TIMEOUT_MS}ms task deadline.`, 'pdf_render');
      throw new VisionTaskError('PDF_RENDER_FAILED', `Failed to render PDF page ${pageNum}.`, 'pdf_render');
    }
    if (signal.aborted) {
      if (deadlineAt <= Date.now()) throw new VisionTaskError('VISION_TIMEOUT', `PDF rendering exceeded the ${VISION_TASK_TIMEOUT_MS}ms task deadline.`, 'pdf_render');
      throw new VisionTaskError('VISION_ABORTED', 'Vision task was aborted.', 'cancel');
    }
    if (!renderResult.image_path) {
      throw new VisionTaskError('PDF_IMAGE_MISSING', `PDF page ${pageNum} rendered without an image; refusing to report visual analysis without page pixels.`, 'pdf_render');
    }
    const pngBuffer = await fs.readFile(renderResult.image_path).catch(() => null);
    if (!pngBuffer?.length) throw new VisionTaskError('PDF_IMAGE_UNREADABLE', `Rendered image for PDF page ${pageNum} is missing or empty.`, 'pdf_render');
    if (pngBuffer.byteLength > MAX_VISION_IMAGE_BYTES) {
      throw new VisionTaskError('IMAGE_TOO_LARGE', `Rendered PDF page is ${(pngBuffer.byteLength / (1024 * 1024)).toFixed(1)} MB, over the 20 MB vision limit.`, 'pdf_render');
    }
    effectiveImageUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
    extractedPdfText = renderResult.text.trim();
    const textExtracted = Boolean(extractedPdfText);
    pdfInfo = {
      page: pageNum,
      totalPages: renderResult.total_pages,
      textExtracted,
      visualPageRendered: true,
      ...(typeof renderResult.image_coverage_ratio === 'number' ? { imageCoverageRatio: renderResult.image_coverage_ratio } : {}),
    };
    if (textExtracted) {
      effectivePrompt = `${userPrompt}\n\n[Extracted Page Text (page ${pageNum}/${renderResult.total_pages})]:\n${extractedPdfText}`;
    } else {
      warnings.push('No text was extracted from this PDF page; analysis is based on the rendered page image only.');
    }
  } else {
    const extension = path.extname(imageFsPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
    };
    const mimeType = mimeTypes[extension];
    if (!mimeType) throw new VisionTaskError('UNSUPPORTED_IMAGE_TYPE', `Unsupported image extension: ${extension || '(none)'}.`, 'input');
    const imageBuffer = await fs.readFile(imageFsPath).catch(() => null);
    if (!imageBuffer?.length) throw new VisionTaskError('IMAGE_UNREADABLE', 'Image file is missing or empty.', 'input');
    if (imageBuffer.byteLength > MAX_VISION_IMAGE_BYTES) {
      throw new VisionTaskError('IMAGE_TOO_LARGE', `Image size ${(imageBuffer.byteLength / (1024 * 1024)).toFixed(1)} MB exceeds the 20 MB vision limit.`, 'input');
    }
    effectiveImageUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  }

  if (signal.aborted) {
    if (deadlineAt <= Date.now()) throw new VisionTaskError('VISION_TIMEOUT', `Vision task exceeded the ${VISION_TASK_TIMEOUT_MS}ms task deadline.`, 'provider');
    throw new VisionTaskError('VISION_ABORTED', 'Vision task was aborted.', 'cancel');
  }
  if (RunRegistry.get(taskKey(taskId)) === run) RunRegistry.progress(taskKey(taskId), isPdf ? `Analyzing PDF page ${pageNum}` : 'Analyzing image', 1, isPdf ? 2 : 1);

  const pipeline = new PipelineExecutor();
  pipeline.use(getStructuralMarkdownMiddleware());
  pipeline.use(getSharedResponseCache());
  pipeline.use(getWorkspaceContextMiddleware());
  pipeline.use(getSharedImageRouter());

  const context: PipelineContext = {
    request: {
      model: input.model || 'gemini-3.1-flash-lite',
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      abortSignal: signal,
      signal,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: effectivePrompt },
          { type: 'image_url', image_url: { url: effectiveImageUrl } },
        ],
      }],
    },
    taskType: TaskType.Vision,
    workspaceRoot: input.workspace_root,
    isOnePass: true,
    extractedPdfText,
    pdfMetadata: pdfInfo,
    visionDeadlineAt: deadlineAt,
  };

  const finalContext = await pipeline.execute(context);
  const response = finalContext.response;
  const content = response?.choices?.[0]?.message?.content;
  if ((response as any)?.isError || (response as any)?.error) {
    throw new VisionTaskError('VISION_PROVIDER_ERROR', String((response as any).error || 'Provider returned an error response.'), 'provider');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new VisionTaskError('VISION_EMPTY_RESPONSE', 'Vision provider completed without usable assistant content.', 'response_validation');
  }

  const result = completedResult(taskId, content, response?.model || input.model || 'unknown', pdfInfo);
  if (warnings.length) result.warnings = warnings;
  if (RunRegistry.get(taskKey(taskId)) === run) RunRegistry.progress(taskKey(taskId), 'Completed', isPdf ? 2 : 1, isPdf ? 2 : 1);
  return result;
}

function beginVisionTask(taskId: string, input: VisionRunInput): Promise<VisionToolResult> {
  const key = taskKey(taskId);
  const run = RunRegistry.start(key);
  taskInputs.set(key, input);
  taskResults.delete(key);
  const deadlineAt = Date.now() + VISION_TASK_TIMEOUT_MS;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), VISION_TASK_TIMEOUT_MS);
  deadlineTimer.unref?.();
  const signal = AbortSignal.any([run.controller.signal, deadlineController.signal]);
  run.totalCount = resolveInputPath(input).isPdf ? 2 : 1;
  RunRegistry.progress(key, 'Validating input', 0, run.totalCount);

  let taskTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let onRunAbort: (() => void) | undefined;
  const work = (async (): Promise<VisionToolResult> => {
    try {
      const execution = executeVision(input, taskId, run, deadlineAt, signal);
      const aborted = new Promise<never>((_, reject) => {
        onRunAbort = () => reject(new VisionTaskError('VISION_ABORTED', 'Vision task was aborted.', 'cancel'));
        if (run.controller.signal.aborted) onRunAbort();
        else run.controller.signal.addEventListener('abort', onRunAbort, { once: true });
      });
      const timedOut = new Promise<never>((_, reject) => {
        taskTimeoutTimer = setTimeout(() => reject(new VisionTaskError('VISION_TIMEOUT', `Vision task exceeded the ${VISION_TASK_TIMEOUT_MS}ms task deadline.`, 'timeout')), VISION_TASK_TIMEOUT_MS);
        taskTimeoutTimer.unref?.();
      });
      const result = await Promise.race([execution, aborted, timedOut]);
      if (RunRegistry.get(key) === run) taskResults.set(key, result);
      return result;
    } catch (error) {
      const result = run.controller.signal.aborted
        ? failedResult(taskId, new VisionTaskError('VISION_ABORTED', 'Vision task was aborted.', 'cancel'), 'aborted')
        : Date.now() >= deadlineAt
          ? failedResult(taskId, new VisionTaskError('VISION_TIMEOUT', `Vision task exceeded the ${VISION_TASK_TIMEOUT_MS}ms task deadline.`, 'timeout'))
          : failedResult(taskId, error);
      if (RunRegistry.get(key) === run) taskResults.set(key, result);
      return result;
    } finally {
      clearTimeout(deadlineTimer);
      if (taskTimeoutTimer) clearTimeout(taskTimeoutTimer);
      if (onRunAbort) run.controller.signal.removeEventListener('abort', onRunAbort);
      if (RunRegistry.get(key) === run) RunRegistry.finish(key, taskResults.get(key)?.error?.message);
    }
  })();
  return work;
}

function statusResult(taskId: string): VisionToolResult {
  const key = taskKey(taskId);
  const run = RunRegistry.get(key);
  if (!run) {
    return failedResult(taskId, new VisionTaskError('VISION_TASK_NOT_FOUND', `No vision task found for '${taskId}'.`, 'task_tracking'));
  }
  if (!run.done) return runningResult(taskId, run);
  return taskResults.get(key) || failedResult(taskId, run.error || 'Vision task finished without a result.');
}

export async function visionTool(input: VisionToolInput): Promise<VisionToolResult> {
  const action = input.action || 'run';
  const suppliedTaskId = input.taskId || input.sessionId;

  if (action === 'status') {
    if (!suppliedTaskId) throw new Error('vision_tool action "status" requires taskId or sessionId.');
    return statusResult(suppliedTaskId);
  }
  if (action === 'abort') {
    if (!suppliedTaskId) throw new Error('vision_tool action "abort" requires taskId or sessionId.');
    const key = taskKey(suppliedTaskId);
    const run = RunRegistry.get(key);
    if (!run || !RunRegistry.abort(key)) return statusResult(suppliedTaskId);
    const result = failedResult(suppliedTaskId, new VisionTaskError('VISION_ABORTED', 'Vision task was aborted by the caller.', 'cancel'), 'aborted');
    taskResults.set(key, result);
    return result;
  }
  if (action !== 'run' && action !== 'continue') throw new Error(`Unsupported vision_tool action: ${action}`);

  const taskId = suppliedTaskId || randomUUID();
  const key = taskKey(taskId);
  const existing = RunRegistry.get(key);
  if (existing && !existing.done) return runningResult(taskId, existing);
  if (action === 'run' && existing?.done) return statusResult(taskId);
  if (action === 'continue' && existing?.done && taskResults.get(key)?.status === 'completed') return statusResult(taskId);

  let runInput: VisionRunInput;
  if (action === 'continue') {
    const previous = taskInputs.get(key);
    if (!previous && !input.image_path) throw new Error('vision_tool action "continue" requires a known taskId or a new image_path.');
    runInput = {
      ...(previous || {}),
      ...(input.workspace_root !== undefined ? { workspace_root: input.workspace_root } : {}),
      ...(input.image_path ? { image_path: input.image_path } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    } as VisionRunInput;
  } else {
    runInput = {
      image_path: input.image_path!,
      ...(input.workspace_root !== undefined ? { workspace_root: input.workspace_root } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    };
  }

  // Validate URI and workspace containment before acknowledging a background task.
  resolveInputPath(runInput);
  const work = beginVisionTask(taskId, runInput);
  const waitMs = responseWaitMs();
  if (waitMs === 0) return runningResult(taskId, RunRegistry.get(key));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const responseTimeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); });
  const completed = await Promise.race([work, responseTimeout]);
  if (timer) clearTimeout(timer);
  return completed || runningResult(taskId, RunRegistry.get(key));
}
