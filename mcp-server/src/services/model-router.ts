import { getModelInfo, type LlmFitModelInfo } from './llmfit.js';

/**
 * Capability-aware choice among the models installed in the local Ollama server.
 *
 * Why: picking "the first coder-looking name" sends a screenshot task to a text-only model, and a
 * director/scripting task to whichever model contains "qwen" (including the vision-language one).
 * Ollama's /api/show reports real capabilities (completion, vision, embedding, tools, thinking), so
 * those are the ground truth; model names are only a fallback. Memory fit is judged against a VRAM
 * budget (default 6 GB, OLLAMA_VRAM_BUDGET_GB), using llmfit's memory estimate when it is installed
 * and the on-disk size otherwise.
 */

export type Need = 'code' | 'vision' | 'embedding' | 'general';

export interface ModelProfile {
  name: string;
  /** Raw capabilities from /api/show, or inferred from the name when /api/show was unavailable. */
  capabilities: string[];
  /** 'show' = ground truth from Ollama; 'name' = guessed from the model name. */
  capabilitySource: 'show' | 'name';
  family?: string;
  paramsB?: number;
  quantization?: string;
  sizeGb?: number;
  /** Estimated GPU memory needed: the installed file's size x 1.15 (llmfit's figure only when the size is unknown). */
  memoryGb?: number;
  memorySource?: 'llmfit' | 'size';
  contextLength?: number;
  fitLevel?: string;
  /** llmfit catalog entry this model was matched to (absent when llmfit is unavailable or has no match). */
  llmfitModel?: string;
}

export interface Ranked {
  name: string;
  score: number;
  fitsBudget: boolean;
  reason: string;
}

export const DEFAULT_VRAM_BUDGET_GB = 6;

export function vramBudgetGb(): number {
  const v = parseFloat(process.env.OLLAMA_VRAM_BUDGET_GB || '');
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_VRAM_BUDGET_GB;
}

const CODE_NAME_RE = /coder|codellama|devstral|starcoder|deepseek-coder|granite-code|codestral|codegemma|\bcode\b/i;
const VISION_NAME_RE = /vision|llava|\bvl\b|[-:.]vl[-:.]|qwen\d*(?:\.\d+)?vl|minicpm-v|moondream|bakllava|gemma3|pixtral|llama3\.2-vision/i;
const EMBED_NAME_RE = /embed|bge|e5-|gte-|minilm|arctic-embed|snowflake|mxbai|nomic/i;

