import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { WorkspaceDependencyScanner, RepositoryGraph } from '../../memory/dependency-scanner.js';
import { BoundedMap } from '../../utils/bounded-map.js';

/** Keywords to exclude from call-site detection to avoid false-positive invokes edges */
const CALL_SITE_KEYWORD_EXCLUSIONS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async',
  'const', 'let', 'var', 'class', 'import', 'export', 'require', 'this', 'super', 'console',
  'map', 'filter', 'reduce', 'forEach', 'then', 'push', 'pop', 'join', 'slice', 'split',
  'get', 'set', 'run', 'test', 'describe', 'it', 'expect', 'print', 'len', 'str', 'int', 'dict', 'list',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.kt', '.dart', '.sol'
]);

export function computeSha8(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
}

export function normalizeNodePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface CachedFileEntry {
  filePath: string;
  hash: string;
  exports: string[];
  imports: string[];
  docstring?: string;
  size: number;
}

export class SymbolGraphCache {
  private cache: BoundedMap<string, CachedFileEntry>;
  hits = 0;
  misses = 0;

  constructor(readonly limit: number = 256) {
    this.cache = new BoundedMap<string, CachedFileEntry>(limit);
  }

  get hitCount(): number {
    return this.hits;
  }

  get missCount(): number {
    return this.misses;
  }

  get size(): number {
    return this.cache.size;
  }

  computeHash(content: string): string {
    return computeSha8(content);
  }

  get(hashOrPath: string, content?: string): CachedFileEntry | undefined {
    let key = hashOrPath;
    if (content !== undefined) {
      key = this.computeHash(content);
    } else if (key.includes('#')) {
      key = key.split('#')[1];
    }
    const entry = this.cache.get(key);
    if (entry) {
      this.hits++;
      return entry;
    }
    this.misses++;
    return undefined;
  }

  set(hashOrEntry: string | CachedFileEntry, entry?: CachedFileEntry): this {
    if (typeof hashOrEntry === 'object') {
      const e = hashOrEntry;
      this.cache.set(e.hash, e);
    } else if (entry) {
      const key = entry.hash || (hashOrEntry.includes('#') ? hashOrEntry.split('#')[1] : hashOrEntry);
      this.cache.set(key, entry);
    }
    return this;
  }

