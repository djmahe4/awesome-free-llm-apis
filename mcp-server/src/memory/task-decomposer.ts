import path from 'node:path';
import { getDiskSymbolDb } from './disk-symbol-db.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { splitSteps } from '../tools/coding-agents/goal-steps.js';
import type { TaskItem } from '../tools/coding-agents/types.js';

export interface TaskDecompositionInput {
  goal: string;
  workspace_root: string;
  candidateFiles?: string[];
  maxSubtasks?: number;
}

export interface HeavyNodeRisk {
  symbol: string;
  filePath: string;
  kind: string;
  fanIn: number;
  fanOut: number;
  riskScore: number;
  warning: string;
}

export interface DecomposedTaskPlan {
  success: boolean;
  goal: string;
  workspace: string;
  heavyNodesIdentified: HeavyNodeRisk[];
  tasks: TaskItem[];
  suggestedVerification: string[];
}

/**
 * Task Decomposer leveraging DiskSymbolDb graph centrality and fan-in/fan-out
 * to identify breaking changes and heavy dependency hubs before coding agents execute.
 */
export class TaskDecomposer {
  private scanner = new WorkspaceScanner(process.cwd());

  /**
   * Computes graph centrality / heavy nodes in the workspace repository.
   * High fan-in nodes (> 3 incoming references/calls) represent high-risk breaking points.
   */
  public async identifyHeavyNodes(
    workspaceRoot: string,
    candidateFiles?: string[]
  ): Promise<HeavyNodeRisk[]> {
    const wsHash = await this.scanner.getWorkspaceHash(workspaceRoot);
    const diskDb = getDiskSymbolDb();
    const allNodes = diskDb.getAllNodes(wsHash);
    const allEdges = diskDb.getAllEdges(wsHash);

    const inDegreeMap = new Map<string, number>();
    const outDegreeMap = new Map<string, number>();

    for (const edge of allEdges) {
      outDegreeMap.set(edge.source, (outDegreeMap.get(edge.source) || 0) + 1);
      inDegreeMap.set(edge.target, (inDegreeMap.get(edge.target) || 0) + 1);
    }

    const heavyNodes: HeavyNodeRisk[] = [];
    const filterFiles = candidateFiles && candidateFiles.length > 0
      ? new Set(candidateFiles.map(f => path.normalize(f).replace(/\\/g, '/')))
      : null;

    for (const node of allNodes) {
      const normFile = path.normalize(node.filePath).replace(/\\/g, '/');
      if (filterFiles && !filterFiles.has(normFile)) {
        continue;
      }

      const fanIn = inDegreeMap.get(node.id) || 0;
      const fanOut = outDegreeMap.get(node.id) || 0;
      const riskScore = fanIn * 2 + fanOut;

      // Heavy node threshold: >= 2 incoming calls or combined score >= 3
      if (fanIn >= 2 || riskScore >= 3) {
        heavyNodes.push({
          symbol: node.id,
          filePath: node.filePath,
          kind: node.kind,
          fanIn,
          fanOut,
          riskScore,
          warning: fanIn >= 3
            ? `High-risk core node (${fanIn} dependents). Edits may cause regressions across multiple call-sites.`
            : `Moderately coupled node (${fanIn} callers, ${fanOut} dependencies). Ensure contract verification.`,
        });
      }
    }

    // Sort descending by riskScore
    return heavyNodes.sort((a, b) => b.riskScore - a.riskScore);
  }

  /**
   * Decomposes a goal into sequential, verifiable subtasks grounded in
   * candidate files and graph dependency ordering.
   */
  public async decomposeTask(input: TaskDecompositionInput): Promise<DecomposedTaskPlan> {
    const { goal, workspace_root, candidateFiles = [], maxSubtasks = 10 } = input;
    const heavyNodes = await this.identifyHeavyNodes(workspace_root, candidateFiles);

    // 1. Parse steps from goal text
    const lines = goal.split('\n').map(l => l.trim()).filter(Boolean);
    const listMarker = /^\s*(?:\d+[.)\-]|[-*])\s+/;
    const items: string[] = [];

    for (const line of lines) {
      if (listMarker.test(line)) {
        const clean = line.replace(listMarker, '').trim();
        if (clean) items.push(clean);
      }
    }

    const stepList = items.length >= 2 ? items : splitSteps(goal);
    const rawSteps = stepList.length > 0 ? stepList : [goal];

    // 2. Map steps to tasks and map candidate files and heavy nodes
    const tasks: TaskItem[] = [];
    for (let i = 0; i < Math.min(rawSteps.length, maxSubtasks); i++) {
      const stepText = rawSteps[i];
      let matchedFile: string | undefined;

      // Try matching candidate files in step text
      for (const f of candidateFiles) {
        const base = path.basename(f);
        if (stepText.toLowerCase().includes(base.toLowerCase()) || stepText.toLowerCase().includes(f.toLowerCase())) {
          matchedFile = path.normalize(f).replace(/\\/g, '/');
          break;
        }
      }

      // Check if step touches a heavy node
      const relatedHeavy = heavyNodes.find(h => {
        const sym = h.symbol.toLowerCase();
        const fp = path.normalize(h.filePath).toLowerCase().replace(/\\/g, '/');
        const st = stepText.toLowerCase();
        const mf = matchedFile ? path.normalize(matchedFile).toLowerCase().replace(/\\/g, '/') : '';
        return st.includes(sym) || (mf && (fp.includes(mf) || mf.includes(fp))) || (st.includes(path.basename(fp)));
      });

      let context = relatedHeavy
        ? `[Caution: Heavy Node] Affects ${relatedHeavy.symbol} in ${relatedHeavy.filePath} (${relatedHeavy.fanIn} callers). ${relatedHeavy.warning}`
        : 'Bounded subtask. Verify local contracts and avoid breaking external callers.';

      tasks.push({
        id: `subtask-${i + 1}`,
        task: stepText,
        status: 'pending',
        targetFile: matchedFile,
        context,
        log: [],
      });
    }

    // 3. Propose verification suite based on identified heavy nodes
    const suggestedVerification: string[] = [
      'npm run verify:precommit',
      'npx vitest run',
    ];
    if (heavyNodes.length > 0) {
      const topHeavy = heavyNodes[0];
      suggestedVerification.unshift(`npx vitest run --testNamePattern="${topHeavy.symbol}"`);
    }

    return {
      success: true,
      goal,
      workspace: workspace_root,
      heavyNodesIdentified: heavyNodes,
      tasks,
      suggestedVerification,
    };
  }
}