function parseParamsB(text?: string): number | undefined {
  const m = (text || '').match(/([\d.]+)\s*([BMK])/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return unit === 'B' ? n : unit === 'M' ? n / 1000 : n / 1_000_000;
}

/** Builds a profile from Ollama /api/tags and (optional) /api/show payloads. */
export function buildProfile(
  name: string,
  tag?: { size?: number; details?: { family?: string; parameter_size?: string; quantization_level?: string } },
  show?: { capabilities?: string[]; details?: { family?: string; parameter_size?: string; quantization_level?: string }; model_info?: Record<string, any> },
): ModelProfile {
  const details = show?.details ?? tag?.details;
  let capabilities = show?.capabilities;
  let capabilitySource: ModelProfile['capabilitySource'] = 'show';
  if (!capabilities || capabilities.length === 0) {
    capabilitySource = 'name';
    capabilities = [];
    if (EMBED_NAME_RE.test(name)) capabilities.push('embedding');
    else capabilities.push('completion');
    if (VISION_NAME_RE.test(name)) capabilities.push('vision');
  }
  const sizeGb = tag?.size ? tag.size / 1e9 : undefined;
  const ctxEntry = show?.model_info ? Object.entries(show.model_info).find(([k]) => k.endsWith('.context_length')) : undefined;
  return {
    name,
    capabilities,
    capabilitySource,
    family: details?.family,
    paramsB: parseParamsB(details?.parameter_size),
    quantization: details?.quantization_level,
    sizeGb,
    memoryGb: sizeGb !== undefined ? +(sizeGb * 1.15).toFixed(2) : undefined,
    memorySource: sizeGb !== undefined ? 'size' : undefined,
    contextLength: typeof ctxEntry?.[1] === 'number' ? ctxEntry[1] : undefined,
  };
}

export const isEmbeddingModel = (p: ModelProfile) => p.capabilities.includes('embedding') && !p.capabilities.includes('completion');
export const isVisionModel = (p: ModelProfile) => p.capabilities.includes('vision');
export const isCodeNamed = (p: ModelProfile) => CODE_NAME_RE.test(p.name);

/**
 * Scores one model for a need. Higher is better; over-budget models get a large penalty so they
 * sort last (they stay in the list: whether a model can really run is only known by trying it).
 */
export function scoreModel(p: ModelProfile, need: Need, budgetGb = vramBudgetGb()): Ranked {
  const reasons: string[] = [];
  let score = 0;
  const chat = !isEmbeddingModel(p);

  if (need === 'embedding') {
    if (isEmbeddingModel(p)) { score += 100; reasons.push('embedding model'); }
    else { score -= 100; reasons.push('not an embedding model'); }
  } else if (!chat) {
    score -= 200; reasons.push('embedding-only: cannot chat');
  } else if (need === 'vision') {
    if (isVisionModel(p)) { score += 100; reasons.push('vision capability'); }
    else { score -= 100; reasons.push('no vision capability'); }
  } else if (need === 'code') {
    if (isCodeNamed(p)) { score += 100; reasons.push('code-specialised'); }
    if (p.capabilities.includes('insert')) { score += 10; reasons.push('fill-in-the-middle'); }
    if (p.capabilities.includes('tools')) { score += 5; reasons.push('tool calling'); }
    if (isVisionModel(p)) { score -= 30; reasons.push('vision model (weaker for plain code)'); }
  } else {
    // general: prefer a plain text model; vision models are fine but not preferred
    if (isVisionModel(p)) { score -= 15; reasons.push('vision model'); }
    if (isCodeNamed(p)) { score -= 10; reasons.push('code-specialised'); }
    if (p.capabilities.includes('thinking')) { score += 5; reasons.push('reasoning'); }
  }

  // Bigger is better within the budget (capped so a 70B guess never dwarfs capability fit).
  if (p.paramsB && need !== 'embedding') score += Math.min(p.paramsB, 14);

  const mem = p.memoryGb;
  const fitsBudget = mem === undefined || mem <= budgetGb;
  if (!fitsBudget) { score -= 1000; reasons.push(`~${mem!.toFixed(1)} GB exceeds the ${budgetGb} GB budget`); }
  else if (mem !== undefined) reasons.push(`~${mem.toFixed(1)} GB (${p.memorySource ?? 'estimate'})`);
  if (p.capabilitySource === 'name') reasons.push('capabilities guessed from the name');

  return { name: p.name, score, fitsBudget, reason: reasons.join('; ') };
}

/** Ranks profiles for a need, best first. */
export function rankProfiles(profiles: ModelProfile[], need: Need, budgetGb = vramBudgetGb()): Ranked[] {
  return profiles
    .map(p => scoreModel(p, need, budgetGb))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * Names-only entry point (callers that only hold `listLocalModels()` output). Uses cached profiles
 * when the router has seen the model, else infers capabilities from the name.
 */
export function rankNamesForNeed(names: string[], need: Need, known: Map<string, ModelProfile> = profileCache.byName): string[] {
  const profiles = names.map(n => known.get(n) ?? buildProfile(n));
  return rankProfiles(profiles, need).map(r => r.name);
}

// ── discovery ────────────────────────────────────────────────────────────────

export interface RouterDeps {
  fetchImpl?: (url: string, init?: any) => Promise<{ ok: boolean; json(): Promise<any> }>;
  baseUrl?: string;
  /** llmfit hook; defaults to services/llmfit getModelInfo. */
  llmfitInfo?: (name: string) => Promise<LlmFitModelInfo | null>;
  now?: () => number;
}

const profileCache: { byName: Map<string, ModelProfile>; at: number } = { byName: new Map(), at: 0 };
const CACHE_TTL_MS = 5 * 60_000;
export function resetModelRouterCache(): void { profileCache.byName.clear(); profileCache.at = 0; }

async function timed<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);
}

/**
 * Lists installed models with real capabilities (/api/show) and memory/context hints (llmfit).
 * Every enrichment is best effort; a failure leaves a usable, honestly-labelled profile.
 */