  has(hashOrKey: string): boolean {
    const key = hashOrKey.includes('#') ? hashOrKey.split('#')[1] : hashOrKey;
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

export class SymbolGraph {
  workspaceRoot: string;
  graph: RepositoryGraph;
  exports: Map<string, string[]>;
  callers: Map<string, string[]>;
  fileHashes: Map<string, string>;

  constructor(
    workspaceRoot: string,
    graph: RepositoryGraph,
    exports?: Map<string, string[]>,
    callers?: Map<string, string[]>,
    fileHashes?: Map<string, string>
  ) {
    this.workspaceRoot = workspaceRoot;
    this.graph = graph;
    this.exports = exports ?? new Map();
    this.callers = callers ?? new Map();
    this.fileHashes = fileHashes ?? new Map();
  }

  getExports(filePath: string): string[] {
    const norm = normalizeNodePath(filePath);
    return this.exports.get(norm) ?? [];
  }

  getCallers(symbolOrFile: string): string[] {
    const norm = normalizeNodePath(symbolOrFile);
    const callers = new Set<string>();

    const direct = this.callers.get(symbolOrFile) || this.callers.get(norm);
    if (direct) {
      for (const c of direct) callers.add(c);
    }

    for (const edge of this.graph.getAllEdges()) {
      if (
        (edge.type === 'invokes' || edge.type === 'imports') &&
        (edge.target === norm || edge.target === symbolOrFile)
      ) {
        callers.add(edge.source);
      }
    }

    return Array.from(callers);
  }
}

export interface BuildSymbolGraphOptions {
  files?: string[] | Map<string, string> | Record<string, string>;
  cache?: SymbolGraphCache;
}

export async function buildSymbolGraph(
  workspaceRootOrFiles: string | string[] | Map<string, string> | Record<string, string>,
  filesOrOptionsOrRoot?: string | string[] | Map<string, string> | Record<string, string> | BuildSymbolGraphOptions | SymbolGraphCache,
  maybeCache?: SymbolGraphCache
): Promise<SymbolGraph> {
  let workspaceRoot: string;
  let files: string[] | Map<string, string> | Record<string, string> | undefined;
  let cache = maybeCache;

  if (typeof workspaceRootOrFiles === 'string' && typeof filesOrOptionsOrRoot !== 'string') {
    workspaceRoot = workspaceRootOrFiles;
    if (filesOrOptionsOrRoot instanceof SymbolGraphCache) {
      cache = filesOrOptionsOrRoot;
      files = undefined;
    } else if (
      filesOrOptionsOrRoot &&
      typeof filesOrOptionsOrRoot === 'object' &&
      !Array.isArray(filesOrOptionsOrRoot) &&
      !(filesOrOptionsOrRoot instanceof Map) &&
      ('files' in filesOrOptionsOrRoot || 'cache' in filesOrOptionsOrRoot)
    ) {
      const opts = filesOrOptionsOrRoot as BuildSymbolGraphOptions;
      files = opts.files;
      cache = opts.cache ?? maybeCache;
    } else if (filesOrOptionsOrRoot) {
      files = filesOrOptionsOrRoot as string[] | Map<string, string> | Record<string, string>;
    }
  } else if (typeof filesOrOptionsOrRoot === 'string') {
    workspaceRoot = filesOrOptionsOrRoot;
    files = workspaceRootOrFiles as string[] | Map<string, string> | Record<string, string>;
    cache = maybeCache;
  } else {
    workspaceRoot = typeof workspaceRootOrFiles === 'string' ? workspaceRootOrFiles : '';
    files = Array.isArray(workspaceRootOrFiles) || workspaceRootOrFiles instanceof Map ? (workspaceRootOrFiles as any) : undefined;
  }

  const repoGraph = new RepositoryGraph(workspaceRoot);
  const fileContents = new Map<string, string>();
  const fileEntries = new Map<string, CachedFileEntry>();

  // Helper to process content for a single relative file
  const processFileContent = (relPath: string, content: string) => {
    const norm = normalizeNodePath(relPath);
    const ext = path.extname(norm).toLowerCase();
    fileContents.set(norm, content);

    const hash = computeSha8(content);
    let entry = cache ? cache.get(hash) : undefined;

    if (!entry) {
      const profile = WorkspaceDependencyScanner.generateSemanticProfile(content, ext);
      entry = {
        filePath: norm,
        hash,
        exports: profile.exports,
        imports: profile.imports,
        docstring: profile.docstring,
        size: content.length,
      };
      if (cache) {
        cache.set(entry);
      }
    }

    fileEntries.set(norm, entry);
    repoGraph.addNode(norm, 'code', {
      language: ext,
      size: entry.size,
      exports: entry.exports,
      imports: entry.imports,
      hash: entry.hash,
    });

    for (const imp of entry.imports) {
      repoGraph.addEdge(norm, imp, 'imports');
    }
  };

  if (files instanceof Map) {
    for (const [p, c] of files.entries()) {
      processFileContent(p, c);
    }
  } else if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const [p, c] of Object.entries(files)) {
      processFileContent(p, c as string);
    }
  } else if (Array.isArray(files)) {
    for (const p of files) {
      const norm = normalizeNodePath(p);
      const fullPath = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        processFileContent(norm, content);
      } catch {
        // Skip unreadable files
      }
    }
  } else {
    // Collect all code files in workspaceRoot
    const collectFiles = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist', 'build', 'venv', '__pycache__'].includes(entry.name)) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await collectFiles(full);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (CODE_EXTENSIONS.has(ext)) {
            const rel = path.relative(workspaceRoot, full).replace(/\\/g, '/');
            try {
              const content = await fs.readFile(full, 'utf8');
              processFileContent(rel, content);
            } catch {
              // Skip unreadable files
            }
          }
        }
      }
    };
    await collectFiles(workspaceRoot);
  }

  // Populate exports and file hashes
  const exportsByFile = new Map<string, string[]>();
  const fileHashes = new Map<string, string>();
  for (const [normPath, entry] of fileEntries.entries()) {
    exportsByFile.set(normPath, entry.exports);
    fileHashes.set(normPath, entry.hash);
  }

  // Build symbol -> defining files index
  const symbolToDefiningFiles = new Map<string, string[]>();
  for (const [normPath, exps] of exportsByFile.entries()) {
    for (const sym of exps) {
      if (!symbolToDefiningFiles.has(sym)) {
        symbolToDefiningFiles.set(sym, []);
      }
      symbolToDefiningFiles.get(sym)!.push(normPath);
    }
  }

  // Resolve callers via call sites
  const callersBySymbol = new Map<string, string[]>();
  const callersByFile = new Map<string, string[]>();
  const combinedCallers = new Map<string, string[]>();

  const CALL_SITE_REGEX = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

  for (const [callerPath, content] of fileContents.entries()) {
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = CALL_SITE_REGEX.exec(content)) !== null) {
      const sym = match[1];
      if (CALL_SITE_KEYWORD_EXCLUSIONS.has(sym) || seen.has(sym)) continue;
      seen.add(sym);

      const definers = symbolToDefiningFiles.get(sym);
      if (!definers) continue;

      for (const defFile of definers) {
        if (defFile !== callerPath) {
          if (!callersBySymbol.has(sym)) callersBySymbol.set(sym, []);
          if (!callersBySymbol.get(sym)!.includes(callerPath)) {
            callersBySymbol.get(sym)!.push(callerPath);
          }

          if (!callersByFile.has(defFile)) callersByFile.set(defFile, []);
          if (!callersByFile.get(defFile)!.includes(callerPath)) {
            callersByFile.get(defFile)!.push(callerPath);
          }

          repoGraph.addEdge(callerPath, defFile, 'invokes');
        }
      }
    }
  }

  for (const [sym, c] of callersBySymbol.entries()) {
    combinedCallers.set(sym, c);
  }
  for (const [file, c] of callersByFile.entries()) {
    combinedCallers.set(file, c);
  }

  return new SymbolGraph(workspaceRoot, repoGraph, exportsByFile, combinedCallers, fileHashes);
}

