import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { withFileLock } from '../utils/file-lock.js';

export interface DagNode {
  id: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'pdf_page';
  content?: string;
  filePath?: string;
  pdfPage?: number;
  tags: string[];
  createdAt: number;
  lastReviewedAt: number;
  halfLifeDays: number;
  confidence: number;
  sourceCount: number;
  workspaceHash: string;
}

export interface DagEdge {
  from: string;
  to: string;
  relation: string;
  createdAt: number;
}

export type DagNodeInput = Partial<Omit<DagNode, 'id' | 'createdAt' | 'lastReviewedAt' | 'sourceCount' | 'workspaceHash'>> & {
  type: DagNode['type'];
};

/**
 * File-based DAG (nodes + edges) memory store, mirroring WikiMemory's
 * per-workspace on-disk persistence style. One directory per workspace hash
 * under .free-llm-mcp/memory/dag/, one JSON file each for nodes and edges.
 */
export class DagMemory {
  private workspaceHash: string;
  private dir: string;
  private nodesPath: string;
  private edgesPath: string;

  constructor(workspaceHash: string, baseDir?: string) {
    this.workspaceHash = workspaceHash;
    const root = baseDir ? path.join(baseDir, '.free-llm-mcp', 'memory', 'dag') : path.join(process.cwd(), '.free-llm-mcp', 'memory', 'dag');
    this.dir = path.join(root, workspaceHash);
    this.nodesPath = path.join(this.dir, 'nodes.json');
    this.edgesPath = path.join(this.dir, 'edges.json');
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await fs.mkdir(this.dir, { recursive: true });
    }
  }

  private async loadNodes(): Promise<DagNode[]> {
    if (!existsSync(this.nodesPath)) return [];
    try {
      return JSON.parse(await fs.readFile(this.nodesPath, 'utf-8')) as DagNode[];
    } catch {
      return [];
    }
  }

  private async saveNodes(nodes: DagNode[]): Promise<void> {
    await this.ensureDir();
    await withFileLock(this.nodesPath, async () => {
      await fs.writeFile(this.nodesPath, JSON.stringify(nodes, null, 2), 'utf-8');
    });
  }

  private async loadEdges(): Promise<DagEdge[]> {
    if (!existsSync(this.edgesPath)) return [];
    try {
      return JSON.parse(await fs.readFile(this.edgesPath, 'utf-8')) as DagEdge[];
    } catch {
      return [];
    }
  }

  private async saveEdges(edges: DagEdge[]): Promise<void> {
    await this.ensureDir();
    await withFileLock(this.edgesPath, async () => {
      await fs.writeFile(this.edgesPath, JSON.stringify(edges, null, 2), 'utf-8');
    });
  }

  /** Rejects .pptx/.docx file pointers — those media types are excluded from this store. */
  async addNode(input: DagNodeInput): Promise<DagNode> {
    if (input.filePath && /\.(pptx|docx)$/i.test(input.filePath)) {
      throw new Error(`Unsupported media type for DAG node: ${input.filePath} (.pptx/.docx are excluded)`);
    }
    const now = Date.now();
    const node: DagNode = {
      id: crypto.randomUUID(),
      type: input.type,
      content: input.content,
      filePath: input.filePath,
      pdfPage: input.pdfPage,
      tags: input.tags || [],
      createdAt: now,
      lastReviewedAt: now,
      halfLifeDays: input.halfLifeDays ?? 30,
      confidence: input.confidence ?? 0.5,
      sourceCount: 1,
      workspaceHash: this.workspaceHash,
    };
    const nodes = await this.loadNodes();
    nodes.push(node);
    await this.saveNodes(nodes);
    return node;
  }

  async getNode(id: string): Promise<DagNode | undefined> {
    const nodes = await this.loadNodes();
    return nodes.find(n => n.id === id);
  }

  async listNodes(tag?: string): Promise<DagNode[]> {
    const nodes = await this.loadNodes();
    return tag ? nodes.filter(n => n.tags.includes(tag)) : nodes;
  }

  /** DFS: true if `target` is reachable from `start` by following existing from->to edges. */
  private isReachable(edges: DagEdge[], start: string, target: string, seen = new Set<string>()): boolean {
    if (start === target) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    for (const edge of edges) {
      if (edge.from === start && this.isReachable(edges, edge.to, target, seen)) {
        return true;
      }
    }
    return false;
  }

  /** Adds a from->to edge; rejects (throws) if it would create a cycle in the DAG. */
  async addEdge(from: string, to: string, relation: string): Promise<DagEdge> {
    const edges = await this.loadEdges();
    // Adding from->to creates a cycle iff `from` is already reachable from `to`
    // (i.e. a path to -> ... -> from already exists).
    if (this.isReachable(edges, to, from)) {
      throw new Error(`Cannot add edge ${from} -> ${to}: would create a cycle`);
    }
    const edge: DagEdge = { from, to, relation, createdAt: Date.now() };
    edges.push(edge);
    await this.saveEdges(edges);
    return edge;
  }

  async reviewNode(id: string): Promise<DagNode | null> {
    const nodes = await this.loadNodes();
    const node = nodes.find(n => n.id === id);
    if (node) {
      node.lastReviewedAt = Date.now();
      node.confidence = Math.min(1.0, node.confidence + 0.15);
      await this.saveNodes(nodes);
      return node;
    }
    return null;
  }

  async graphQuery(): Promise<{ nodes: DagNode[]; edges: DagEdge[] }> {
    const [nodes, edges] = await Promise.all([this.loadNodes(), this.loadEdges()]);
    return { nodes, edges };
  }
}
