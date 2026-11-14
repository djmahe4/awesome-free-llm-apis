import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceDirScanner, type ScannedDb, type ScannedFile } from './dir-scanner.js';
import { FileStructureDag } from './file-outline.js';
import { reduceJson } from '../utils/json-reduce.js';
import { collapseSimilarLines } from '../utils/log-compaction.js';

export interface CodingAgentContextOptions {
  workspaceRoot: string;
  query: string;
  targetFile?: string;
  debugKeywords?: string[];
  fileOverrides?: ReadonlyMap<string, string>;
  structureDag?: FileStructureDag;
  maxChars?: number;
}

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|php|swift|kt|c|cpp|h|hpp)$/i;
// Tests reach the editor through the verify-test spec and smoke scripts only restate the task, so neither
// should spend excerpt budget that the production APIs the target depends on need.
const NON_PRODUCTION_PATH = /(?:^|\/)(?:scripts\/smoke|tests?|__tests__)\/|\.(?:test|spec)\.[a-z]+$/i;
const LIVE_DATA_EXT = /\.(?:log|json|jsonl|ndjson)$/i;
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv', 'tmp', 'temp', 'scratch', 'ca-traces', '.free-llm-mcp', '.mcp-uploads', 'checkpoints'];

const CONTEXT_STOP_WORDS = new Set([
  'and', 'also', 'any', 'are', 'but', 'for', 'from', 'has', 'have', 'not', 'the', 'this', 'that', 'use', 'with', 'you',
  'src', 'harness', 'tests', 'test', 'ts', 'js', 'json', 'file', 'files', 'reader', 'context', 'workspace', 'root',
  'source', 'current', 'live', 'target', 'implement', 'implementation', 'existing', 'required', 'only', 'within',
  'supplied', 'goal', 'code', 'api', 'export', 'exports', 'function', 'functions', 'class', 'type', 'types', 'path', 'paths',
]);

function termsFor(query: string): string[] {
  const decamel = query.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase();
  const matches = (decamel.match(/[\p{L}\p{N}_./\\-]{3,}/gu) ?? [])
    .map(term => term.replace(/[.,;:!?]+$/u, ''));
  const expanded = matches.flatMap(term => [term, ...term.split(/[\\/._-]+/u)]);
  return Array.from(new Set(expanded.filter(term => term.length >= 3 && !CONTEXT_STOP_WORDS.has(term))));
}

function scoreText(value: string, terms: string[]): number {
  const lower = value.toLowerCase();
  return terms.reduce((score, term) => score + Number(lower.includes(term)), 0);
}

function requestedSymbolNames(query: string): Set<string> {
  const names = new Set<string>();
  const qualifiedMembers = query.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g) ?? [];
  for (const reference of qualifiedMembers) names.add(reference.split('.').at(-1)!.toLowerCase());
  const calledSymbols = query.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g);
  for (const match of calledSymbols) names.add(match[1].toLowerCase());
  const namedTypes = query.match(/[A-Z][A-Za-z0-9_$]*/g) ?? [];
  for (const name of namedTypes) {
    names.add(name.toLowerCase());
    const subWords = name.replace(/([a-z\d])([A-Z])/g, '$1 $2').split(' ');
    for (const sub of subWords) if (sub.length >= 3) names.add(sub.toLowerCase());
  }
  return names;
}