export async function listModelProfiles(deps: RouterDeps = {}): Promise<ModelProfile[]> {
  const now = deps.now ?? Date.now;
  if (profileCache.byName.size > 0 && now() - profileCache.at < CACHE_TTL_MS && !deps.fetchImpl) {
    return [...profileCache.byName.values()];
  }
  const base = (deps.baseUrl || process.env.OLLAMA_LOCAL_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  const doFetch = deps.fetchImpl ?? (async (url: string, init?: any) => {
    const { default: nodeFetch } = await import('node-fetch');
    return nodeFetch(url, init) as any;
  });

  const tagsRes = await doFetch(`${base}/api/tags`);
  if (!tagsRes.ok) throw new Error(`Ollama /api/tags failed`);
  const tags: Array<{ name: string; size?: number; details?: any }> = (await tagsRes.json()).models ?? [];

  const llmfit = deps.llmfitInfo ?? ((n: string) => getModelInfo(n, { memoryBudgetGb: vramBudgetGb(), fast: true }));
  const profiles = await Promise.all(tags.map(async t => {
    let show: any;
    try {
      const r = await doFetch(`${base}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: t.name }) });
      if (r.ok) show = await r.json();
    } catch { /* name heuristics */ }
    const p = buildProfile(t.name, t, show);
    try {
      const info = await timed(llmfit(t.name), 15000);
      if (info) {
        p.llmfitModel = info.name;
        // llmfit sizes the quantization IT recommends, not the one installed here, so the installed
        // file's size is the truth; llmfit's figure is only a fallback when the size is unknown.
        const llmfitMem = info.memoryRequiredGb ?? info.minVramGb;
        if (llmfitMem !== undefined && p.memoryGb === undefined) { p.memoryGb = llmfitMem; p.memorySource = 'llmfit'; }
        if (info.contextLength !== undefined && p.contextLength === undefined) p.contextLength = info.contextLength;
        p.fitLevel = info.fitLevel;
      }
    } catch { /* llmfit not installed */ }
    return p;
  }));

  if (!deps.fetchImpl) {
    profileCache.byName = new Map(profiles.map(p => [p.name, p]));
    profileCache.at = now();
  }
  return profiles;
}

export interface TaskPlan {
  /** Ordered stages; each names the model to use, or why none exists. */
  stages: Array<{ stage: 'describe-images' | 'implement' | 'answer' | 'embed'; need: Need; model: string | null; reason: string }>;
  /** Needs that no installed model satisfies within the budget. */
  missing: Need[];
}

export interface TaskSpec {
  /** The task includes images (screenshots, mockups). */
  hasImages?: boolean;
  /** The end result is code. */
  kind?: 'code' | 'general' | 'embedding';
}

/**
 * Plans which installed model handles each stage. A screenshot-to-code task becomes two stages: a
 * vision model turns the image into a precise textual description, then a code model implements it.
 * A model that is vision AND code-named is used for both stages. Models over the VRAM budget are
 * never chosen; if nothing fits a stage, that need is reported in `missing` rather than guessed.
 */
export function planTask(profiles: ModelProfile[], spec: TaskSpec, budgetGb = vramBudgetGb()): TaskPlan {
  const pick = (need: Need) => {
    const best = rankProfiles(profiles, need, budgetGb)[0];
    const prof = best ? profiles.find(p => p.name === best.name) : undefined;
    const qualifies = !!best && best.fitsBudget && prof !== undefined && (
      need === 'vision' ? isVisionModel(prof)
      : need === 'embedding' ? isEmbeddingModel(prof)
      : !isEmbeddingModel(prof)
    );
    return qualifies ? best : null;
  };
  const stages: TaskPlan['stages'] = [];
  const missing: Need[] = [];
  const kind = spec.kind ?? 'general';

  if (kind === 'embedding') {
    const m = pick('embedding');
    stages.push({ stage: 'embed', need: 'embedding', model: m?.name ?? null, reason: m?.reason ?? 'no embedding model installed' });
    if (!m) missing.push('embedding');
    return { stages, missing };
  }
  if (spec.hasImages) {
    const v = pick('vision');
    stages.push({ stage: 'describe-images', need: 'vision', model: v?.name ?? null, reason: v?.reason ?? 'no vision-capable model fits the budget' });
    if (!v) missing.push('vision');
  }
  const need: Need = kind === 'code' ? 'code' : 'general';
  const m = pick(need);
  stages.push({ stage: kind === 'code' ? 'implement' : 'answer', need, model: m?.name ?? null, reason: m?.reason ?? `no ${need} model fits the budget` });
  if (!m) missing.push(need);
  return { stages, missing };
}

/** Convenience: discover installed models, then plan. */
export async function routeTask(spec: TaskSpec, deps: RouterDeps = {}): Promise<TaskPlan & { models: ModelProfile[] }> {
  const models = await listModelProfiles(deps);
  return { ...planTask(models, spec), models };
}
