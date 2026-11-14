import crypto from 'node:crypto';
import path from 'node:path';

export interface FileOutlineSymbol {
  name: string;
  line: number;
  endLine: number;
  indent: number;
  declaration: string;
  parentId?: string;
}

export interface FileOutline {
  file: string;
  contentHash: string;
  totalLines: number;
  totalSymbols: number;
  outline: FileOutlineSymbol[];
}

export interface FileStructureNode {
  id: string;
  parent: string | null;
  kind: 'file' | 'symbol';
  filePath: string;
  name: string;
  lineStart: number;
  lineEnd: number;
  declaration?: string;
  depth: number;
}

const DECLARATIONS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^=]+)?\s*\{/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^\s*(?:(?:public|private|protected|static|final|abstract|virtual|inline|extern)\s+)*(?:class|struct|union)\s+([A-Za-z_]\w*)/,
  /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>,\[\].?]+\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub\s+)?(?:mod|trait|impl)\s+([A-Za-z_]\w*)/,
  /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/,
];

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

export function generateFileOutline(source: string, filePath = 'unknown', isTargetFile = false): FileOutline {
  const lines = source.split(/\r?\n/);
  const declarations: Array<Omit<FileOutlineSymbol, 'endLine'>> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // For non-target reference files: skip local variables inside function bodies (non-exported with indent > 0)
    // For the target file being edited: retain internal declarations so local anchors and scope are fully visible
    if (!isTargetFile && /^\s*(?:const|let|var)\s+/.test(line) && !/^\s*export\b/.test(line) && line.search(/\S/) > 0) {
      continue;
    }
    for (const pattern of DECLARATIONS) {
      const match = line.match(pattern);
      if (!match) continue;
      if (CONTROL_KEYWORDS.has(match[1])) continue;
      declarations.push({
        name: match[1],
        line: i + 1,
        indent: line.match(/^\s*/)?.[0].length ?? 0,
        declaration: line.trim(),
      });
      break;
    }
  }

  const outline: FileOutlineSymbol[] = declarations.map((symbol, index) => {
    const next = declarations[index + 1];
    const endLine = next ? next.line - 1 : lines.length;
    let parentId: string | undefined;
    for (let previous = index - 1; previous >= 0; previous--) {
      const candidate = declarations[previous];
      if (candidate.indent < symbol.indent) {
        parentId = `${filePath}#${candidate.line}:${candidate.name}`;
        break;
      }
    }
    return { ...symbol, endLine, ...(parentId ? { parentId } : {}) };
  });

  return {
    file: filePath,
    contentHash: crypto.createHash('sha256').update(source).digest('hex'),
    totalLines: lines.length,
    totalSymbols: outline.length,
    outline,
  };
}

export class FileStructureDag {
  private readonly nodesById = new Map<string, FileStructureNode>();
  private readonly fileRoots = new Map<string, string>();
  private readonly outlines = new Map<string, FileOutline>();

  updateFile(filePath: string, source: string, isTargetFile = false): FileOutline {
    const relativePath = path.normalize(filePath).replace(/\\/g, '/');
    const outline = generateFileOutline(source, relativePath, isTargetFile);
    const prior = this.outlines.get(relativePath);
    if (prior?.contentHash === outline.contentHash) return prior;
    this.removeFile(relativePath);

    const fileId = `file:${relativePath}`;
    this.nodesById.set(fileId, {
      id: fileId,
      parent: null,
      kind: 'file',
      filePath: relativePath,
      name: relativePath,
      lineStart: 1,
      lineEnd: outline.totalLines,
      depth: 0,
    });
    this.fileRoots.set(relativePath, fileId);
    const nodeBySymbol = new Map<string, FileStructureNode>();
    for (const symbol of outline.outline) {
      const id = `${relativePath}#${symbol.line}:${symbol.name}`;
      const parent = symbol.parentId ? nodeBySymbol.get(symbol.parentId) : undefined;
      const node: FileStructureNode = {
        id,
        parent: parent?.id ?? fileId,
        kind: 'symbol',
        filePath: relativePath,
        name: symbol.name,
        lineStart: symbol.line,
        lineEnd: symbol.endLine,
        declaration: symbol.declaration,
        depth: (parent?.depth ?? 0) + 1,
      };
      this.nodesById.set(id, node);
      nodeBySymbol.set(id, node);
    }
    this.outlines.set(relativePath, outline);
    return outline;
  }

  removeFile(filePath: string): void {
    const relativePath = path.normalize(filePath).replace(/\\/g, '/');
    const root = this.fileRoots.get(relativePath);
    if (!root) return;
    for (const [id, node] of this.nodesById) {
      if (id === root || node.filePath === relativePath) this.nodesById.delete(id);
    }
    this.fileRoots.delete(relativePath);
    this.outlines.delete(relativePath);
  }

  getFileOutline(filePath: string): FileOutline | undefined {
    return this.outlines.get(path.normalize(filePath).replace(/\\/g, '/'));
  }

  getNodes(filePath?: string): FileStructureNode[] {
    return Array.from(this.nodesById.values()).filter(node => !filePath || node.filePath === path.normalize(filePath).replace(/\\/g, '/'));
  }

  render(filePaths: string[], maxChars = 8000): string {
    const rows = ['[Workspace file structure]'];
    let size = rows[0].length;
    for (const filePath of filePaths) {
      const outline = this.getFileOutline(filePath);
      if (!outline) continue;
      const header = `${outline.file} (${outline.totalLines} lines)`;
      if (size + header.length + 1 > maxChars) break;
      rows.push(header);
      size += header.length + 1;
      for (const symbol of outline.outline) {
        const row = `  ${'  '.repeat(Math.max(0, Math.floor(symbol.indent / 2)))}${symbol.name} [L${symbol.line}-${symbol.endLine}]: ${symbol.declaration}`;
        if (size + row.length + 1 > maxChars) break;
        rows.push(row);
        size += row.length + 1;
      }
    }
    return rows.length > 1 ? rows.join('\n') : '';
  }
}
