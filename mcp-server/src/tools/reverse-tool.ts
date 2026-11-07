import { ReaProxy, type BlockedToolInfo } from '../reverse/proxy.js';
import { analyzeJsFile } from '../reverse/js-analyzer.js';
import { analyzeArtifactFile } from '../reverse/artifact-analyzer.js';
import { getStoredEvidence, storeEvidence, createEvidenceBundle, type ReverseEvidence } from '../reverse/evidence.js';
import { listReleaseAssets, type GitHubReleaseAsset } from '../reverse/github-releases.js';
import { RemoteRepoSource, type RemoteFileDescriptor } from '../reverse/remote-repo-source.js';
import { parseGitHubRepoUrl, discoverSkillsInTree, parseReadmeSkills, type DiscoveredSkill } from '../reverse/github-skills.js';
import { extractSymbolsAndFlow } from '../reverse/grep-ast.js';
import { RepoSymbolDb, type RepoKnowledgeRecord, type RepoSymbolItem } from '../reverse/repo-symbol-db.js';
import { AuditTaintBridge } from '../memory/audit-taint-bridge.js';
import { RunRegistry } from '../pipeline/middlewares/RunRegistry.js';
import { BoundedMap } from '../utils/bounded-map.js';
import type { FetchLike } from '../utils/http.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const reverseToolResultsCache = new BoundedMap<string, ReverseToolResult>(100);

function resolveModelInspectorPath(): string {
  const candidates = [
    path.resolve(__dirname, '../scripts/model_inspector.py'),
    path.resolve(__dirname, '../../scripts/model_inspector.py'),
    path.resolve(__dirname, '../../../scripts/model_inspector.py'),
    path.resolve(process.cwd(), 'scripts/model_inspector.py'),
    path.resolve(process.cwd(), 'mcp-server/scripts/model_inspector.py'),
    path.resolve(process.cwd(), 'dist/scripts/model_inspector.py'),
    path.resolve(process.cwd(), 'mcp-server/dist/scripts/model_inspector.py'),
  ];
  const found = candidates.find(c => fs.existsSync(c));
  if (!found) {
    throw new Error('Model inspector script (model_inspector.py) not found in candidates: ' + candidates.join(', '));
  }
  return found;
}

export function resolvePythonPath(): string {
  if (process.env.PYTHON) {
    return process.env.PYTHON;
  }
  const isWin = process.platform === 'win32';
  const pyRel = isWin ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  const candidates = [
    path.resolve(process.cwd(), 'venv', pyRel),
    path.resolve(process.cwd(), '.venv', pyRel),
    path.resolve(process.cwd(), 'mcp-server/venv', pyRel),
    path.resolve(process.cwd(), 'mcp-server/.venv', pyRel),
    path.resolve(__dirname, '../venv', pyRel),
    path.resolve(__dirname, '../.venv', pyRel),
    path.resolve(__dirname, '../../venv', pyRel),
    path.resolve(__dirname, '../../.venv', pyRel),
    path.resolve(__dirname, '../../../venv', pyRel),
    path.resolve(__dirname, '../../../.venv', pyRel),
  ];
  const found = candidates.find(c => fs.existsSync(c));
  return found || 'python';
}

