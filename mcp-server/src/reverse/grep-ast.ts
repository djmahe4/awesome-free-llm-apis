import path from 'node:path';
import { GithubRepoScanner } from '../utils/GithubRepoScanner.js';

export interface SymbolNode {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'route' | 'method';
  line: number;
  params?: string[];
  exported?: boolean;
}

export interface DangerousSinkNode {
  sink: string;
  line: number;
  snippet: string;
}

export interface AstAnalysisResult {
  filePath: string;
  language: string;
  symbols: SymbolNode[];
  dangerousSinks: DangerousSinkNode[];
  callFlows: string[];
  flags: string[];
  dependencies?: string[];
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'try', 'return', 'await',
  'import', 'export', 'expect', 'describe', 'it', 'get', 'set',
  'constructor', 'else', 'sizeof', 'typeof', 'super', 'print',
  'require', 'new', 'function', 'class', 'def', 'from', 'as', 'with',
  'yield', 'throw', 'finally', 'case', 'default', 'break', 'continue'
]);

const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'use', 'all']);

function findJsClosingBrace(code: string, start: number): number {
  let depth = 0;
  let seenOpenBrace = false;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let c = start; c < code.length; c++) {
    const ch = code[c];
    const prev = c > start ? code[c - 1] : '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '/' && prev === '*') inBlockComment = false;
      continue;
    }
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }

    if (ch === '/' && c + 1 < code.length && code[c + 1] === '/') {
      inLineComment = true;
      c++;
      continue;
    }
    if (ch === '/' && c + 1 < code.length && code[c + 1] === '*') {
      inBlockComment = true;
      c++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') {
      depth++;
      seenOpenBrace = true;
    } else if (ch === '}') {
      depth--;
      if (seenOpenBrace && depth === 0) {
        let after = c + 1;
        while (after < code.length && (code[after] === ')' || code[after] === ';' || code[after] === ' ' || code[after] === '\t')) {
          after++;
        }
        return after;
      }
    }
  }
  return -1;
}

