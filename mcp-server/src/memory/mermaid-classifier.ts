export interface MermaidDiagramDef {
  keyword: string;
  description: string;
  semanticIntent: string;
}

export const MERMAID_DIAGRAM_TYPES: Record<string, MermaidDiagramDef> = {
  Flowchart: {
    keyword: 'flowchart',
    description: 'Visualizes control flow, decision trees, algorithm logic, microservice routing, and CI/CD pipelines.',
    semanticIntent: 'control flow, logic, routing, pipelines',
  },
  'Sequence Diagram': {
    keyword: 'sequenceDiagram',
    description: 'Models REST/gRPC API lifecycles, OAuth/authentication handshakes, and asynchronous message passing.',
    semanticIntent: 'API lifecycles, handshakes, message passing',
  },
  'Class Diagram': {
    keyword: 'classDiagram',
    description: 'Represents object-oriented domain models, interface contracts, inheritance hierarchies, and type relationships.',
    semanticIntent: 'domain models, type contracts, interfaces, inheritance',
  },
  'Entity Relationship (ERD)': {
    keyword: 'erDiagram',
    description: 'Defines relational database schemas, SQL tables, primary/foreign keys, and entity cardinality.',
    semanticIntent: 'database schema, tables, foreign keys, cardinality',
  },
  'State Diagram': {
    keyword: 'stateDiagram-v2',
    description: 'Maps finite state machines (FSM), order/job lifecycles, WebSocket connection states, and UI transitions.',
    semanticIntent: 'state machines, lifecycles, transitions',
  },
  'C4 Architecture': {
    keyword: 'C4Context',
    description: 'Illustrates multi-level system architecture across System Context, Containers, Components, and Deployment.',
    semanticIntent: 'system context, containers, component deployment',
  },
  Architecture: {
    keyword: 'architecture-beta',
    description: 'Depicts cloud infrastructure topologies, VPC/subnet groupings, service icons, and directional network edges.',
    semanticIntent: 'cloud topology, VPC, subnets, infra edges',
  },
  'Git Graph': {
    keyword: 'gitGraph',
    description: 'Displays branching strategies, release tagging, merge commits, and cherry-pick workflows.',
    semanticIntent: 'git branching, releases, merge workflows',
  },
  'Gantt Chart': {
    keyword: 'gantt',
    description: 'Tracks sprint roadmaps, release milestones, task dependencies, and critical path scheduling.',
    semanticIntent: 'roadmaps, milestones, sprint dependencies',
  },
  'User Journey': {
    keyword: 'journey',
    description: 'Maps end-to-end UX flows, onboarding friction points, and actor satisfaction scores across product steps.',
    semanticIntent: 'UX journeys, user steps, friction scores',
  },
  Mindmap: {
    keyword: 'mindmap',
    description: 'Organizes system decomposition, feature brainstorming, threat modeling trees, and knowledge hierarchies.',
    semanticIntent: 'brainstorming, hierarchies, system decomposition',
  },
  'Requirement Diagram': {
    keyword: 'requirementDiagram',
    description: 'Provides SysML-style traceability linking functional and security requirements to test cases and modules.',
    semanticIntent: 'requirements, SysML traceability, test linkages',
  },
  'Packet Diagram': {
    keyword: 'packet-beta',
    description: 'Details bit-level network protocol headers such as TCP, IPv4/IPv6, and custom binary frames.',
    semanticIntent: 'network packets, byte/bit headers, binary frames',
  },
  'Block Diagram': {
    keyword: 'block-beta',
    description: 'Creates grid-aligned hardware and software block layouts requiring explicit column positioning.',
    semanticIntent: 'block layout, grid layout, hardware/software blocks',
  },
  'XY Chart': {
    keyword: 'xychart-beta',
    description: 'Plots benchmarking metrics, latency distributions, and numerical bar or line series.',
    semanticIntent: 'metrics plots, benchmarks, bar/line distributions',
  },
  'Quadrant Chart': {
    keyword: 'quadrantChart',
    description: 'Categorizes items across two axes for technical debt prioritization and risk matrices.',
    semanticIntent: 'risk matrices, technical debt 2-axis grids',
  },
  Timeline: {
    keyword: 'timeline',
    description: 'Chronicles chronological events, release histories, and incident postmortem sequences.',
    semanticIntent: 'chronological timeline, release history, postmortems',
  },
  Kanban: {
    keyword: 'kanban',
    description: 'Visualizes task boards, work-in-progress limits, and team workflow states.',
    semanticIntent: 'task board, WIP limits, kanban cards',
  },
};

