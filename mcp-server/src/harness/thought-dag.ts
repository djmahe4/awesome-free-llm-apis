import readline from 'node:readline';
import fs from 'node:fs';

export type DagNodeKind = 'root' | 'thought' | 'tool_call' | 'tool_result';

export interface DagNode {
  id: string;
  parent: string | null;
  kind: DagNodeKind;
  text: string;
  tool?: string;
  toolCallId?: string;
  resultOk?: boolean;
  input?: string;
  depth: number;
  timestamp?: string;
}

export interface ThoughtDag {
  sessionId: string;
  goal: string;
  nodes: DagNode[];
  byId: Map<string, DagNode>;
}

export interface BuildOptions {
  maxLines?: number;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join(' ');
}

function shortJson(input: unknown): string {
  try {
    const s = JSON.stringify(input ?? {});
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch {
    return '';
  }
}

export async function buildThoughtDag(jsonlPath: string, opts?: BuildOptions): Promise<ThoughtDag> {
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, 'utf8'),
    crlfDelay: Infinity,
  });

  let sessionId = '';
  let goal = '';
  const nodes: DagNode[] = [];
  const byId = new Map<string, DagNode>();
  const toolCallNodes = new Map<string, string>();
  const counterByKind: Record<DagNodeKind, number> = { root: 0, thought: 0, tool_call: 0, tool_result: 0 };
  const chain = { tail: null as DagNode | null };
  let lines = 0;

  const push = (node: DagNode): DagNode => {
    nodes.push(node);
    byId.set(node.id, node);
    chain.tail = node;
    return node;
  };

  const makeNode = (
    kind: DagNodeKind,
    parent: string | null,
    text: string,
    timestamp?: string,
  ): DagNode => {
    counterByKind[kind]++;
    return {
      id: `${sessionId}:${kind}:${counterByKind[kind]}`,
      parent,
      kind,
      text,
      depth: parent === null ? 0 : (byId.get(parent)?.depth ?? 0) + 1,
      timestamp,
    };
  };

  for await (const line of rl) {
    if (opts?.maxLines !== undefined && lines >= opts.maxLines) break;
    if (!line.trim()) continue;
    lines++;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (typeof rec?.sessionId === 'string') sessionId = rec.sessionId;
    const msg = rec?.message;
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    const timestamp = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;

    if (role === 'user' && Array.isArray(msg.content)) {
      const resultBlocks = msg.content.filter((b: any) => b?.type === 'tool_result');
      if (resultBlocks.length > 0) {
        for (const block of resultBlocks) {
          const text = extractText(block?.content).trim();
          const callNodeId = typeof block?.tool_use_id === 'string'
            ? toolCallNodes.get(block.tool_use_id)
            : undefined;
          const parent = callNodeId ?? chain.tail?.id ?? null;
          const node = makeNode('tool_result', parent, text, timestamp);
          node.toolCallId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined;
          node.resultOk = !block?.is_error;
          push(node);
        }
        continue;
      }
    }

    if (role === 'user') {
      const text = extractText(msg.content).trim();
      if (!text) continue;
      if (!goal) goal = text;
      chain.tail = null;
      push(makeNode('root', null, text, timestamp));
      continue;
    }

    if (role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'thinking') {
        const text = typeof block.thinking === 'string' ? block.thinking.trim() : '';
        if (!text) continue;
        push(makeNode('thought', chain.tail?.id ?? null, text, timestamp));
      } else if (block?.type === 'tool_use') {
        const node = makeNode('tool_call', chain.tail?.id ?? null, '', timestamp);
        node.tool = typeof block?.name === 'string' ? block.name : undefined;
        node.toolCallId = typeof block?.id === 'string' ? block.id : undefined;
        node.input = shortJson(block?.input);
        if (node.toolCallId) toolCallNodes.set(node.toolCallId, node.id);
        push(node);
      }
    }
  }

  rl.close();

  if (!sessionId) {
    try {
      sessionId = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').slice(0, 8192))?.sessionId ?? '';
    } catch {
      sessionId = '';
    }
  }

  return { sessionId, goal, nodes, byId };
}

export interface LinearThoughtEntry {
  id: string;
  text: string;
  timeCreated?: string;
}

export function buildLinearThoughtDag(
  sessionId: string,
  entries: LinearThoughtEntry[],
): ThoughtDag {
  const nodes: DagNode[] = [];
  const byId = new Map<string, DagNode>();
  let parent: string | null = null;
  for (const entry of entries) {
    if (!entry.text.trim()) continue;
    const id = `${sessionId}:${entry.id}`;
    const node: DagNode = {
      id,
      parent,
      kind: nodes.length === 0 ? 'root' : 'thought',
      text: entry.text,
      depth: parent ? (byId.get(parent)?.depth ?? 0) + 1 : 0,
      timestamp: entry.timeCreated,
    };
    nodes.push(node);
    byId.set(id, node);
    parent = id;
  }
  return { sessionId, goal: nodes[0]?.text ?? '', nodes, byId };
}

export function expandThoughtDag(dag: ThoughtDag, query: string, maxChars = 16000): string {
  if (!dag.nodes.length || maxChars <= 0) return '';
  const rawTerms = Array.from(new Set(query.toLowerCase().match(/[\p{L}\p{N}_./\\-]{3,}/gu) ?? []));
  const terms = rawTerms.filter(t => !rawTerms.some(other => other !== t && other.includes(t)));
  const selected = new Set<string>();
  const ranked = dag.nodes.map((node, index) => ({
    node,
    index,
    score: terms.reduce((score, term) => score + Number(node.text.toLowerCase().includes(term)), 0),
  })).sort((a, b) => b.score - a.score || b.index - a.index);
  for (const entry of ranked) {
    if (entry.score === 0 && selected.size > 0) break;
    let node: DagNode | undefined = entry.node;
    let guard = 0;
    while (node && guard++ < dag.nodes.length) {
      selected.add(node.id);
      node = node.parent ? dag.byId.get(node.parent) : undefined;
    }
  }
  if (selected.size === 0) {
    for (const node of dag.nodes.slice(-10)) selected.add(node.id);
  }
  for (const node of dag.nodes) {
    if (node.kind === 'tool_result' && node.parent && selected.has(node.parent)) selected.add(node.id);
  }
  const lines = [`[Agent context: ${dag.sessionId}]`];
  let size = lines[0].length;
  for (const node of dag.nodes) {
    if (!selected.has(node.id)) continue;
    const line = `${'  '.repeat(Math.min(node.depth, 10))}[${node.kind}] ${node.text}`;
    if (size + line.length + 1 > maxChars) continue;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

export function traceRoot(dag: ThoughtDag, id: string): DagNode | null {
  let node = dag.byId.get(id);
  if (!node) return null;
  while (node.parent !== null) {
    const parent = dag.byId.get(node.parent);
    if (!parent) break;
    node = parent;
  }
  return node;
}

export function chainOf(dag: ThoughtDag, id: string): DagNode[] {
  const out: DagNode[] = [];
  let node = dag.byId.get(id);
  let guard = 0;
  while (node && guard < dag.nodes.length) {
    out.unshift(node);
    if (node.parent === null) break;
    node = dag.byId.get(node.parent);
    guard++;
  }
  return out;
}