export function extractSymbolsAndFlow(filePath: string, code: string): AstAnalysisResult {
  const ext = path.extname(filePath).toLowerCase();
  const lines = code.split(/\r?\n/);
  const symbols: SymbolNode[] = [];
  const dangerousSinks: DangerousSinkNode[] = [];
  const callFlows: string[] = [];
  const flags: string[] = [];

  const base = GithubRepoScanner.analyzeCode(code);
  for (const fl of base.flags) {
    if (!flags.includes(fl)) flags.push(fl);
  }

  const isJsTs = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  const isPy = ext === '.py';
  const lang = isJsTs ? 'typescript' : isPy ? 'python' : ext.replace('.', '') || 'unknown';

  const lineOffsets: number[] = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(pos);
    pos += lines[i].length;
    if (pos < code.length && code[pos] === '\r') pos++;
    if (pos < code.length && code[pos] === '\n') pos++;
  }

  const funcPositions: { name: string; line: number; index: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

    // Dangerous Sinks
    const sinkMatch = /\b(eval|exec|Function|child_process|system|popen|spawn)\s*\(/.exec(line);
    if (sinkMatch) {
      dangerousSinks.push({
        sink: sinkMatch[1],
        line: i + 1,
        snippet: trimmed.slice(0, 80),
      });
    }

    if (isJsTs) {
      const classMatch = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/.exec(line);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          line: i + 1,
          exported: /export\s+/.test(line),
        });
      }

      const ifaceMatch = /^\s*(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/.exec(line);
      if (ifaceMatch) {
        symbols.push({
          name: ifaceMatch[1],
          kind: 'interface',
          line: i + 1,
          exported: /export\s+/.test(line),
        });
      }

      const funcMatch = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([a-zA-Z0-9_$]+)?\s*\(([^)]*)\)/.exec(line);
      if (funcMatch && funcMatch[1]) {
        symbols.push({
          name: funcMatch[1],
          kind: 'function',
          line: i + 1,
          params: funcMatch[2].split(',').map(s => s.trim()).filter(Boolean),
          exported: /export\s+/.test(line),
        });
        funcPositions.push({ name: funcMatch[1], line: i + 1, index: lineOffsets[i] });
      }

      const arrowMatch = /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/.exec(line);
      if (arrowMatch) {
        symbols.push({
          name: arrowMatch[1],
          kind: 'function',
          line: i + 1,
          params: arrowMatch[2].split(',').map(s => s.trim()).filter(Boolean),
          exported: /export\s+/.test(line),
        });
        funcPositions.push({ name: arrowMatch[1], line: i + 1, index: lineOffsets[i] });
      }

      const methodMatch = /^\s*(?:(?:public|private|protected|static|async)\s+)*([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*[^={;]+)?\s*\{/.exec(line);
      if (methodMatch && !KEYWORDS.has(methodMatch[1])) {
        if (!symbols.some(s => s.name === methodMatch[1] && s.line === i + 1)) {
          symbols.push({
            name: methodMatch[1],
            kind: 'method',
            line: i + 1,
            params: methodMatch[2].split(',').map(s => s.trim()).filter(Boolean),
          });
          funcPositions.push({ name: methodMatch[1], line: i + 1, index: lineOffsets[i] });
        }
      }

      const routeMatch = /(app|router)\.(get|post|put|delete|patch|all|use)\s*\(\s*['"]([^'"]+)['"]/.exec(line);
      if (routeMatch) {
        const routeName = `${routeMatch[2].toUpperCase()} ${routeMatch[3]}`;
        symbols.push({ name: routeName, kind: 'route', line: i + 1 });
        funcPositions.push({ name: routeName, line: i + 1, index: lineOffsets[i] });
      }
    } else if (isPy) {
      const pyClass = /^\s*class\s+([a-zA-Z0-9_$]+)/.exec(line);
      if (pyClass) {
        symbols.push({ name: pyClass[1], kind: 'class', line: i + 1 });
      }

      const pyDef = /^\s*(?:async\s+)?def\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/.exec(line);
      if (pyDef) {
        symbols.push({
          name: pyDef[1],
          kind: 'function',
          line: i + 1,
          params: pyDef[2].split(',').map(s => s.trim()).filter(Boolean),
        });
        funcPositions.push({ name: pyDef[1], line: i + 1, index: lineOffsets[i] });
      }

      const argMatch = /add_argument\s*\(\s*['"](-[a-zA-Z0-9_-]+)['"]\s*,\s*['"](--[a-zA-Z0-9_-]+)['"]/.exec(line);
      if (argMatch) {
        const flag = `${argMatch[1]}/${argMatch[2]}`;
        if (!flags.includes(flag)) flags.push(flag);
      }
    }
  }

  funcPositions.sort((a, b) => a.index - b.index);
  const functionNames = new Set(
    symbols
      .filter(s => s.kind === 'function' || s.kind === 'method')
      .map(s => s.name)
  );

  for (let i = 0; i < funcPositions.length; i++) {
    const caller = funcPositions[i];
    const start = caller.index;
    let end = i + 1 < funcPositions.length ? funcPositions[i + 1].index : code.length;

    if (i + 1 === funcPositions.length) {
      if (isJsTs) {
        const closed = findJsClosingBrace(code, start);
        if (closed !== -1) {
          end = closed;
        } else {
          for (let k = caller.line; k < lines.length; k++) {
            const l = lines[k];
            if (l.trim().length > 0 && /^[^\s]/.test(l)) {
              end = lineOffsets[k];
              break;
            }
          }
        }
      } else if (isPy) {
        const defIndent = lines[caller.line - 1].search(/\S/);
        for (let k = caller.line; k < lines.length; k++) {
          const l = lines[k];
          if (l.trim().length > 0 && !l.trim().startsWith('#')) {
            const lineIndent = l.search(/\S/);
            if (lineIndent <= defIndent) {
              end = lineOffsets[k];
              break;
            }
          }
        }
      } else {
        for (let k = caller.line; k < lines.length; k++) {
          const l = lines[k];
          if (l.trim().length > 0 && /^[^\s]/.test(l)) {
            end = lineOffsets[k];
            break;
          }
        }
      }
    }

    const block = code.substring(start, end);

    const callRegex = /(?:this\.|self\.|[a-zA-Z0-9_$]+\.)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRegex.exec(block)) !== null) {
      const callee = m[1];
      if (callee === caller.name) continue;
      if (KEYWORDS.has(callee)) continue;
      if (HTTP_VERBS.has(callee.toLowerCase())) continue;
      if (!functionNames.has(callee)) continue;
      const flow = `${caller.name} -> ${callee}`;
      if (!callFlows.includes(flow)) {
        callFlows.push(flow);
      }
    }
  }

  return {
    filePath,
    language: lang,
    symbols,
    dangerousSinks,
    callFlows,
    flags,
    dependencies: base.dependencies,
  };
}

export function formatGrepAstView(filePath: string, analysis: AstAnalysisResult): string {
  const parts: string[] = [`File: ${filePath} (${analysis.language})`];

  if (analysis.symbols.length > 0) {
    parts.push('Symbols:');
    for (const s of analysis.symbols) {
      parts.push(`  L${s.line} [${s.kind}] ${s.name}${s.params ? `(${s.params.join(', ')})` : ''}`);
    }
  }

  if (analysis.callFlows.length > 0) {
    parts.push('Call Flows:');
    for (const f of analysis.callFlows) {
      parts.push(`  ${f}`);
    }
  }

  if (analysis.dangerousSinks.length > 0) {
    parts.push('Dangerous Sinks:');
    for (const d of analysis.dangerousSinks) {
      parts.push(`  L${d.line} [${d.sink}] ${d.snippet}`);
    }
  }

  if (analysis.flags.length > 0) {
    parts.push('Flags:');
    for (const fl of analysis.flags) {
      parts.push(`  ${fl}`);
    }
  }

  return parts.join('\n');
}