export interface MermaidDetectionResult {
  detectedKeyword?: string;
  diagramName?: string;
  rawBlock: string;
  line: number;
}

/**
 * Extracts and classifies all Mermaid codeblocks within markdown content.
 */
export function extractMermaidBlocks(markdown: string): MermaidDetectionResult[] {
  const results: MermaidDetectionResult[] = [];
  const lines = markdown.split('\n');
  let inMermaid = false;
  let blockLines: string[] = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```mermaid')) {
      inMermaid = true;
      startLine = i + 1;
      blockLines = [];
      continue;
    }
    if (inMermaid && line.trim().startsWith('```')) {
      inMermaid = false;
      const rawBlock = blockLines.join('\n');
      const detected = identifyDiagramType(rawBlock);
      results.push({
        rawBlock,
        line: startLine,
        detectedKeyword: detected?.keyword,
        diagramName: detected?.name,
      });
      continue;
    }
    if (inMermaid) {
      blockLines.push(line);
    }
  }

  return results;
}

/**
 * Matches raw diagram text against known Mermaid keywords.
 */
export function identifyDiagramType(block: string): { name: string; keyword: string } | undefined {
  const stripped = block.replace(/%%[^\n]*/g, '').trim();
  for (const [name, def] of Object.entries(MERMAID_DIAGRAM_TYPES)) {
    // Check first token or directive prefix
    const regex = new RegExp(`^\\s*${def.keyword}\\b`, 'm');
    if (regex.test(stripped)) {
      return { name, keyword: def.keyword };
    }
  }
  // Fallback for flowchart alias "graph"
  if (/^\s*graph\b/m.test(stripped)) {
    return { name: 'Flowchart', keyword: 'flowchart' };
  }
  return undefined;
}

/**
 * Suggests an appropriate Mermaid diagram keyword based on natural language intent.
 */
