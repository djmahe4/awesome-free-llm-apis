import { CyberToolsRegistry } from '../utils/CyberToolsRegistry.js';
import { buildToolProfile, type ToolProfile } from '../utils/groundingEvidence.js';
import { DockerHubClient } from '../utils/DockerHubClient.js';
import { AptPackageClient } from '../utils/AptPackageClient.js';
import { GithubRepoClient } from '../utils/GithubRepoClient.js';
import { PackageRegistryClient } from '../utils/PackageRegistryClient.js';
import { detectIntent, detectSource, matchTools, splitMatches, type Intent, type SourceName } from '../utils/ToolResolver.js';
import type { GroundingHint, Lookup } from '../utils/grounding.js';

/**
 * resolve_tool — answers "tell me about <tool>" from the registry plus live GitHub / Docker Hub /
 * apt / package-registry evidence, one conversational step at a time.
 *
 * Rules: (1) a tool is only "the answer" when evidence ties it to the registered tool;
 * (2) anything we could not verify is said so (`could_not_verify`), never reported as absent;
 * (3) the chosen tool and source carry forward across calls in the same sessionId.
 */

export interface ResolveToolInput {
  prompt?: string;
  toolName?: string;
  source?: SourceName;
  /** Reply to a pending question: a tool name, a source name, or an option label. */
  choice?: string;
  sessionId?: string;
}

export interface ResolveDeps {
  github: Pick<GithubRepoClient, 'understand'>;
  docker: Pick<DockerHubClient, 'resolve'>;
  apt: Pick<AptPackageClient, 'resolve'>;
  packages: Pick<PackageRegistryClient, 'enrich'>;
  loadRegistry: () => Promise<Record<string, { url: string; urlType?: string }>>;
}

interface SessionState {
  tool?: string;
  source?: SourceName;
  pending?: { kind: 'tool' | 'source' | 'unverified'; options: string[]; intent: Intent; hints?: GroundingHint[]; source?: SourceName };
  confirmed: Partial<Record<SourceName, GroundingHint>>;
  touched: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const sessions = new Map<string, SessionState>();

export function resetResolveSessions(): void { sessions.clear(); }

function getSession(id: string): SessionState {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.touched > SESSION_TTL_MS) sessions.delete(k);
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  let s = sessions.get(id);
  if (!s) { s = { confirmed: {}, touched: now }; sessions.set(id, s); }
  s.touched = now;
  return s;
}

const defaultDeps = (): ResolveDeps => ({
  github: new GithubRepoClient(), docker: new DockerHubClient(), apt: new AptPackageClient(),
  packages: new PackageRegistryClient(), loadRegistry: () => CyberToolsRegistry.loadRegistry(),
});

/** Intents that only GitHub can answer. */
const GITHUB_ONLY: Intent[] = ['dependencies', 'skills', 'tools'];

type SourceOutcome =
  | { source: SourceName; status: 'grounded'; summary: Record<string, unknown>; url?: string }
  | { source: SourceName; status: 'unverified'; hints: GroundingHint[]; detail: string }
  | { source: SourceName; status: 'not_found'; detail: string }
  | { source: SourceName; status: 'could_not_verify'; reason: string; detail: string }
  | { source: SourceName; status: 'not_registered'; detail: string };

function fail(source: SourceName, r: Extract<Lookup<unknown>, { found: false }>): SourceOutcome {
  if (r.reason === 'not_found') return { source, status: 'not_found', detail: r.detail };
  if (r.reason === 'unverified') return { source, status: 'unverified', hints: r.hints ?? [], detail: r.detail };
  return { source, status: 'could_not_verify', reason: r.reason, detail: r.detail };
}

