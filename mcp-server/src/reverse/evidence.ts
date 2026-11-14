import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMcpDir } from '../utils/mcp-home.js';

export interface EvidenceProvenance {
  source: string;
  sha256: string;
  tool: string;
  trusted: false;
}

export interface AnalysisCoverage {
  scope: 'file' | 'directory' | 'package' | 'binary' | 'stream';
  status: 'complete' | 'partial' | 'unknown';
}

export interface AnalysisProfile {
  target?: string;
  language?: string;
  format?: string;
  sizeBytes?: number;
  lines?: number;
  timestamp?: string;
  [key: string]: unknown;
}


export interface DynamicTraceFrame {
  callsite?: string;
  functionName?: string;
  file?: string;
  line?: number;
  column?: number;
  runtimeArgs?: Record<string, unknown>;
}

export interface DynamicExecutionRecord {
  runId: string;
  timestamp: string;
  entrypoint?: string;
  exitCode?: number;
  stackTraces?: string[];
  executedFunctions?: string[];
  networkEndpointsInvoked?: string[];
  syscallsOrSideEffects?: string[];
  frames?: DynamicTraceFrame[];
}

export interface DiscrepancyRecord {
  category: 'unexecuted_static_decoy' | 'hidden_runtime_call' | 'env_divergence' | 'state_mutation' | 'trace_divergence';
  description: string;
  staticEvidence?: unknown;
  dynamicEvidence?: unknown;
  confidence: 'high' | 'medium' | 'low';
}

export interface ReverseEvidence {
  evidence_id: string;
  normalized_result: Record<string, unknown>;
  analysis_profile: AnalysisProfile;
  coverage: AnalysisCoverage;
  limitations: string[];
  list_unknowns: string[];
  dynamic_traces?: DynamicExecutionRecord[];
  discrepancies?: DiscrepancyRecord[];
  // v1 backwards-compatible fields
  observations: any[];
  derivations: any[];
  inferences: any[];
  residualUnknowns: string[];
  provenance: EvidenceProvenance;
  raw?: unknown;
}

export interface CreateEvidenceParams {
  tool: string;
  source: string;
  target?: string;
  normalizedResult?: Record<string, unknown>;
  analysisProfile?: AnalysisProfile;
  coverage?: AnalysisCoverage;
  limitations?: string[];
  unknowns?: string[];
  dynamicTraces?: DynamicExecutionRecord[];
  discrepancies?: DiscrepancyRecord[];
  observations?: any[];
  derivations?: any[];
  inferences?: any[];
  raw?: unknown;
}

const memoryEvidenceStore = new Map<string, ReverseEvidence>();
const MAX_MEMORY_EVIDENCE = 500;

function setMemoryEvidence(id: string, bundle: ReverseEvidence): void {
  if (memoryEvidenceStore.has(id)) {
    memoryEvidenceStore.delete(id);
  } else if (memoryEvidenceStore.size >= MAX_MEMORY_EVIDENCE) {
    const oldest = memoryEvidenceStore.keys().next().value;
    if (oldest) memoryEvidenceStore.delete(oldest);
  }
  memoryEvidenceStore.set(id, bundle);
}

export function clearEvidenceMemoryCache(): void {
  memoryEvidenceStore.clear();
}

export function sanitizeEvidenceId(id: string): string {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'ev-unknown';
}

export function createEvidenceBundle(params: CreateEvidenceParams): ReverseEvidence {
  const norm = params.normalizedResult || {};
  const rawData = params.raw ?? norm;
  let rawString = '';
  try {
    rawString = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
  } catch {
    rawString = String(rawData);
  }
  const sha256 = crypto.createHash('sha256').update(rawString).digest('hex');
  const evidence_id = `ev-${crypto.randomBytes(8).toString('hex')}`;

  const bundle: ReverseEvidence = {
    evidence_id,
    normalized_result: norm,
    analysis_profile: {
      timestamp: new Date().toISOString(),
      ...params.analysisProfile,
    },
    coverage: params.coverage || { scope: 'file', status: 'complete' },
    limitations: params.limitations || [],
    list_unknowns: params.unknowns || [],
    dynamic_traces: params.dynamicTraces || [],
    discrepancies: params.discrepancies || [],
    observations: params.observations || [],
    derivations: params.derivations || [],
    inferences: params.inferences || [],
    residualUnknowns: params.unknowns || [],
    provenance: {
      source: params.source,
      sha256,
      tool: params.tool,
      trusted: false,
    },
    raw: params.raw,
  };

  if (params.target) {
    bundle.analysis_profile.target = params.target;
  }

  setMemoryEvidence(evidence_id, bundle);
  return bundle;
}

