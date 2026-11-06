import fs from 'node:fs';
import path from 'node:path';
import { validateSafePath, type SafePathResult } from './path-safety.js';
import {
  createEvidenceBundle,
  normalizeEvidence,
  type ReverseEvidence,
} from './evidence.js';
import { defaultSessionManager } from './session-manager.js';

export const DEFAULT_JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'];

export interface LineSegmentInfo {
  line: number;
  originalLength: number;
  segmentCount: number;
  segmentSize: number;
}

export interface SegmentationMetadata {
  didSegment: boolean;
  segmentedLines: LineSegmentInfo[];
  totalSegments: number;
}

export interface JsRouteInfo {
  method: string;
  path: string;
  line?: number;
  segment?: number;
}

export interface JsSinkInfo {
  type: string;
  snippet?: string;
  line?: number;
  segment?: number;
}

export interface JsImportInfo {
  source: string;
  specifiers?: string[];
  line?: number;
  segment?: number;
}

export interface JsExportInfo {
  name: string;
  type: 'named' | 'default' | 'commonjs';
  line?: number;
  segment?: number;
}

export interface JsSecretInfo {
  type: string;
  snippet: string;
  line?: number;
  segment?: number;
}

export interface JsAnalysisNormalizedResult {
  routes: JsRouteInfo[];
  routeList: string[];
  sinks: JsSinkInfo[];
  sinkTypes: string[];
  imports: JsImportInfo[];
  exports: JsExportInfo[];
  secrets: JsSecretInfo[];
  segmentation?: SegmentationMetadata;
  summary: {
    totalRoutes: number;
    totalSinks: number;
    totalImports: number;
    totalExports: number;
    totalSecrets: number;
  };
}

export interface JsAnalyzerOptions {
  workspaceRoot?: string;
  allowedExtensions?: string[];
  maxSizeBytes?: number;
  maxLineLength?: number;
  windowSize?: number;
  windowOverlap?: number;
  reaAgentsPath?: string;
  skipProxy?: boolean;
}

function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function getLineNumber(lineOffsets: number[], charOffset: number): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineOffsets[mid] <= charOffset) {
      if (mid === lineOffsets.length - 1 || lineOffsets[mid + 1] > charOffset) {
        return mid + 1;
      }
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return 1;
}

function extractSnippet(text: string, index: number, maxLength = 60): string {
  const raw = text.slice(index, index + maxLength);
  return raw.split(/\r?\n/)[0].trim();
}

function parseSpecifiers(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
  }
  return [trimmed];
}

function getSegmentForOffset(
  line: number,
  globalIndex: number,
  lineOffsets: number[],
  lineSegmentMap: Map<number, LineSegmentInfo>
): number | undefined {
  const segInfo = lineSegmentMap.get(line);
  if (!segInfo) return undefined;
  const lineStart = lineOffsets[line - 1] ?? 0;
  const col = Math.max(0, globalIndex - lineStart);
  return Math.floor(col / segInfo.segmentSize) + 1;
}