function isSafeAllowedPath(rawPath: string, allowedDirs: string[]): boolean {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return false;
  if (rawPath.includes('\0')) return false;
  const parts = rawPath.split(/[\\/]/);
  if (parts.includes('..')) return false;
  const resolved = path.resolve(rawPath);
  return allowedDirs.some(dir => {
    const resolvedDir = path.resolve(dir);
    const rel = path.relative(resolvedDir, resolved);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

export type ReverseAuthorization = 'ctf' | 'lab' | 'consent';
const VALID_AUTH: ReverseAuthorization[] = ['ctf', 'lab', 'consent'];

export type ReverseToolAction =
  | 'status'
  | 'abort'
  | 'list_capabilities'
  | 'analyze_javascript'
  | 'analyze_artifact'
  | 'get_evidence'
  | 'scan_github'
  | 'inspect_model'
  | 'infer_layer_roles'
  | 'trace_layer_execution'
  | 'reconstruct_training_samples'
  | 'extract_model_layer'
  | 'analyze_model_layer';

export interface ReverseToolInput {
  action: ReverseToolAction;
  target?: string;
  authorization?: ReverseAuthorization;
  sessionId?: string;
  options?: Record<string, unknown>;
}

export interface ReverseScanGithubData {
  owner: string;
  repo: string;
  commitSha: string;
  releaseAssets: GitHubReleaseAsset[];
  skills: DiscoveredSkill[];
  symbols: RepoSymbolItem[];
  callFlows: string[];
  wikiMarkdown: string;
  descriptors: RemoteFileDescriptor[];
  readmeExcerpt?: string;
}

export interface ReverseToolResult {
  success: boolean;
  action: string;
  target?: string;
  data?: unknown;
  evidence?: ReverseEvidence;
  error?: string;
}

/** Checks whether the running Node.js version is >= 22.19 and not 23 or 25 */
export function checkNodeCompatibility(versionStr = process.versions.node): { supported: boolean; version: string; reason?: string } {
  const cleaned = versionStr.replace(/^v/, '');
  const [major, minor] = cleaned.split('.').map(Number);
  if (major === 23 || major === 25) {
    return {
      supported: false,
      version: versionStr,
      reason: `Node.js ${major} is an experimental/odd release line; REA requires Node >= 22.19 (LTS) and rejects 23/25.`,
    };
  }
  if (major < 22 || (major === 22 && minor < 19)) {
    return {
      supported: false,
      version: versionStr,
      reason: `Node.js version is ${versionStr}; REA requires Node >= 22.19.`,
    };
  }
  return { supported: true, version: versionStr };
}

export async function reverseTool(input: ReverseToolInput): Promise<ReverseToolResult> {
  if (!input || typeof input !== 'object') {
    return { success: false, action: 'unknown', error: 'Input must be an object' };
  }
  let { action, target, authorization, options } = input;
  if ((action as string) === 'inspect_gguf') {
    action = 'inspect_model';
  } else if ((action as string) === 'probe_memorization') {
    action = 'reconstruct_training_samples';
  }

  const effectiveSessionId = input.sessionId || (options?.sessionId as string) || (target ? `rev-${target.replace(/[^\w.-]/g, '_')}` : undefined);
  const runKey = effectiveSessionId ? `reverse_tool:${effectiveSessionId}` : undefined;

  if (action === 'abort') {
    if (!runKey) {
      return { success: false, action: 'abort', error: 'sessionId or target is required to abort.' };
    }
    const aborted = RunRegistry.abort(runKey);
    return {
      success: true,
      action: 'abort',
      target,
      data: {
        sessionId: effectiveSessionId,
        aborted,
        message: aborted ? 'Run aborted successfully.' : `No active run found for sessionId '${effectiveSessionId}' to abort.`,
      },
    };
  }

  if (action === 'scan_github') {
    if (!authorization || !VALID_AUTH.includes(authorization as ReverseAuthorization)) {
      return {
        success: false,
        action: 'scan_github',
        target,
        error: 'Target analysis requires authorization framing: "ctf" | "lab" | "consent".',
      };
    }

    if (!target || !target.trim()) {
      return {
        success: false,
        action: 'scan_github',
        error: 'Target is required.',
      };
    }

    const parsedRepo = parseGitHubRepoUrl(target);
    if (!parsedRepo) {
      return {
        success: false,
        action: 'scan_github',
        target,
        error: `Invalid GitHub repository target: "${target}". Expected "owner/repo" or "https://github.com/owner/repo".`,
      };
    }

    const { owner, repo } = parsedRepo;
    const fetchImpl = options?.fetchImpl as FetchLike | undefined;
    const token = (options?.token as string | undefined) || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const storageDir = options?.storageDir as string | undefined;
    const ref = (typeof options?.ref === 'string' && options.ref.trim())
      || (typeof options?.branch === 'string' && options.branch.trim())
      || 'main';

    try {
      const limitations: string[] = [];
      const releasesRes = await listReleaseAssets(owner, repo, { fetchImpl, token, limit: 10 });
      if (!releasesRes.success || releasesRes.error) {
        limitations.push(releasesRes.error || `Failed to fetch releases for ${owner}/${repo}`);
      }
      const releaseAssets = releasesRes.assets || [];

      const source = new RemoteRepoSource({ fetchImpl, token });
      const treeRes = await source.indexTree(owner, repo, ref);
      if (!treeRes.success) {
        return {
          success: false,
          action: 'scan_github',
          target,
          error: treeRes.error || `Failed to index tree for ${owner}/${repo}`,
        };
      }

      const skillPaths = discoverSkillsInTree(treeRes.descriptors);
      const readmeSkills = treeRes.readmeExcerpt ? parseReadmeSkills(treeRes.readmeExcerpt) : [];
      const skills: DiscoveredSkill[] = [];
      const addedSkillNames = new Set<string>();

      for (const sPath of skillPaths) {
        let name = path.posix.basename(path.posix.dirname(sPath));
        if (name === '.' || !name || name === 'skills') {
          name = repo;
        }
        const matched = readmeSkills.find(r => r.name.toLowerCase() === name.toLowerCase());
        skills.push({
          name,
          description: matched ? matched.description : 'Skill definition',
          path: sPath,
        });
        addedSkillNames.add(name.toLowerCase());
      }

      for (const rSkill of readmeSkills) {
        if (!addedSkillNames.has(rSkill.name.toLowerCase())) {
          skills.push(rSkill);
          addedSkillNames.add(rSkill.name.toLowerCase());
        }
      }

      const shortlisted = treeRes.descriptors.filter(d => d.isSource).slice(0, 5);
      const symbols: RepoSymbolItem[] = [];
      const callFlows: string[] = [];
      const manifests: string[] = [];
      const dependencies: Array<{ name: string; spec?: string }> = [];

      for (const d of treeRes.descriptors) {
        if (d.tags.includes('manifest')) {
          manifests.push(d.path);
        }
      }

      for (const fileDesc of shortlisted) {
        const rawFile = await source.fetchRawFile(owner, repo, treeRes.commitSha, fileDesc.path);
        if (rawFile.ok) {
          const analysis = extractSymbolsAndFlow(fileDesc.path, rawFile.text);
          for (const sym of analysis.symbols) {
            symbols.push({
              name: sym.name,
              kind: sym.kind,
              line: sym.line,
              filePath: fileDesc.path,
            });
          }
          for (const flow of analysis.callFlows) {
            if (!callFlows.includes(flow)) {
              callFlows.push(flow);
            }
          }
          if (analysis.dependencies) {
            for (const dep of analysis.dependencies) {
              if (!dependencies.some(d => d.name === dep)) {
                dependencies.push({ name: dep });
              }
            }
          }
        }
      }

      const record: RepoKnowledgeRecord = {
        owner,
        repo,
        commitSha: treeRes.commitSha,
        indexedAt: new Date().toISOString(),
        readmeClaims: treeRes.readmeExcerpt ? treeRes.readmeExcerpt.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [],
        symbols,
        callFlows,
        manifests,
        dependencies,
        releaseAssets,
      };

      const symbolDb = new RepoSymbolDb(storageDir);
      symbolDb.saveRecord(record);
      const wikiMarkdown = symbolDb.generateWikiMarkdown(record);

      const normalizedResult: Record<string, any> = {
        owner,
        repo,
        commitSha: treeRes.commitSha,
        releaseAssets,
        skills,
        symbols,
        callFlows,
        wikiMarkdown,
      };

      if (releaseAssets.some(a => a.category === 'binary_native' || a.category === 'asar') || manifests.length > 3) {
        normalizedResult.shallowCloneConsent = new AuditTaintBridge().createShallowClonePrompt(
          'https://github.com/' + owner + '/' + repo,
          'Deep AST and binary reverse engineering'
        );
      }

      const evidence = createEvidenceBundle({
        tool: 'reverse_tool',
        source: 'github_scan',
        target,
        limitations: limitations.length > 0 ? limitations : undefined,
        normalizedResult,
        analysisProfile: {
          targetType: 'network',
          action: 'scan_github',
          owner,
          repo,
          commitSha: treeRes.commitSha,
          target,
        },
        coverage: {
          scope: 'package',
          status: 'complete',
        },
        observations: [
          { releaseAssetsCount: releaseAssets.length },
          { skillsCount: skills.length },
          { symbolsCount: symbols.length },
        ],
        derivations: [
          { commitSha: treeRes.commitSha },
        ],
      });

      storeEvidence(evidence, storageDir);

      return {
        success: true,
        action: 'scan_github',
        target,
        evidence,
        data: {
          owner,
          repo,
          commitSha: treeRes.commitSha,
          releaseAssets,
          skills,
          symbols,
          callFlows,
          wikiMarkdown,
          descriptors: treeRes.descriptors,
          readmeExcerpt: treeRes.readmeExcerpt,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        action: 'scan_github',
        target,
        error: `GitHub scan failed: ${message}`,
      };
    }
  }

  if (action === 'status') {
    if (runKey && (RunRegistry.get(runKey) || reverseToolResultsCache.has(runKey))) {
      const run = RunRegistry.get(runKey);
      if (run && !run.done) {
        return {
          success: true,
          action: 'status',
          target,
          data: {
            status: 'running',
            sessionId: effectiveSessionId,
            startedAt: run.startedAt,
            elapsedMs: Date.now() - run.startedAt,
            message: `Analysis in progress (${run.lastSubtask || 'running'})`,
          },
        };
      }
      if (run?.controller?.signal?.aborted) {
        return {
          success: false,
          action: 'status',
          target,
          error: run.error || 'Operation aborted',
          data: {
            status: 'aborted',
            sessionId: effectiveSessionId,
          },
        };
      }
      const cached = reverseToolResultsCache.get(runKey);
      if (cached) {
        return cached;
      }
      return {
        success: !run?.error,
        action: 'status',
        target,
        error: run?.error,
        data: {
          status: run?.error ? 'failed' : 'done',
          sessionId: effectiveSessionId,
        },
      };
    }

    const nodeCheck = checkNodeCompatibility();
    const reaPath = process.env.REA_AGENTS_PATH || null;
    return {
      success: true,
      action: 'status',
      data: {
        nodeVersion: nodeCheck.version,
        supportedNode: nodeCheck.supported,
        nodeRequirement: '>= 22.19 (excluding 23 and 25)',
        engineStatus: reaPath ? 'configured' : 'standby',
        reaAgentsPath: reaPath,
        reason: nodeCheck.reason,
        builtInCapabilities: [
          'status',
          'abort',
          'analyze_javascript',
          'analyze_artifact',
          'get_evidence',
          'scan_github',
          'inspect_model',
          'inspect_gguf',
          'infer_layer_roles',
          'trace_layer_execution',
          'reconstruct_training_samples',
          'probe_memorization',
          'extract_model_layer',
          'analyze_model_layer',
        ],
      },
    };
  }

  if (action === 'list_capabilities') {
    if ((target && !authorization) || (authorization && !VALID_AUTH.includes(authorization as ReverseAuthorization))) {
      return {
        success: false,
        action: 'list_capabilities',
        target,
        error: 'Target analysis requires authorization framing: "ctf" | "lab" | "consent".',
      };
    }

    const reaPath = process.env.REA_AGENTS_PATH;
    let engineCallable: string[] = [];
    let engineBlocked: BlockedToolInfo[] = [];

    if (reaPath) {
      const proxy = new ReaProxy({
        command: reaPath,
        requestTimeoutMs: 5000,
      });
      try {
        const info = await proxy.start();
        engineCallable = info.callable;
        engineBlocked = info.blocked;
      } catch (err: any) {
        engineBlocked.push({ name: 'rea-engine', reason: err.message || 'Failed to initialize engine' });
      } finally {
        await proxy.close();
      }
    }

    const staticCapabilities = [
      'status',
      'abort',
      'analyze_javascript',
      'analyze_artifact',
      'get_evidence',
      'scan_github',
      'inspect_model',
      'inspect_gguf',
      'infer_layer_roles',
      'trace_layer_execution',
      'reconstruct_training_samples',
      'probe_memorization',
      'extract_model_layer',
      'analyze_model_layer',
    ];

    return {
      success: true,
      action: 'list_capabilities',
      target,
      data: {
        capabilities: [...staticCapabilities, ...engineCallable],
        staticProviders: ['javascript_ast', 'github_manifest', 'gguf_metadata'],
        nativeProviders: {
          ghidra: 'not_available',
          hopper: 'not_available',
          ida: 'not_available',
        },
        engineCallable,
        engineBlocked,
      },
    };
  }

  if (action === 'analyze_javascript' || action === 'analyze_artifact' || action === 'get_evidence') {
    if (!authorization || !VALID_AUTH.includes(authorization as ReverseAuthorization)) {
      return {
        success: false,
        action,
        target,
        error: 'Target analysis requires authorization framing: "ctf" | "lab" | "consent".',
      };
    }

    if (!target || !target.trim()) {
      return {
        success: false,
        action,
        error: 'Target is required.',
      };
    }

    if (action === 'analyze_javascript') {
      try {
        const evidence = await analyzeJsFile(target, {
          workspaceRoot: options?.workspaceRoot as string | undefined,
          reaAgentsPath: (options?.reaAgentsPath as string | undefined) || process.env.REA_AGENTS_PATH,
          ...options,
        });
        storeEvidence(evidence);
        return {
          success: true,
          action: 'analyze_javascript',
          target,
          evidence,
          data: evidence.normalized_result,
        };
      } catch (err: any) {
        return {
          success: false,
          action: 'analyze_javascript',
          target,
          error: err.message || String(err),
        };
      }
    }

    if (action === 'analyze_artifact') {
      try {
        const evidence = await analyzeArtifactFile(target, {
          workspaceRoot: options?.workspaceRoot as string | undefined,
          reaAgentsPath: (options?.reaAgentsPath as string | undefined) || process.env.REA_AGENTS_PATH,
          ...options,
        });
        storeEvidence(evidence);
        return {
          success: true,
          action: 'analyze_artifact',
          target,
          evidence,
          data: evidence.normalized_result,
        };
      } catch (err: any) {
        return {
          success: false,
          action: 'analyze_artifact',
          target,
          error: err.message || String(err),
        };
      }
    }

    if (action === 'get_evidence') {
      try {
        const evidence = getStoredEvidence(target);
        if (!evidence) {
          return {
            success: false,
            action: 'get_evidence',
            target,
            error: `Evidence not found: "${target}".`,
          };
        }
        return {
          success: true,
          action: 'get_evidence',
          target,
          evidence,
          data: evidence,
        };
      } catch (err: any) {
        return {
          success: false,
          action: 'get_evidence',
          target,
          error: err.message || String(err),
        };
      }
    }
  }

  const modelActions = [
    'inspect_model',
    'infer_layer_roles',
    'trace_layer_execution',
    'reconstruct_training_samples',
    'extract_model_layer',
    'analyze_model_layer',
  ];

  if (modelActions.includes(action)) {
    if (!authorization || !VALID_AUTH.includes(authorization as ReverseAuthorization)) {
      return {
        success: false,
        action,
        target,
        error: 'Target analysis requires authorization framing: "ctf" | "lab" | "consent".',
      };
    }

    if (!target || !target.trim()) {
      return {
        success: false,
        action,
        error: 'Target is required.',
      };
    }

    const allowedRoots = [
      process.cwd(),
      os.tmpdir(),
      ...(options?.workspaceRoot ? [String(options.workspaceRoot)] : []),
    ];

    if (!isSafeAllowedPath(target, allowedRoots)) {
      return {
        success: false,
        action,
        target,
        error: 'Path traversal disallowed in target.',
      };
    }

    if (action === 'extract_model_layer' || action === 'analyze_model_layer') {
      if (!options?.layer || !String(options.layer).trim()) {
        return {
          success: false,
          action,
          target,
          error: 'options.layer is required.',
        };
      }
    }

    if (action === 'reconstruct_training_samples') {
      if (authorization !== 'consent' || options?.explicitConsentAck !== true) {
        return {
          success: false,
          action,
          target,
          error: 'Reconstruction of training samples requires explicit authorization: "consent" and options.explicitConsentAck: true due to potential training data privacy boundaries.',
        };
      }
    }

    let scriptPath: string;
    try {
      scriptPath = resolveModelInspectorPath();
    } catch (err: any) {
      return {
        success: false,
        action,
        target,
        error: err.message || String(err),
      };
    }

    const actionMap: Record<string, string> = {
      inspect_model: 'inspect',
      infer_layer_roles: 'infer_roles',
      trace_layer_execution: 'trace_execution',
      reconstruct_training_samples: 'reconstruct_samples',
      extract_model_layer: 'extract_layer',
      analyze_model_layer: 'analyze_layer',
    };

    const pyAction = actionMap[action];
    const args = [scriptPath, pyAction, '--file', target];
    if (options?.format) {
      args.push('--format', String(options.format));
    }
    if (options?.layer) {
      args.push('--layer', String(options.layer));
    }

    if (options?.output) {
      const outStr = String(options.output);
      if (!isSafeAllowedPath(outStr, allowedRoots)) {
        return {
          success: false,
          action,
          target,
          error: 'Path traversal disallowed in options.output.',
        };
      }
      args.push('--output', path.resolve(outStr));
    }
    if (options?.cacheDir) {
      const cacheStr = String(options.cacheDir);
      if (!isSafeAllowedPath(cacheStr, allowedRoots)) {
        return {
          success: false,
          action,
          target,
          error: 'Path traversal disallowed in options.cacheDir.',
        };
      }
      args.push('--cache-dir', path.resolve(cacheStr));
    }
    if (options?.targetClass !== undefined) {
      args.push('--target-class', String(options.targetClass));
    }
    if (options?.steps !== undefined) {
      args.push('--steps', String(options.steps));
    }

    const pythonBin = resolvePythonPath();
    const isAsync = options?.async === true;
    const syncBudgetMs = Number(options?.syncBudgetMs ?? 30_000);

    if (runKey && RunRegistry.isRunning(runKey)) {
      const existing = RunRegistry.get(runKey)!;
      return {
        success: true,
        action,
        target,
        data: {
          status: 'running',
          sessionId: effectiveSessionId,
          startedAt: existing.startedAt,
          elapsedMs: Date.now() - existing.startedAt,
          message: `Operation already in progress for session ${effectiveSessionId}. Poll with action: 'status'.`,
        },
      };
    }

    const runInfo = runKey ? RunRegistry.start(runKey) : undefined;

    const executeAction = async (): Promise<ReverseToolResult> => {
      try {
        const { stdout } = await execFileAsync(pythonBin, args, {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
          encoding: 'utf8',
          signal: runInfo?.controller?.signal,
        });
        const data = JSON.parse(stdout);
        return {
          success: true,
          action,
          target,
          data,
        };
      } catch (err: any) {
        return {
          success: false,
          action,
          target,
          error: err.message || String(err),
        };
      }
    };

    if (isAsync) {
      executeAction().then(res => {
        if (runKey) {
          reverseToolResultsCache.set(runKey, res);
          RunRegistry.finish(runKey, res.success ? undefined : res.error);
        }
      });
      return {
        success: true,
        action,
        target,
        data: {
          status: 'running',
          sessionId: effectiveSessionId,
          message: `Operation started in background. Poll with action: 'status' and sessionId: '${effectiveSessionId}'.`,
        },
      };
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), syncBudgetMs);
    });
    const executionPromise = executeAction();

    try {
      const winner = await Promise.race([executionPromise, timeoutPromise]);
      if (winner !== 'timeout') {
        if (runKey) {
          RunRegistry.finish(runKey, winner.success ? undefined : winner.error);
          reverseToolResultsCache.set(runKey, winner);
        }
        return winner;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Exceeded 30 sec synchronous window: yield running status, continue in background
    executionPromise.then(res => {
      if (runKey) {
        reverseToolResultsCache.set(runKey, res);
        RunRegistry.finish(runKey, res.success ? undefined : res.error);
      }
    });

    return {
      success: true,
      action,
      target,
      data: {
        status: 'running',
        sessionId: effectiveSessionId,
        message: `Operation exceeded ${Math.round(syncBudgetMs / 1000)}s synchronous window; continuing in background. Poll with action: 'status' and sessionId: '${effectiveSessionId}'.`,
      },
    };
  }

  return {
    success: false,
    action: action || 'unknown',
    error: `Unsupported action: "${action}". Supported actions: "status", "abort", "list_capabilities", "analyze_javascript", "analyze_artifact", "get_evidence", "scan_github", "inspect_model", "infer_layer_roles", "trace_layer_execution", "reconstruct_training_samples", "extract_model_layer", "analyze_model_layer".`,
  };
}

export const runReverseTool = reverseTool;