function readSourcePrefix(filePath: string, maxBytes = 128 * 1024): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function relativePath(root: string, candidate: string): string | null {
  const rel = path.relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function readDataContext(filePath: string, maxChars: number, query: string, debugKeywords: string[]): string {
  try {
    const stat = fs.statSync(filePath);
    const freshnessLimitMs = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - stat.mtimeMs > freshnessLimitMs) return '';
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json' && stat.size > 16 * 1024 * 1024) return '';
    const bytes = ext === '.json' ? stat.size : Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(filePath, 'r');
    let raw: string;
    try {
      const buffer = Buffer.alloc(bytes);
      const offset = ext === '.json' ? 0 : Math.max(0, stat.size - bytes);
      const read = fs.readSync(fd, buffer, 0, bytes, offset);
      raw = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (ext === '.json') {
      const value: unknown = JSON.parse(raw);
      const matchText = JSON.stringify(value).toLowerCase();
      if (debugKeywords.length) {
        if (!debugKeywords.some(term => matchText.includes(term.toLowerCase()))) return '';
      } else if (scoreText(matchText, termsFor(query)) === 0) return '';
      const reduced = reduceJson(value, { maxChars, query }).value;
      return JSON.stringify(reduced, null, 2);
    }
    const lines = raw.split(/\r?\n/).slice(-300);
    const selected = lines.filter(line => {
      const lower = line.toLowerCase();
      if (debugKeywords.length) return debugKeywords.some(term => lower.includes(term.toLowerCase()));
      return scoreText(lower, termsFor(query)) > 0;
    });
    if (selected.length === 0) return '';
    return collapseSimilarLines(selected, { head: 3, tail: 8, maxLineChars: 500 }).join('\n').slice(0, maxChars);
  } catch {
    return '';
  }
}

function sampleDatabase(dbInfo: ScannedDb, terms: string[], budget: number): string {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbInfo.path, { readOnly: true });
    const ranked = dbInfo.tables.map(table => ({
      table,
      score: scoreText(`${table.name} ${table.columns.map(column => column.name).join(' ')}`, terms),
    })).sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name));
    const rows: string[] = [`SQLite ${dbInfo.path}`];
    for (const { table } of ranked.slice(0, 3)) {
      const quoted = `"${table.name.replace(/"/g, '""')}"`;
      const samples = db.prepare(`SELECT * FROM ${quoted} LIMIT 5`).all();
      rows.push(`Table ${table.name} (${table.rowCount} rows; ${table.columns.map(column => `${column.name} ${column.type}`).join(', ')})`);
      for (const row of samples) rows.push(JSON.stringify(row));
      const size = rows.join('\n').length;
      if (size >= budget) break;
    }
    return rows.join('\n').slice(0, budget);
  } catch {
    return '';
  } finally {
    try { db?.close(); } catch { }
  }
}