async function groundGithub(profile: ToolProfile, intent: Intent, d: ResolveDeps): Promise<SourceOutcome> {
  if (!profile.github) return { source: 'github', status: 'not_registered', detail: 'The registry entry for this tool is not a GitHub URL.' };
  const r = await d.github.understand(profile.github.owner, profile.github.repo);
  if (!r.found) return fail('github', r);
  const u = r.data;
  const summary: Record<string, unknown> = {
    repo: u.meta.fullName, description: u.meta.description, language: u.meta.language, stars: u.meta.stars,
    license: u.meta.license, archived: u.meta.archived, defaultBranch: u.meta.defaultBranch, topics: u.meta.topics,
    notes: u.notes,
  };
  if (intent === 'overview') {
    Object.assign(summary, { readmeExcerpt: u.readmeExcerpt, manifests: u.manifests.map(m => m.file),
      skillCount: u.skills.total, mcpFiles: [...u.mcp.configFiles, ...u.mcp.serverFiles], dependencyCount: u.dependencies.length });
  }
  if (intent === 'dependencies') {
    const direct = u.dependencies.filter(x => !x.dev);
    const enriched = await d.packages.enrich(direct);
    Object.assign(summary, { manifests: u.manifests.map(m => ({ file: m.file, ecosystem: m.ecosystem, packageName: m.packageName })),
      dependencies: direct.map(x => ({ name: x.name, ecosystem: x.ecosystem, spec: x.spec, from: x.source })),
      dependencyDescriptions: enriched.described, unresolvedDependencies: enriched.unresolved, undescribed: enriched.skipped });
  }
  if (intent === 'skills') Object.assign(summary, { skills: u.skills });
  if (intent === 'tools') Object.assign(summary, { mcp: u.mcp, skillCount: u.skills.total });
  if (intent === 'usage' || intent === 'install') Object.assign(summary, { usage: u.usage });
  return { source: 'github', status: 'grounded', summary, url: u.meta.htmlUrl };
}

async function groundDocker(profile: ToolProfile, d: ResolveDeps): Promise<SourceOutcome> {
  const r = await d.docker.resolve(profile);
  if (!r.found) return fail('docker', r);
  const b = r.data.best;
  return { source: 'docker', status: 'grounded', url: b.url, summary: {
    image: b.fullName, pullCommand: b.pullCommand, description: b.description, pulls: b.pulls, stars: b.stars,
    official: b.isOfficial, lastUpdated: b.lastUpdated, evidence: r.data.evidence,
    alternatives: r.data.alternatives.map(a => a.repo.fullName) } };
}

async function groundApt(profile: ToolProfile, d: ResolveDeps): Promise<SourceOutcome> {
  const r = await d.apt.resolve(profile);
  if (!r.found) return fail('apt', r);
  const b = r.data.best;
  return { source: 'apt', status: 'grounded', url: b.url, summary: {
    distro: b.distro, installCommand: b.installCommand, version: b.version, description: b.description,
    homepage: b.homepage, binaries: b.binaries, evidence: b.evidence,
    availableIn: r.data.hits.map(h => h.distro) } };
}

const ground = (src: SourceName, p: ToolProfile, intent: Intent, d: ResolveDeps) =>
  src === 'github' ? groundGithub(p, intent, d) : src === 'docker' ? groundDocker(p, d) : groundApt(p, d);

