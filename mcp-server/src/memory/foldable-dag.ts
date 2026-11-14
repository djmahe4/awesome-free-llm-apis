import { DiskSymbolDb, type DagNodeRecord, type DagEdgeRecord } from './disk-symbol-db.js';

export interface DagSymbolInput {
  id: string;
  module?: string;
  kind?: DagNodeRecord['kind'];
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  signature?: string;
  docstring?: string;
  tags?: string[];
  payload?: string;
  metadata?: Record<string, any>;
}

export interface FoldedModuleSummary {
  name: string;
  symbolCount: number;
  symbols?: string[];
  dependencies?: string[];
  metadata?: Record<string, any>;
}

export interface BlastRadiusReport {
  targetSymbolId: string;
  directCallers: string[];
  transitiveCallers: string[];
  totalAffected: number;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  depth: number;
}

export interface BreakingChangeOption {
  id: 'backward_compatible_overload' | 'refactor_all_callers' | 'versioned_symbol';
  title?: string;
  description?: string;
}

export interface BreakingChangePrompt {
  targetSymbolId: string;
  changeSpec: {
    changeType: string;
    oldSignature?: string;
    newSignature?: string;
  };
  requiresUserChoice: boolean;
  directCallerCount: number;
  totalAffected: number;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  options: BreakingChangeOption[];
  message?: string;
}

export class FoldableDag {
  private db: DiskSymbolDb;
  private repoHash: string;

  constructor(db: DiskSymbolDb, repoHash: string) {
    this.db = db;
    this.repoHash = repoHash;
  }

  addSymbol(sym: DagSymbolInput): void {
    const node: DagNodeRecord = {
      id: sym.id,
      kind: sym.kind ?? 'function',
      scope: sym.module,
      filePath: sym.filePath ?? '',
      lineStart: sym.lineStart,
      lineEnd: sym.lineEnd,
      signature: sym.signature,
      docstring: sym.docstring,
      tags: sym.tags,
      payload: sym.payload,
      metadata: sym.metadata,
    };
    this.db.putNode(this.repoHash, node);
  }

  addInvocation(callerId: string, calleeId: string, metadata?: Record<string, any>): void {
    this.db.putEdge(this.repoHash, {
      source: callerId,
      target: calleeId,
      kind: 'invokes',
      confidence: 'high',
      metadata,
    });
  }

  getFoldedSummary(): { modules: FoldedModuleSummary[] } {
    const allNodes = this.db.getAllNodes(this.repoHash);
    const nodeToModule = new Map<string, string>();
    const moduleNodes = new Map<string, DagNodeRecord[]>();

    for (const node of allNodes) {
      const mod = node.scope ?? 'default';
      nodeToModule.set(node.id, mod);
      const list = moduleNodes.get(mod);
      if (list) {
        list.push(node);
      } else {
        moduleNodes.set(mod, [node]);
      }
    }

    const allEdges = this.db.getAllEdges(this.repoHash);
    const moduleDeps = new Map<string, Set<string>>();

    for (const edge of allEdges) {
      const srcMod = nodeToModule.get(edge.source);
      const tgtMod = nodeToModule.get(edge.target);
      if (srcMod && tgtMod && srcMod !== tgtMod) {
        let set = moduleDeps.get(srcMod);
        if (!set) {
          set = new Set<string>();
          moduleDeps.set(srcMod, set);
        }
        set.add(tgtMod);
      }
    }

    const modules: FoldedModuleSummary[] = [];
    for (const [modName, nodes] of moduleNodes.entries()) {
      modules.push({
        name: modName,
        symbolCount: nodes.length,
        symbols: nodes.map((n) => n.id),
        dependencies: Array.from(moduleDeps.get(modName) ?? []),
      });
    }

    return { modules };
  }

  unfoldModule(moduleName: string): { module: string; symbols: DagNodeRecord[]; edges: DagEdgeRecord[] } {
    const symbols = this.db.getNodesByScope(this.repoHash, moduleName);
    const edgeMap = new Map<string, DagEdgeRecord>();

    for (const sym of symbols) {
      const outgoing = this.db.getEdgesFrom(this.repoHash, sym.id);
      for (const e of outgoing) {
        edgeMap.set(`${e.source}->${e.target}:${e.kind}`, e);
      }
      const incoming = this.db.getEdgesTo(this.repoHash, sym.id);
      for (const e of incoming) {
        edgeMap.set(`${e.source}->${e.target}:${e.kind}`, e);
      }
    }

    return {
      module: moduleName,
      symbols,
      edges: Array.from(edgeMap.values()),
    };
  }

  computeBlastRadius(targetSymbolId: string, maxDepth = 10): BlastRadiusReport {
    const directCallers: string[] = [];
    const transitiveCallers: string[] = [];
    const visited = new Set<string>([targetSymbolId]);

    const queue: Array<{ id: string; depth: number }> = [{ id: targetSymbolId, depth: 0 }];
    let maxReachedDepth = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const incomingEdges = this.db.getEdgesTo(this.repoHash, current.id);
      for (const edge of incomingEdges) {
        if (edge.kind !== 'invokes') continue;
        const callerId = edge.source;
        if (visited.has(callerId)) continue;
        visited.add(callerId);

        const callerDepth = current.depth + 1;
        if (callerDepth > maxReachedDepth) {
          maxReachedDepth = callerDepth;
        }

        if (callerDepth === 1) {
          directCallers.push(callerId);
        } else {
          transitiveCallers.push(callerId);
        }

        queue.push({ id: callerId, depth: callerDepth });
      }
    }

    const totalAffected = directCallers.length + transitiveCallers.length;
    let severity: 'low' | 'moderate' | 'high' | 'critical' = 'low';
    if (totalAffected >= 10) {
      severity = 'critical';
    } else if (totalAffected >= 5) {
      severity = 'high';
    } else if (totalAffected >= 2) {
      severity = 'moderate';
    } else {
      severity = 'low';
    }

    return {
      targetSymbolId,
      directCallers,
      transitiveCallers,
      totalAffected,
      severity,
      depth: maxReachedDepth,
    };
  }

  evaluateBreakingChangeAction(
    targetSymbolId: string,
    changeSpec: { changeType: string; oldSignature?: string; newSignature?: string },
    threshold = 3
  ): BreakingChangePrompt {
    const blast = this.computeBlastRadius(targetSymbolId);
    const requiresUserChoice = blast.directCallers.length >= threshold || blast.totalAffected >= threshold;

    const options: BreakingChangeOption[] = [
      {
        id: 'backward_compatible_overload',
        title: 'Backward-Compatible Overload',
        description: 'Provide a backward-compatible wrapper or overload to prevent breaking existing callers.',
      },
      {
        id: 'refactor_all_callers',
        title: 'Refactor All Callers',
        description: 'Update all direct and transitive callers to conform to the new signature.',
      },
      {
        id: 'versioned_symbol',
        title: 'Versioned Symbol',
        description: 'Introduce a new versioned symbol and deprecate the original.',
      },
    ];

    return {
      targetSymbolId,
      changeSpec,
      requiresUserChoice,
      directCallerCount: blast.directCallers.length,
      totalAffected: blast.totalAffected,
      severity: blast.severity,
      options,
      message: requiresUserChoice
        ? `Breaking change in '${targetSymbolId}' affects ${blast.directCallers.length} direct caller(s) and ${blast.transitiveCallers.length} transitive caller(s). User decision required.`
        : `Breaking change in '${targetSymbolId}' is within threshold (${blast.totalAffected} < ${threshold}).`,
    };
  }
}
