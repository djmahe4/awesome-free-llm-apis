import { ReaProxy, type BlockedToolInfo } from '../reverse/proxy.js';

export type ReverseAuthorization = 'ctf' | 'lab' | 'consent';

export interface ReverseToolInput {
  action: 'status' | 'list_capabilities';
  target?: string;
  authorization?: ReverseAuthorization;
  options?: Record<string, unknown>;
}

export interface ReverseToolResult {
  success: boolean;
  action: string;
  target?: string;
  data?: any;
  error?: string;
}

/** Checks whether the running Node.js version is >= 22.19 and not 23 or 25 */
export function checkNodeCompatibility(versionStr = process.versions.node): { supported: boolean; version: string; reason?: string } {
  const [major, minor] = versionStr.split('.').map(Number);
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
          'scan_github',
          'inspect_gguf',
          'probe_memorization',
        ],
      },
    };
  }

  if (action === 'list_capabilities') {
    if (target && !authorization) {
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
      try {
        const proxy = new ReaProxy({
          command: reaPath,
          requestTimeoutMs: 5000,
        });
        const info = await proxy.start();
        engineCallable = info.callable;
        engineBlocked = info.blocked;
        await proxy.close();
      } catch (err: any) {
        engineBlocked.push({ name: 'rea-engine', reason: err.message || 'Failed to initialize engine' });
      }
    }

    const staticCapabilities = [
      'analyze_javascript',
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

  return {
    success: false,
    action: action || 'unknown',
    error: `Unsupported action: "${action}". Supported actions in Phase 1: "status", "list_capabilities".`,
  };
}
