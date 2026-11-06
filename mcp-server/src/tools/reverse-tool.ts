import { ReaProxy, type BlockedToolInfo } from '../reverse/proxy.js';
import { analyzeJsFile } from '../reverse/js-analyzer.js';
import { analyzeArtifactFile } from '../reverse/artifact-analyzer.js';
import { getStoredEvidence, storeEvidence, type ReverseEvidence } from '../reverse/evidence.js';

export type ReverseAuthorization = 'ctf' | 'lab' | 'consent';
const VALID_AUTH: ReverseAuthorization[] = ['ctf', 'lab', 'consent'];

export interface ReverseToolInput {
  action: 'status' | 'list_capabilities' | 'analyze_javascript' | 'analyze_artifact' | 'get_evidence';
  target?: string;
  authorization?: ReverseAuthorization;
  options?: Record<string, unknown>;
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
  const { action, target, authorization, options } = input;

  if (action === 'status') {
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
          'analyze_javascript',
          'analyze_artifact',
          'get_evidence',
          'scan_github',
          'inspect_gguf',
          'probe_memorization',
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
      'analyze_javascript',
      'analyze_artifact',
      'get_evidence',
      'scan_github',
      'inspect_gguf',
      'probe_memorization',
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

  return {
    success: false,
    action: action || 'unknown',
    error: `Unsupported action: "${action}". Supported actions: "status", "list_capabilities", "analyze_javascript", "analyze_artifact", "get_evidence".`,
  };
}