export function analyzeJsSource(
  source: string,
  options?: {
    language?: 'javascript' | 'typescript';
    target?: string;
    windowSize?: number;
    windowOverlap?: number;
    maxLineLength?: number;
  }
): ReverseEvidence {
  const target = options?.target || 'in-memory.js';
  const language = options?.language || 'javascript';

  if (!source || source.length === 0) {
    return createEvidenceBundle({
      tool: 'analyze_javascript',
      source: 'js_static_analysis',
      target,
      normalizedResult: {
        routes: [],
        routeList: [],
        sinks: [],
        sinkTypes: [],
        imports: [],
        exports: [],
        secrets: [],
        summary: {
          totalRoutes: 0,
          totalSinks: 0,
          totalImports: 0,
          totalExports: 0,
          totalSecrets: 0,
        },
      },
      analysisProfile: {
        language,
        lines: 0,
        sizeBytes: 0,
        target,
      },
      coverage: {
        scope: 'file',
        status: 'complete',
      },
      observations: [],
      derivations: [],
    });
  }

  const lineOffsets = buildLineOffsets(source);
  const totalLines = lineOffsets.length;

  const lineSegmentMap = new Map<number, LineSegmentInfo>();
  const segmentThreshold =
    options?.maxLineLength && options.maxLineLength > 0
      ? Math.max(32, Math.floor(options.maxLineLength))
      : 4096;

  for (let i = 0; i < lineOffsets.length; i++) {
    const lineStart = lineOffsets[i];
    const lineEnd = i + 1 < lineOffsets.length ? lineOffsets[i + 1] - 1 : source.length;
    const lineLen = lineEnd - lineStart;
    if (lineLen > segmentThreshold) {
      const lineNum = i + 1;
      const segmentCount = Math.ceil(lineLen / segmentThreshold);
      lineSegmentMap.set(lineNum, {
        line: lineNum,
        originalLength: lineLen,
        segmentCount,
        segmentSize: segmentThreshold,
      });
    }
  }

  const segmentedLines = Array.from(lineSegmentMap.values());
  const segmentation: SegmentationMetadata = {
    didSegment: segmentedLines.length > 0,
    segmentedLines,
    totalSegments: segmentedLines.reduce((acc, s) => acc + s.segmentCount, 0),
  };

  const routes: JsRouteInfo[] = [];
  const sinks: JsSinkInfo[] = [];
  const imports: JsImportInfo[] = [];
  const exportsList: JsExportInfo[] = [];
  const secrets: JsSecretInfo[] = [];

  const seenRoutes = new Set<string>();
  const seenSinks = new Set<string>();
  const seenImports = new Set<string>();
  const seenExports = new Set<string>();
  const seenSecrets = new Set<string>();

  const windowSize = Math.max(options?.windowSize ?? 4096, 512);
  const windowOverlap = options?.windowOverlap ?? 256;
  const stride = Math.max(windowSize - windowOverlap, Math.floor(windowSize / 2), 256);

  // Regexes with bounded, non-backtracking constructs
  const routeMethodRegex = /\b(?:app|router|server|fastify|route|api)\.(get|post|put|delete|patch|options|head|all)\s*\(\s*['"`]([^'"`\r\n\s]+)['"`]/gi;
  const routeRouteRegex = /\brouter\.route\s*\(\s*['"`]([^'"`\r\n\s]+)['"`]\s*\)\.(get|post|put|delete|patch|options|head|all)/gi;

  const sinkPatterns: Array<{ type: string; regex: RegExp }> = [
    { type: 'eval', regex: /\beval\s*\(/g },
    { type: 'new Function', regex: /\bnew\s+Function\s*\(/g },
    { type: 'exec', regex: /\b(?:child_process\.)?(?:exec|execSync)\s*\(/g },
    { type: 'spawn', regex: /\b(?:child_process\.)?(?:spawn|spawnSync)\s*\(/g },
    { type: 'vm.runInContext', regex: /\b(?:vm\.)?runInContext\s*\(/g },
    { type: 'vm.runInNewContext', regex: /\bvm\.runInNewContext\s*\(/g },
    { type: 'vm.runInThisContext', regex: /\bvm\.runInThisContext\s*\(/g },
    { type: 'vm.compileFunction', regex: /\bvm\.compileFunction\s*\(/g },
    { type: 'vm.Script', regex: /\bvm\.Script\s*\(/g },
    { type: 'dangerouslySetInnerHTML', regex: /\bdangerouslySetInnerHTML\b/g },
  ];

  const importEsRegex = /\bimport\s+([^'"`;]+?)\s+from\s*['"`]([^'"`\r\n]+)['"`]/g;
  const importSideEffectRegex = /\bimport\s*['"`]([^'"`\r\n]+)['"`]/g;
  const importDynamicRegex = /\bimport\s*\(\s*['"`]([^'"`\r\n]+)['"`]\s*\)/g;
  const requireRegex = /\brequire\s*\(\s*['"`]([^'"`\r\n]+)['"`]\s*\)/g;

  const exportDefaultRegex = /\bexport\s+default\s+(?:(?:async\s+)?function(?:\s*\*|\*\s*)?\s+([A-Za-z_$][A-Za-z0-9_$]*)|class\s+([A-Za-z_$][A-Za-z0-9_$]*)|(?:async\s+)?function\b|class\b|([A-Za-z_$][A-Za-z0-9_$]*))?/g;
  const exportNamedDeclRegex = /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g;
  const exportNamedBlockRegex = /\bexport\s*\{\s*([^}]+)\s*\}/g;
  const exportModuleExportsRegex = /\bmodule\.exports\s*=/g;
  const exportCommonJsNamedRegex = /\bexports\.([A-Za-z0-9_$]+)\s*=/g;

  const secretPatterns: Array<{ type: string; regex: RegExp }> = [
    { type: 'jwt', regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)\b/g },
    { type: 'api_key', regex: /\b((?:sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{20,})\b/g },
    { type: 'google_api_key', regex: /\b(AIza[0-9A-Za-z-_]{30,})\b/g },
    { type: 'github_token', regex: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,})\b/g },
    {
      type: 'generic_secret',
      regex: /\b(?:api[_-]?key|secret|token|password|auth_token)\s*[:=]\s*['"`]([A-Za-z0-9_./+=@-]{16,})['"`]/gi,
    },
  ];

  for (let chunkStart = 0; chunkStart < source.length; chunkStart += stride) {
    const chunkEnd = Math.min(chunkStart + windowSize, source.length);
    const chunk = source.slice(chunkStart, chunkEnd);

    // 1. Routes
    routeMethodRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = routeMethodRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const method = m[1].toUpperCase();
      const routePath = m[2];
      const key = `${method}:${routePath}:${line}:${segment ?? 0}`;
      if (!seenRoutes.has(key)) {
        seenRoutes.add(key);
        routes.push({ method, path: routePath, line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    routeRouteRegex.lastIndex = 0;
    while ((m = routeRouteRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const routePath = m[1];
      const method = m[2].toUpperCase();
      const key = `${method}:${routePath}:${line}:${segment ?? 0}`;
      if (!seenRoutes.has(key)) {
        seenRoutes.add(key);
        routes.push({ method, path: routePath, line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    // 2. Dangerous Sinks
    for (const sinkConfig of sinkPatterns) {
      sinkConfig.regex.lastIndex = 0;
      while ((m = sinkConfig.regex.exec(chunk)) !== null) {
        const globalIndex = chunkStart + m.index;
        const line = getLineNumber(lineOffsets, globalIndex);
        const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
        const snippet = extractSnippet(source, globalIndex);
        const key = `${sinkConfig.type}:${line}:${segment ?? 0}`;
        if (!seenSinks.has(key)) {
          seenSinks.add(key);
          sinks.push({ type: sinkConfig.type, snippet, line, ...(segment !== undefined ? { segment } : {}) });
        }
      }
    }

    // 3. Imports
    importEsRegex.lastIndex = 0;
    while ((m = importEsRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const specifiers = parseSpecifiers(m[1]);
      const impSource = m[2];
      const key = `${impSource}:${line}:${segment ?? 0}`;
      if (!seenImports.has(key)) {
        seenImports.add(key);
        imports.push({ source: impSource, specifiers, line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    importSideEffectRegex.lastIndex = 0;
    while ((m = importSideEffectRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const impSource = m[1];
      const key = `${impSource}:${line}:${segment ?? 0}`;
      if (!seenImports.has(key)) {
        seenImports.add(key);
        imports.push({ source: impSource, line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    importDynamicRegex.lastIndex = 0;
    while ((m = importDynamicRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const impSource = m[1];
      const key = `${impSource}:${line}:${segment ?? 0}`;
      if (!seenImports.has(key)) {
        seenImports.add(key);
        imports.push({ source: impSource, line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    requireRegex.lastIndex = 0;
    while ((m = requireRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const impSource = m[1];
      const key = `${impSource}:${line}:${segment ?? 0}`;
      if (!seenImports.has(key)) {
        seenImports.add(key);
        imports.push({ source: impSource, line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    // 4. Exports
    exportDefaultRegex.lastIndex = 0;
    while ((m = exportDefaultRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      let expName = m[1] || m[2] || m[3] || 'default';
      if (expName === 'function' || expName === 'class' || expName === 'async') {
        expName = 'default';
      }
      const key = `${expName}:default:${line}:${segment ?? 0}`;
      if (!seenExports.has(key)) {
        seenExports.add(key);
        exportsList.push({ name: expName, type: 'default', line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    exportNamedDeclRegex.lastIndex = 0;
    while ((m = exportNamedDeclRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const expName = m[1];
      const key = `${expName}:named:${line}:${segment ?? 0}`;
      if (!seenExports.has(key)) {
        seenExports.add(key);
        exportsList.push({ name: expName, type: 'named', line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    exportNamedBlockRegex.lastIndex = 0;
    while ((m = exportNamedBlockRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const items = m[1]
        .split(',')
        .map((s) => {
          const parts = s.trim().split(/\s+as\s+/);
          return parts[parts.length - 1].trim();
        })
        .filter(Boolean);
      for (const item of items) {
        const key = `${item}:named:${line}:${segment ?? 0}`;
        if (!seenExports.has(key)) {
          seenExports.add(key);
          exportsList.push({ name: item, type: 'named', line, ...(segment !== undefined ? { segment } : {}) });
        }
      }
    }

    exportModuleExportsRegex.lastIndex = 0;
    while ((m = exportModuleExportsRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const key = `module.exports:commonjs:${line}:${segment ?? 0}`;
      if (!seenExports.has(key)) {
        seenExports.add(key);
        exportsList.push({ name: 'module.exports', type: 'commonjs', line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    exportCommonJsNamedRegex.lastIndex = 0;
    while ((m = exportCommonJsNamedRegex.exec(chunk)) !== null) {
      const globalIndex = chunkStart + m.index;
      const line = getLineNumber(lineOffsets, globalIndex);
      const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
      const expName = m[1];
      const key = `${expName}:commonjs:${line}:${segment ?? 0}`;
      if (!seenExports.has(key)) {
        seenExports.add(key);
        exportsList.push({ name: expName, type: 'commonjs', line, ...(segment !== undefined ? { segment } : {}) });
      }
    }

    // 5. Secrets
    for (const secretConfig of secretPatterns) {
      secretConfig.regex.lastIndex = 0;
      while ((m = secretConfig.regex.exec(chunk)) !== null) {
        const globalIndex = chunkStart + m.index;
        const line = getLineNumber(lineOffsets, globalIndex);
        const segment = getSegmentForOffset(line, globalIndex, lineOffsets, lineSegmentMap);
        const snippet = m[1];
        const key = `${secretConfig.type}:${snippet}:${line}:${segment ?? 0}`;
        if (!seenSecrets.has(key)) {
          seenSecrets.add(key);
          secrets.push({ type: secretConfig.type, snippet, line, ...(segment !== undefined ? { segment } : {}) });
        }
      }
    }

    if (chunkEnd >= source.length) break;
  }

  const normalizedResult: JsAnalysisNormalizedResult = {
    routes,
    routeList: routes.map((r) => `${r.method} ${r.path}`),
    sinks,
    sinkTypes: Array.from(new Set(sinks.map((s) => s.type))),
    imports,
    exports: exportsList,
    secrets,
    segmentation,
    summary: {
      totalRoutes: routes.length,
      totalSinks: sinks.length,
      totalImports: imports.length,
      totalExports: exportsList.length,
      totalSecrets: secrets.length,
    },
  };

  return createEvidenceBundle({
    tool: 'analyze_javascript',
    source: 'js_static_analysis',
    target,
    normalizedResult: normalizedResult as unknown as Record<string, unknown>,
    analysisProfile: {
      language,
      lines: totalLines,
      sizeBytes: Buffer.byteLength(source, 'utf8'),
      target,
      segmentation,
    },
    coverage: {
      scope: 'file',
      status: 'complete',
    },
    observations: [
      { routesCount: routes.length },
      { sinksCount: sinks.length },
      { importsCount: imports.length },
      { exportsCount: exportsList.length },
      { secretsCount: secrets.length },
      { segmentation: { didSegment: segmentation.didSegment, segmentedLinesCount: segmentation.segmentedLines.length } },
    ],
    derivations: [
      { detectedRoutes: normalizedResult.routeList },
      { detectedSinks: normalizedResult.sinkTypes },
      ...(segmentation.didSegment ? [{ segmentedLines: segmentation.segmentedLines }] : []),
    ],
  });
}

export async function analyzeJsFile(
  targetPath: string,
  options?: JsAnalyzerOptions
): Promise<ReverseEvidence> {
  const safeResult: SafePathResult = validateSafePath(targetPath, {
    workspaceRoot: options?.workspaceRoot,
    allowedExtensions: options?.allowedExtensions ?? DEFAULT_JS_EXTENSIONS,
    maxSizeBytes: options?.maxSizeBytes,
  });

  const ext = safeResult.extension.toLowerCase();
  const language: 'javascript' | 'typescript' =
    ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts'
      ? 'typescript'
      : 'javascript';

  // Option A: REA proxy passthrough via defaultSessionManager
  const reaPath = options?.reaAgentsPath || process.env.REA_AGENTS_PATH;
  if (reaPath && !options?.skipProxy) {
    const sessionKey = `js-analyzer:${reaPath}`;
    try {
      const proxy = await defaultSessionManager.getOrCreateSession(sessionKey, {
        command: reaPath,
      });
      if (proxy.callable.includes('analyze_javascript')) {
        const resp = await proxy.call('analyze_javascript', { target: safeResult.canonicalPath });
        if (resp && resp.text) {
          try {
            const parsed = JSON.parse(resp.text);
            return normalizeEvidence(parsed, {
              tool: 'analyze_javascript',
              target: safeResult.canonicalPath,
            });
          } catch {
            // Malformed JSON from proxy, fallback to Option B
          }
        }
      }
    } catch {
      // Degrade gracefully on error or when method not available
      await defaultSessionManager.closeSession(sessionKey).catch(() => {});
    }
  }

  // Option B: High-performance native static analysis
  const content = await fs.promises.readFile(safeResult.canonicalPath, 'utf8');

  return analyzeJsSource(content, {
    language,
    target: safeResult.canonicalPath,
    windowSize: options?.windowSize,
    windowOverlap: options?.windowOverlap,
    maxLineLength: options?.maxLineLength,
  });
}

export const analyzeJavaScript = analyzeJsFile;