export function classifyDiagramIntent(text: string): { name: string; keyword: string; description: string } {
  const lower = text.toLowerCase();
  if (lower.includes('sequence') || lower.includes('handshake') || lower.includes('oauth') || lower.includes('rpc') || lower.includes('api call')) {
    return { name: 'Sequence Diagram', keyword: 'sequenceDiagram', description: MERMAID_DIAGRAM_TYPES['Sequence Diagram'].description };
  }
  if (lower.includes('state') || lower.includes('fsm') || lower.includes('transition') || (lower.includes('lifecycle') && !lower.includes('api'))) {
    return { name: 'State Diagram', keyword: 'stateDiagram-v2', description: MERMAID_DIAGRAM_TYPES['State Diagram'].description };
  }
  if (lower.includes('class') || lower.includes('inherit') || lower.includes('oop') || lower.includes('interface')) {
    return { name: 'Class Diagram', keyword: 'classDiagram', description: MERMAID_DIAGRAM_TYPES['Class Diagram'].description };
  }
  if (lower.includes('schema') || lower.includes('table') || lower.includes('database') || lower.includes('entity') || lower.includes('foreign key')) {
    return { name: 'Entity Relationship (ERD)', keyword: 'erDiagram', description: MERMAID_DIAGRAM_TYPES['Entity Relationship (ERD)'].description };
  }
  if (lower.includes('c4') || lower.includes('container') || lower.includes('system context')) {
    return { name: 'C4 Architecture', keyword: 'C4Context', description: MERMAID_DIAGRAM_TYPES['C4 Architecture'].description };
  }
  if (lower.includes('cloud') || lower.includes('vpc') || lower.includes('subnet') || lower.includes('topology')) {
    return { name: 'Architecture', keyword: 'architecture-beta', description: MERMAID_DIAGRAM_TYPES.Architecture.description };
  }
  if (lower.includes('git') || lower.includes('branch') || lower.includes('merge') || lower.includes('release strategy')) {
    return { name: 'Git Graph', keyword: 'gitGraph', description: MERMAID_DIAGRAM_TYPES['Git Graph'].description };
  }
  if (lower.includes('roadmap') || lower.includes('gantt') || lower.includes('milestone') || lower.includes('schedule')) {
    return { name: 'Gantt Chart', keyword: 'gantt', description: MERMAID_DIAGRAM_TYPES['Gantt Chart'].description };
  }
  if (lower.includes('journey') || lower.includes('ux') || lower.includes('user flow') || lower.includes('onboarding')) {
    return { name: 'User Journey', keyword: 'journey', description: MERMAID_DIAGRAM_TYPES['User Journey'].description };
  }
  if (lower.includes('mindmap') || lower.includes('brainstorm') || lower.includes('hierarchy')) {
    return { name: 'Mindmap', keyword: 'mindmap', description: MERMAID_DIAGRAM_TYPES.Mindmap.description };
  }
  if (lower.includes('requirement') || lower.includes('sysml') || lower.includes('traceability')) {
    return { name: 'Requirement Diagram', keyword: 'requirementDiagram', description: MERMAID_DIAGRAM_TYPES['Requirement Diagram'].description };
  }
  if (lower.includes('packet') || lower.includes('protocol') || lower.includes('binary frame') || lower.includes('tcp') || lower.includes('ipv')) {
    return { name: 'Packet Diagram', keyword: 'packet-beta', description: MERMAID_DIAGRAM_TYPES['Packet Diagram'].description };
  }
  if (lower.includes('block') || lower.includes('hardware layout')) {
    return { name: 'Block Diagram', keyword: 'block-beta', description: MERMAID_DIAGRAM_TYPES['Block Diagram'].description };
  }
  if (lower.includes('latency') || lower.includes('benchmark') || lower.includes('xychart') || lower.includes('metric')) {
    return { name: 'XY Chart', keyword: 'xychart-beta', description: MERMAID_DIAGRAM_TYPES['XY Chart'].description };
  }
  if (lower.includes('matrix') || lower.includes('quadrant') || lower.includes('prioritization')) {
    return { name: 'Quadrant Chart', keyword: 'quadrantChart', description: MERMAID_DIAGRAM_TYPES['Quadrant Chart'].description };
  }
  if (lower.includes('timeline') || lower.includes('chronolog') || lower.includes('history') || lower.includes('postmortem')) {
    return { name: 'Timeline', keyword: 'timeline', description: MERMAID_DIAGRAM_TYPES.Timeline.description };
  }
  if (lower.includes('kanban') || lower.includes('wip') || lower.includes('task board')) {
    return { name: 'Kanban', keyword: 'kanban', description: MERMAID_DIAGRAM_TYPES.Kanban.description };
  }
  // Default to Flowchart
  return { name: 'Flowchart', keyword: 'flowchart', description: MERMAID_DIAGRAM_TYPES.Flowchart.description };
}

export type DocAudience = 'public' | 'dev';

export interface DocAudienceResult {
  audience: DocAudience;
  recommendedDiagrams: string[];
  rationale: string;
}

export interface DocSchematic {
  filePath: string;
  audience: DocAudience;
  existingDiagrams: Array<{ keyword: string; name?: string; line: number }>;
  missingDiagrams: Array<{ name: string; keyword: string; reason: string }>;
  summary: string;
}