export function buildSymbolContextBlock(
  targetOrOpts: string | { targetFile: string; symbolGraph?: SymbolGraph; graph?: SymbolGraph; maxLines?: number },
  maybeGraph?: SymbolGraph,
  options?: { maxLines?: number }
): string {
  let targetFile: string;
  let symbolGraph: SymbolGraph | undefined;
  let maxLines = 40;

  if (typeof targetOrOpts === 'string') {
    targetFile = targetOrOpts;
    symbolGraph = maybeGraph;
    if (options?.maxLines) maxLines = options.maxLines;
  } else {
    targetFile = targetOrOpts.targetFile;
    symbolGraph = targetOrOpts.symbolGraph || targetOrOpts.graph || maybeGraph;
    if (targetOrOpts.maxLines) maxLines = targetOrOpts.maxLines;
    if (options?.maxLines) maxLines = options.maxLines;
  }

  if (!symbolGraph) {
    return `[Symbol Context: ${targetFile}]\n(No symbol graph provided)`;
  }

  const normTarget = normalizeNodePath(targetFile);
  const exports = symbolGraph.getExports(normTarget);
  const callers = symbolGraph.getCallers(normTarget);

  const lines: string[] = [`[Symbol Context: ${normTarget}]`];

  if (exports.length > 0) {
    lines.push(`Exported symbols: ${exports.join(', ')}`);
  } else {
    lines.push('Exported symbols: (none)');
  }

  if (callers.length > 0) {
    lines.push(`File callers / dependents (${callers.length}):`);
    for (const caller of callers) {
      lines.push(`  - ${caller}`);
    }
  }

  const symbolCallersFound: string[] = [];
  for (const sym of exports) {
    const symCallers = symbolGraph.getCallers(sym);
    if (symCallers.length > 0) {
      symbolCallersFound.push(`  - ${sym}(): called by ${symCallers.join(', ')}`);
    }
  }
  if (symbolCallersFound.length > 0) {
    lines.push('Symbol call sites:');
    lines.push(...symbolCallersFound);
  }

  const edges = symbolGraph.graph.getEdgesFrom(normTarget);
  const imports = edges.filter(e => e.type === 'imports').map(e => e.target);
  if (imports.length > 0) {
    lines.push(`Dependencies (${imports.length}):`);
    for (const imp of imports) {
      const impExports = symbolGraph.getExports(imp);
      const expStr = impExports.length > 0 ? ` (exports: ${impExports.join(', ')})` : '';
      lines.push(`  - ${imp}${expStr}`);
    }
  }

  if (lines.length === 2 && lines[1] === 'Exported symbols: (none)' && callers.length === 0 && imports.length === 0) {
    return `[Symbol Context: ${normTarget}]\n(No exported symbols, callers, or dependencies detected)`;
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} lines truncated)`;
  }

  return lines.join('\n');
}