export function normalizeEvidence(raw: any, meta: { tool: string; target?: string }): ReverseEvidence {
  const evidence_id = raw?.evidence_id ? sanitizeEvidenceId(raw.evidence_id) : `ev-${crypto.randomBytes(8).toString('hex')}`;
  const norm = raw?.normalized_result || (typeof raw === 'object' && raw !== null ? raw : { raw });
  let sha256 = '';
  try {
    sha256 = crypto.createHash('sha256').update(JSON.stringify(raw ?? {})).digest('hex');
  } catch {
    sha256 = crypto.createHash('sha256').update(String(raw)).digest('hex');
  }

  const bundle: ReverseEvidence = {
    evidence_id,
    normalized_result: norm,
    analysis_profile: {
      timestamp: new Date().toISOString(),
      ...(raw?.analysis_profile || {}),
    },
    coverage: { scope: 'file', status: 'complete', ...(typeof raw?.coverage === 'object' ? raw.coverage : {}) },
    limitations: raw?.limitations || [],
    dynamic_traces: Array.isArray(raw?.dynamic_traces) ? raw.dynamic_traces : [],
    discrepancies: Array.isArray(raw?.discrepancies) ? raw.discrepancies : [],
    list_unknowns: Array.isArray(raw?.list_unknowns) ? raw.list_unknowns : (Array.isArray(raw?.residualUnknowns) ? raw.residualUnknowns : (Array.isArray(raw?.unknowns) ? raw.unknowns : [])),
    observations: raw?.observations || [],
    derivations: raw?.derivations || [],
    inferences: raw?.inferences || [],
    residualUnknowns: Array.isArray(raw?.residualUnknowns) ? raw.residualUnknowns : (Array.isArray(raw?.list_unknowns) ? raw.list_unknowns : (Array.isArray(raw?.unknowns) ? raw.unknowns : [])),
    provenance: {
      source: raw?.provenance?.source || 'rea-mcp',
      sha256: raw?.provenance?.sha256 || sha256,
      tool: meta.tool || raw?.provenance?.tool || 'unknown',
      trusted: false,
    },
    raw,
  };

  if (meta.target) {
    bundle.analysis_profile.target = meta.target;
  }

  setMemoryEvidence(evidence_id, bundle);
  return bundle;
}

export function storeEvidence(bundle: ReverseEvidence, dirPath?: string): void {
  setMemoryEvidence(bundle.evidence_id, bundle);
  const targetDir = dirPath || (process.env.VITEST ? undefined : path.join(getMcpDir(), 'reverse', 'evidence'));
  if (targetDir) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, `${sanitizeEvidenceId(bundle.evidence_id)}.json`);
      fs.writeFileSync(targetFile, JSON.stringify(bundle, null, 2), 'utf-8');
    } catch {
      // Ignore disk write errors, in-memory store remains primary
    }
  }
}

export function getStoredEvidence(evidenceId: string, dirPath?: string): ReverseEvidence | null {
  if (memoryEvidenceStore.has(evidenceId)) {
    const bundle = memoryEvidenceStore.get(evidenceId)!;
    memoryEvidenceStore.delete(evidenceId);
    memoryEvidenceStore.set(evidenceId, bundle);
    return bundle;
  }
  const targetDir = dirPath || (process.env.VITEST ? undefined : path.join(getMcpDir(), 'reverse', 'evidence'));
  if (targetDir) {
    const targetFile = path.join(targetDir, `${sanitizeEvidenceId(evidenceId)}.json`);
    if (fs.existsSync(targetFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
        setMemoryEvidence(evidenceId, parsed);
        return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}


export function compareStaticAndDynamicTraces(
  staticFindings: { routes?: string[]; functions?: string[]; endpoints?: string[] },
  dynamicRecords: DynamicExecutionRecord[]
): DiscrepancyRecord[] {
  const discrepancies: DiscrepancyRecord[] = [];
  const executedFunctions = new Set<string>();
  const invokedEndpoints = new Set<string>();

  for (const run of dynamicRecords) {
    if (run.executedFunctions) {
      for (const fn of run.executedFunctions) executedFunctions.add(fn);
    }
    if (run.networkEndpointsInvoked) {
      for (const ep of run.networkEndpointsInvoked) invokedEndpoints.add(ep);
    }
  }

  if (staticFindings.functions) {
    for (const fn of staticFindings.functions) {
      if (!executedFunctions.has(fn)) {
        discrepancies.push({
          category: 'unexecuted_static_decoy',
          description: `Function "${fn}" present in static AST was never invoked in dynamic execution runs.`,
          staticEvidence: fn,
          confidence: 'medium',
        });
      }
    }
  }

  if (staticFindings.endpoints) {
    for (const ep of invokedEndpoints) {
      if (!staticFindings.endpoints.includes(ep)) {
        discrepancies.push({
          category: 'hidden_runtime_call',
          description: `Endpoint "${ep}" invoked at runtime was not found in static route definitions.`,
          dynamicEvidence: ep,
          confidence: 'high',
        });
      }
    }
  }

  return discrepancies;
}