/**
 * Classifies documentation files from an SDLC perspective into 'public' vs 'dev'.
 * Public docs emphasize UX flow, getting started, and overall architecture.
 * Dev docs emphasize contracts, protocols, internal state lifecycles, and AST/symbol relationships.
 */
export function classifyDocAudience(filePath: string, content: string): DocAudienceResult {
  const normPath = filePath.replace(/\\/g, '/').toLowerCase();
  const lowerContent = content.toLowerCase();

  // Pattern checks for public-facing docs
  const isPublicPath =
    normPath.endsWith('readme.md') ||
    normPath.includes('/setup.md') ||
    normPath.endsWith('setup.md') ||
    normPath.includes('/contributing.md') ||
    normPath.endsWith('contributing.md') ||
    normPath.includes('agentic-prompts.md') ||
    normPath.includes('guide.md') ||
    normPath.includes('quickstart') ||
    normPath.includes('getting-started');

  // Pattern checks for developer/internal docs
  const isDevPath =
    normPath.includes('mcp-development.md') ||
    normPath.includes('gemini.md') ||
    normPath.includes('agents.md') ||
    normPath.includes('/adr/') ||
    normPath.includes('internal') ||
    normPath.includes('architecture.md') ||
    normPath.includes('contributing_dev.md');

  // Content keywords
  const publicSignals = (lowerContent.match(/\b(user|install|getting started|overview|quickstart|workflow|prompt|public api|journey)\b/g) || []).length;
  const devSignals = (lowerContent.match(/\b(ipc|handshake|ast-grep|contract|fsm|protocol|state machine|packet|socket|schema|table|symbol|lifecycle)\b/g) || []).length;

  if (isDevPath || (devSignals > publicSignals && !isPublicPath)) {
    return {
      audience: 'dev',
      recommendedDiagrams: ['sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'packet-beta', 'erDiagram'],
      rationale: 'Developer-facing document modeling protocol handshakes, internal lifecycles, and interface contracts.',
    };
  }

  return {
    audience: 'public',
    recommendedDiagrams: ['flowchart', 'journey', 'C4Context', 'gantt', 'architecture-beta'],
    rationale: 'Public-facing document emphasizing onboarding, user journeys, workflows, and system context.',
  };
}

/**
 * Generates a concise documentation schematic deterministically without requiring an LLM.
 */
export function generateDocSchematic(filePath: string, content: string): DocSchematic {
  const audienceInfo = classifyDocAudience(filePath, content);
  const rawBlocks = extractMermaidBlocks(content);
  const existingDiagrams = rawBlocks.map(b => ({
    keyword: b.detectedKeyword || 'unknown',
    name: b.diagramName,
    line: b.line,
  }));

  const missingDiagrams: Array<{ name: string; keyword: string; reason: string }> = [];

  // Check if doc mentions architectures, protocols, or lifecycles but has no matching diagrams
  const discussesArchitecture = /(architecture|lifecycle|workflow|routing|pipeline|protocol|handshake|state machine|schema|database|table|roadmap|schedule|journey|onboarding|network|packet|benchmark|latency|metric|prioritization|incident|postmortem|kanban|sprint)/i.test(content);
  if (discussesArchitecture && existingDiagrams.length === 0) {
    const suggested = classifyDiagramIntent(content);
    missingDiagrams.push({
      name: suggested.name,
      keyword: suggested.keyword,
      reason: `Document discusses ${suggested.keyword} concepts without visual architectural representation.`,
    });
  }

  const summary = `[${audienceInfo.audience.toUpperCase()}] ${filePath}: ${existingDiagrams.length} diagram(s) found; ${missingDiagrams.length} recommended.`;

  return {
    filePath,
    audience: audienceInfo.audience,
    existingDiagrams,
    missingDiagrams,
    summary,
  };
}