export async function resolveTool(input: ResolveToolInput, deps: ResolveDeps = defaultDeps()): Promise<Record<string, unknown>> {
  const state = getSession(input.sessionId || 'resolve_tool_session');
  const registryRaw = await deps.loadRegistry();
  const registry: Record<string, { url: string }> = {};
  for (const [name, e] of Object.entries(registryRaw)) if (!CyberToolsRegistry.isTestDebris(name, e.url)) registry[name] = e;
  const names = Object.keys(registry);
  const byLower = new Map(names.map(n => [n.toLowerCase(), n]));
  const prompt = input.prompt ?? '';
  const choice = input.choice?.trim();
  const pending = state.pending;
  let intent: Intent = pending?.intent ?? 'overview';
  if (prompt) intent = detectIntent(prompt) === 'overview' && pending ? pending.intent : detectIntent(prompt);

  // ---- 1. which tool -------------------------------------------------------------------
  let tool: string | undefined = input.toolName ? byLower.get(input.toolName.toLowerCase()) : undefined;
  if (input.toolName && !tool) {
    return { success: false, status: 'not_found', toolName: input.toolName,
      message: `"${input.toolName}" is not in the tool registry. Nothing was looked up.`, registryToolCount: names.length };
  }
  if (!tool && pending?.kind === 'tool' && choice) tool = byLower.get(choice.toLowerCase());
  if (!tool && prompt) {
    const { confident, suggestions } = splitMatches(matchTools(prompt, registry));
    if (confident.length === 1) tool = confident[0].name;
    else if (confident.length > 1) {
      state.pending = { kind: 'tool', options: confident.map(m => m.name), intent };
      return { success: true, status: 'question', question: 'Which tool do you mean?', options: state.pending.options };
    } else if (suggestions.length && !(pending?.kind === 'tool' && choice)) {
      if (!state.tool) {
        state.pending = { kind: 'tool', options: suggestions.map(m => m.name), intent };
        return { success: true, status: 'question', question: `No exact match. Did you mean ${suggestions.map(m => m.name).join(' or ')}?`, options: state.pending.options };
      }
    }
  }
  if (!tool) tool = state.tool;
  if (!tool) {
    return { success: false, status: 'not_found',
      message: 'No tool in the registry matches that. Nothing was looked up, and no tool was guessed.',
      registryToolCount: names.length, sampleTools: names.slice(0, 12) };
  }
  state.tool = tool;

  const profile = buildToolProfile(tool, registry[tool].url);

  // ---- 2. which source (carried forward) ------------------------------------------------
  const asSource = (s?: string): SourceName | undefined => (s === 'github' || s === 'apt' || s === 'docker' ? s : undefined);
  let source = input.source
    ?? (pending?.kind === 'source' ? asSource(choice?.toLowerCase()) : undefined)
    ?? (prompt ? detectSource(prompt) : undefined)
    ?? state.source;
  if (source) state.source = source;
  if (!source && GITHUB_ONLY.includes(intent)) source = 'github';

  // ---- 3. user picked one of the "unverified" hints --------------------------------------
  if (pending?.kind === 'unverified' && choice && pending.hints) {
    const hint = pending.hints.find(h => h.label.toLowerCase() === choice.toLowerCase());
    if (hint && pending.source) {
      state.confirmed[pending.source] = hint;
      state.pending = undefined;
      return { success: true, status: 'answer', tool, source: pending.source, verified: 'user-confirmed',
        message: `Using ${hint.label} on your confirmation. This was not independently tied to the registered tool.`,
        confirmed: hint };
    }
  }
  state.pending = undefined;

  const done = (o: SourceOutcome) => { const { status: _s, source: _src, ...rest } = o; return { tool, source: o.source, intent, ...rest }; };

  if (source) {
    const confirmed = state.confirmed[source];
    if (confirmed) return { success: true, status: 'answer', tool, source, verified: 'user-confirmed', confirmed };
    const o = await ground(source, profile, intent, deps);
    if (o.status === 'grounded') return { ...done(o), success: true, status: 'answer' };
    if (o.status === 'unverified' && o.hints.length) {
      state.pending = { kind: 'unverified', options: o.hints.map(h => h.label), intent, hints: o.hints, source };
      return { success: true, status: 'question', tool, source,
        question: `${source} has same-named candidates, but none could be tied to ${tool}. Which one, if any, is it?`,
        options: state.pending.options, hints: o.hints, detail: o.detail };
    }
    return { ...done(o), success: false, status: o.status === 'could_not_verify' ? 'could_not_verify' : 'not_found',
      message: o.status === 'could_not_verify'
        ? `Could not verify ${tool} on ${source} (${o.reason}). That is not the same as it not existing.`
        : `${tool} was not found on ${source}: ${o.detail}` };
  }

  // ---- 4. no source yet: check all, then ask only if there is a real choice -------------
  const outcomes = await Promise.all((['github', 'docker', 'apt'] as SourceName[]).map(s => ground(s, profile, intent, deps)));
  const grounded = outcomes.filter(o => o.status === 'grounded');
  if (grounded.length === 1) {
    state.source = grounded[0].source;
    return { ...done(grounded[0]), success: true, status: 'answer', note: 'Only source with verified evidence.' };
  }
  if (grounded.length > 1) {
    state.pending = { kind: 'source', options: grounded.map(o => o.source), intent };
    return { success: true, status: 'question', tool, question: `${tool} is verified on ${grounded.map(o => o.source).join(', ')}. Which one?`,
      options: state.pending.options, availability: outcomes.map(o => ({ source: o.source, status: o.status })) };
  }
  const hinted = outcomes.find((o): o is Extract<SourceOutcome, { status: 'unverified' }> => o.status === 'unverified' && o.hints.length > 0);
  if (hinted) {
    state.pending = { kind: 'unverified', options: hinted.hints.map(h => h.label), intent, hints: hinted.hints, source: hinted.source };
    return { success: true, status: 'question', tool, source: hinted.source,
      question: `${hinted.source} has same-named candidates for ${tool}, none verified. Which one, if any, is it?`,
      options: state.pending.options, hints: hinted.hints };
  }
  const couldNot = outcomes.filter(o => o.status === 'could_not_verify');
  return { success: false, status: couldNot.length ? 'could_not_verify' : 'not_found', tool,
    message: couldNot.length
      ? `No source gave a verified answer for ${tool}, and ${couldNot.map(o => o.source).join(', ')} could not be checked, so this is not a confirmed absence.`
      : `${tool} was not found on GitHub, Docker Hub or apt.`,
    availability: outcomes.map(o => ({ source: o.source, status: o.status, detail: 'detail' in o ? o.detail : undefined })) };
}