export function buildCodingAgentWorkspaceContext(options: CodingAgentContextOptions): string {
  let root: string;
  try { root = fs.realpathSync(path.resolve(options.workspaceRoot)); } catch { return ''; }
  const maxChars = options.maxChars ?? 13000;
  const terms = termsFor(`${options.query} ${options.targetFile ?? ''}`);
  const scan = new WorkspaceDirScanner(root).scanDir({
    maxDepth: 6,
    filesPerFolder: 500,
    skipDirs: SKIP_DIRS,
    budgetMs: 2500,
    mapDbs: true,
  });
  const foldersByPath = new Map(scan.folders.map(folder => [path.resolve(folder.path), folder]));
  if (options.targetFile) {
    const targetDirectory = path.resolve(root, path.dirname(options.targetFile));
    if (relativePath(root, targetDirectory) !== null) {
      try {
        const realTargetDirectory = fs.realpathSync(targetDirectory);
        if (relativePath(root, realTargetDirectory) !== null) {
          const focusedScan = new WorkspaceDirScanner(realTargetDirectory).scanDir({
            maxDepth: 2,
            filesPerFolder: 500,
            skipDirs: SKIP_DIRS,
            budgetMs: 1500,
            mapDbs: true,
          });
          for (const folder of focusedScan.folders) foldersByPath.set(path.resolve(folder.path), folder);
        }
      } catch (err) {
        // Focused scan failed or inaccessible
      }
    }
  }
  const folders = Array.from(foldersByPath.values());
  const files = folders.flatMap(folder => folder.files.map(file => ({ folder: folder.path, file })))
    .map(({ folder, file }) => ({ absolute: path.join(folder, file.name), file, rel: relativePath(root, path.join(folder, file.name)) }))
    .filter((entry): entry is { absolute: string; file: ScannedFile; rel: string } => entry.rel !== null)
    .filter(entry => {
      try { return !fs.lstatSync(entry.absolute).isSymbolicLink(); } catch { return false; }
    });

  // Guarantee that any file path explicitly referenced in query or targetFile is not omitted by scan caps
  const queryPaths = options.query.match(/(?:[a-zA-Z0-9_-]+[/\\])+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+/g) ?? [];
  for (const qp of queryPaths) {
    try {
      const abs = path.resolve(root, qp);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const rel = relativePath(root, abs);
        if (rel && !files.some(f => f.rel === rel)) {
          const stat = fs.statSync(abs);
          files.push({ absolute: abs, file: { name: path.basename(abs), size: stat.size, mtimeMs: stat.mtimeMs }, rel });
        }
      }
    } catch (err) {
      // Inaccessible extra file path
    }
  }
  const outlineDag = options.structureDag ?? new FileStructureDag();
  const targetRelative = options.targetFile
    ? relativePath(root, path.resolve(root, options.targetFile))
    : null;
  const targetDirectory = targetRelative ? path.posix.dirname(targetRelative) : null;
  const outlineCandidates = files.filter(entry => SOURCE_EXT.test(entry.rel) && !NON_PRODUCTION_PATH.test(entry.rel)).map(entry => {
    const isOtherReader = entry.rel !== targetRelative && entry.rel.endsWith('-reader.ts');
    const isTargetNeighbor = targetDirectory !== null && path.posix.dirname(entry.rel) === targetDirectory && !isOtherReader;
    const baseScore = scoreText(path.basename(entry.rel), terms);
    let sourceScore = 0;
    if (isTargetNeighbor) {
      try {
        const override = options.fileOverrides?.get(entry.rel);
        sourceScore = scoreText(override?.slice(0, 32 * 1024) ?? readSourcePrefix(entry.absolute, 32 * 1024), terms);
      } catch (err) {
        // Source prefix read error
      }
    }
    return {
      ...entry,
      score: baseScore * 15 + scoreText(entry.rel, terms) * 2 + Math.min(sourceScore, 20) + (isTargetNeighbor ? 25 : 0) + Number(entry.rel === targetRelative) * 50,
    };
  }).sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const outlineSources = new Map<string, string>();
  for (const entry of outlineCandidates.slice(0, 25)) {
    try {
      const source = options.fileOverrides?.get(entry.rel) ?? fs.readFileSync(entry.absolute, 'utf8');
      const isTarget = entry.rel === targetRelative;
      outlineDag.updateFile(entry.rel, source, isTarget);
      outlineSources.set(entry.rel, source);
    } catch (err) {
      // Outline read error
    }
  }

  const blocks: string[] = [];
  const inventory = folders.map(folder => {
    const rel = relativePath(root, folder.path) ?? '.';
    const names = folder.files.map(file => file.name).join(', ');
    return `${rel}/ (${folder.subdirs} subdirs): ${names}`;
  });

  const requestedSymbols = requestedSymbolNames(options.query);
  let addedReferencedType = true;
  while (addedReferencedType) {
    addedReferencedType = false;
    for (const [filePath, source] of outlineSources) {
      const outline = outlineDag.getFileOutline(filePath);
      if (!outline) continue;
      const sourceLines = source.split(/\r?\n/);
      for (const symbol of outline.outline) {
        if (!requestedSymbols.has(symbol.name.toLowerCase())) continue;
        const isStructuredType = /^\s*(?:export\s+)?(?:default\s+)?(?:interface|type)\b/.test(symbol.declaration);
        const declarationText = isStructuredType
          ? sourceLines.slice(symbol.line - 1, symbol.endLine).join('\n')
          : symbol.declaration;
        for (const name of declarationText.match(/[A-Z][A-Za-z0-9_$]*/g) ?? []) {
          const normalized = name.toLowerCase();
          if (requestedSymbols.has(normalized)) continue;
          requestedSymbols.add(normalized);
          addedReferencedType = true;
        }
      }
    }
  }
  const hasRequestedSymbols = Array.from(outlineSources.keys()).some(filePath =>
    outlineDag.getFileOutline(filePath)?.outline.some(symbol => requestedSymbols.has(symbol.name.toLowerCase())),
  );
  const structureCandidates = outlineCandidates.filter(entry => entry.score > 0).slice(0, 20);
  let structure: string;
  if (hasRequestedSymbols) {
    const rows = ['[Workspace file structure]'];
    let size = rows[0].length;
    for (const entry of structureCandidates) {
      const outline = outlineDag.getFileOutline(entry.rel);
      if (!outline) continue;
      const symbols = outline.outline.filter(symbol => requestedSymbols.has(symbol.name.toLowerCase()));
      if (symbols.length === 0) continue;
      const header = `${outline.file} (${outline.totalLines} lines)`;
      if (size + header.length + 1 > 3500) break;
      rows.push(header);
      size += header.length + 1;
      for (const symbol of symbols) {
        const row = `  ${'  '.repeat(Math.max(0, Math.floor(symbol.indent / 2)))}${symbol.name} [L${symbol.line}-${symbol.endLine}]: ${symbol.declaration}`;
        if (size + row.length + 1 > 3500) break;
        rows.push(row);
        size += row.length + 1;
      }
    }
    structure = rows.length > 1 ? rows.join('\n') : '';
  } else {
    structure = outlineDag.render(structureCandidates.map(entry => entry.rel), 3500);
  }
  if (structure) blocks.push(structure);

  const sourceExcerpts: string[] = [];
  const excerptCandidates = outlineCandidates.filter(candidate => candidate.score > 0 && candidate.rel !== targetRelative);
  const neighborEntries = excerptCandidates.filter(candidate => targetDirectory !== null && path.posix.dirname(candidate.rel) === targetDirectory);
  const symbolEntries = hasRequestedSymbols
    ? excerptCandidates.filter(candidate => outlineDag.getFileOutline(candidate.rel)?.outline.some(symbol => requestedSymbols.has(symbol.name.toLowerCase())))
    : excerptCandidates;
  const targetExcerptEntries = Array.from(new Set([...symbolEntries, ...neighborEntries])).slice(0, 8);
  for (const entry of targetExcerptEntries) {
    const outline = outlineDag.getFileOutline(entry.rel);
    if (!outline) continue;
    try {
      const source = options.fileOverrides?.get(entry.rel) ?? fs.readFileSync(entry.absolute, 'utf8');
      const sourceLines = source.split(/\r?\n/);
      const rankedSymbols = [...outline.outline]
        .map(symbol => {
          // Outline ranges can stop at a nested declaration; retain enough of an exact requested API
          // to show its declaration and implementation start, then rank that API above incidental matches.
          const isExported = /^\s*export\b/.test(symbol.declaration);
          const isStopCollection = /WORDS|STOP|KEYWORDS|DICTIONARY/i.test(symbol.name);
          const endLine = Math.min(sourceLines.length, Math.max(symbol.endLine, symbol.line + 4));
          const exactRequested = requestedSymbols.has(symbol.name.toLowerCase());
          // A function the goal does not name is shown as its signature only. Its body is an implementation
          // template for a similarly named function the model must write itself: traced live, a 7B copied the
          // whole of `buildThoughtDag` into `buildZedThoughtDag` (and then wrapped it) instead of following the test.
          const functionLike = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b)|=>\s*\{?\s*$/.test(symbol.declaration);
          const signatureOnly = !exactRequested && functionLike && endLine - symbol.line > 3;
          const text = signatureOnly
            ? `${symbol.declaration.trim().replace(/\{\s*$/, '').trimEnd()} { /* body omitted; call it through this signature */ }`
            : sourceLines.slice(symbol.line - 1, endLine).join('\n');
          const matchScore = isStopCollection ? 0 : scoreText(`${symbol.name} ${symbol.declaration}`, terms);
          return { symbol, text, exactRequested, score: matchScore + (isExported ? 15 : 0) + Number(exactRequested) * 30 };
        })
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score || (b.symbol.endLine - b.symbol.line) - (a.symbol.endLine - a.symbol.line));
      const excerpts: string[] = [];
      let chars = 0;
      const requested = rankedSymbols.filter(entry => entry.exactRequested);
      const hasExactInFile = rankedSymbols.some(entry => entry.exactRequested);
      const additional = hasExactInFile
        ? []
        : rankedSymbols.filter(entry => !entry.exactRequested).slice(0, 4);
      for (const { symbol, text } of [...requested, ...additional]) {
        const remaining = 1800 - chars;
        if (!text || remaining <= 80) continue;
        const excerpt = text.length > remaining ? `${text.slice(0, remaining)}\n[excerpt truncated]` : text;
        excerpts.push(`// ${symbol.name} [L${symbol.line}-${symbol.endLine}]\n${excerpt}`);
        chars += excerpt.length;
      }
      if (excerpts.length) sourceExcerpts.push(`[Current source excerpts: ${entry.rel}]\n${excerpts.join('\n\n')}`);
    } catch (err) {
      // Excerpt extract error
    }
  }
  if (sourceExcerpts.length) blocks.push(...sourceExcerpts);

  const freshnessLimitMs = 30 * 24 * 60 * 60 * 1000;
  const debugKeywords = (options.debugKeywords ?? []).map(keyword => keyword.trim()).filter(Boolean);
  const smokeTaskFixture = /(?:^|\/)scripts\/smoke\/coding-agents-tasks\/[^/]+\/task\.json$/i;
  const liveFiles = files.filter(entry => LIVE_DATA_EXT.test(entry.rel)
    && Date.now() - entry.file.mtimeMs <= freshnessLimitMs
    && !smokeTaskFixture.test(entry.rel)).map(entry => ({
    ...entry,
    score: scoreText(entry.rel, terms) + Number(entry.rel === options.targetFile) * 20,
  })).sort((a, b) => b.score - a.score || b.file.mtimeMs - a.file.mtimeMs);
  const query = `${options.query} ${debugKeywords.join(' ')}`;
  for (const entry of liveFiles.slice(0, 30)) {
    const data = readDataContext(entry.absolute, 1800, query, debugKeywords);
    if (data) blocks.push(`[Live file: ${entry.rel}; updated ${new Date(entry.file.mtimeMs).toISOString()}]\n${data}`);
    if (blocks.filter(block => block.startsWith('[Live file:')).length >= 4) break;
  }

  const dbs = folders.flatMap(folder => (folder.dbs ?? []).map(db => ({ db, rel: relativePath(root, db.path) })))
    .filter((entry): entry is { db: ScannedDb; rel: string } => entry.rel !== null)
    .map(entry => ({ ...entry, score: scoreText(`${entry.rel} ${entry.db.tables.map(table => table.name).join(' ')}`, terms) }))
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  for (const entry of dbs.filter(item => item.score > 0).slice(0, 2)) {
    const data = sampleDatabase(entry.db, terms, 3000);
    if (data) blocks.push(`[Live database sample; values preserved: ${entry.rel}]\n${data}`);
  }
  if (inventory.length) {
    const text = inventory.join('\n');
    const clipped = text.length > 1800 ? `${text.slice(0, 1800)}\n[inventory truncated]` : text;
    blocks.push(`[Live workspace inventory${scan.truncated ? '; scan truncated' : ''}]\n${clipped}`);
  }

  const output: string[] = ['[Coding-agent blackboard: live workspace context; prefer this over stale documentation]'];
  let used = output[0].length;
  for (const block of blocks) {
    if (used + block.length + 2 > maxChars) {
      const remaining = maxChars - used - 2;
      if (remaining > 100) output.push(`${block.slice(0, remaining)}\n[context budget reached]`);
      break;
    }
    output.push(block);
    used += block.length + 2;
  }
  return output.length > 1 ? output.join('\n\n') : '';
}
