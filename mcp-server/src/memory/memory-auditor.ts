import fs from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeRuleLoader, type ExtractedKnowledgeNode } from './knowledge-builder.js';
import { getDiskSymbolDb, type DiskSymbolDb } from './disk-symbol-db.js';
import { memoryManager } from './index.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { extractMermaidBlocks, classifyDiagramIntent, MERMAID_DIAGRAM_TYPES } from './mermaid-classifier.js';

export interface FileAuditCorrection {
  nodeId?: string;
  filePath: string;
  line?: number;
  change: 'update_comment' | 'add_header' | 'add_function_doc' | 'update_wiki' | 'update_skill';
  content: string;
}

export interface AuditFileInput {
  workspace_root: string;
  filePaths: string[];
  includeTests?: boolean;
  hypothesize?: boolean;
  compareGraph?: boolean;
  applyFeedback?: {
    corrections: FileAuditCorrection[];
  };
}

export interface FileAuditReport {
  success: boolean;
  filesAudited: number;
  graphDrift: {
    missingNodes: Array<{ filePath: string; symbol: string; kind?: string }>;
    staleNodes: Array<{ filePath: string; symbol: string; id: string }>;
    signatureChanges: Array<{ nodeId: string; before?: string; after?: string; filePath: string }>;
  };
  commentAudit: {
    missingFileHeaders: string[];
    missingFunctionHeaders: Array<{ filePath: string; symbol: string; line: number }>;
    missingContracts: Array<{ filePath: string; symbol: string; line: number; expected: string[] }>;
    staleComments: Array<{ filePath: string; line: number; comment: string; detail: string }>;
    counts?: {
      jsdocBlocks: number;
      singleLineComments: number;
      totalComments: number;
    };
  };
  suggestedActions: Array<{ action: string; reason: string; payload?: any }>;
  hypothesis?: {
    summary: string;
    confidence: number;
    uncertainties: string[];
    suggestedCommentUpdates: Array<{ symbol: string; comment: string; filePath: string }>;
    suggestedWikiUpdates: Array<{ page: string; section?: string; content: string }>;
  };
  metrics?: {
    hypothesizeInvoked: boolean;
    hallucinationRate: number | null;
  };
  appliedCorrections?: number;
}

export interface DocAuditCorrection {
  filePath: string;
  line?: number;
  change: 'update_doc' | 'add_header' | 'add_diagram' | 'update_skill';
  content: string;
}

export interface AuditDocInput {
  workspace_root: string;
  filePaths: string[];
  includeTests?: boolean;
  hypothesize?: boolean;
  compareGraph?: boolean;
  applyFeedback?: {
    corrections: DocAuditCorrection[];
  };
}

export interface DocAuditReport {
  success: boolean;
  docsAudited: number;
  diagramAudit: Array<{
    filePath: string;
    line: number;
    detectedKeyword?: string;
    diagramName?: string;
  }>;
  docDrift: {
    brokenSymbolReferences: Array<{ filePath: string; symbol: string; line: number }>;
    missingArchitectureDocs: Array<{ module: string; suggestedDiagram: string }>;
  };
  suggestedActions: Array<{ action: string; reason: string; payload?: any }>;
  hypothesis?: {
    summary: string;
    confidence: number;
    suggestedEdits: Array<{ filePath: string; content: string }>;
  };
  appliedCorrections?: number;
}

export class MemoryAuditor {
  private loader: KnowledgeRuleLoader;
  private scanner: WorkspaceScanner;

  constructor() {
    this.loader = KnowledgeRuleLoader.getInstance();
    this.scanner = new WorkspaceScanner(process.cwd());
  }

  public async auditFile(input: AuditFileInput): Promise<FileAuditReport> {
    const { workspace_root, filePaths, includeTests = false, hypothesize = false, compareGraph = true, applyFeedback } = input;
    const wsHash = await this.scanner.getWorkspaceHash(workspace_root);
    const diskDb = getDiskSymbolDb();

    // 1. Apply user corrections if passed
    let appliedCorrections = 0;
    if (applyFeedback?.corrections && applyFeedback.corrections.length > 0) {
      for (const corr of applyFeedback.corrections) {
        const targetPath = path.isAbsolute(corr.filePath) ? corr.filePath : path.join(workspace_root, corr.filePath);
        if (corr.change === 'update_wiki') {
          const wiki = memoryManager.getWiki(wsHash, workspace_root);
          await wiki.write(path.basename(corr.filePath, path.extname(corr.filePath)), corr.content, ['audit-correction']);
          appliedCorrections++;
        } else if (corr.change === 'add_header') {
          try {
            const existing = await fs.readFile(targetPath, 'utf-8');
            await fs.writeFile(targetPath, `${corr.content}\n${existing}`, 'utf-8');
            appliedCorrections++;
          } catch {}
        } else if (corr.change === 'update_comment' || corr.change === 'add_function_doc' || corr.change === 'update_skill') {
          try {
            if (corr.line && corr.line > 0) {
              const existing = await fs.readFile(targetPath, 'utf-8');
              const lines = existing.split('\n');
              lines.splice(corr.line - 1, 0, corr.content);
              await fs.writeFile(targetPath, lines.join('\n'), 'utf-8');
            } else {
              await fs.appendFile(targetPath, `\n${corr.content}`, 'utf-8');
            }
            appliedCorrections++;
          } catch {}
        }
      }
    }

    const report: FileAuditReport = {
      success: true,
      filesAudited: 0,
      graphDrift: {
        missingNodes: [],
        staleNodes: [],
        signatureChanges: [],
      },
      commentAudit: {
        missingFileHeaders: [],
        missingFunctionHeaders: [],
        missingContracts: [],
        staleComments: [],
        counts: {
          jsdocBlocks: 0,
          singleLineComments: 0,
          totalComments: 0,
        },
      },
      suggestedActions: [],
      metrics: {
        hypothesizeInvoked: Boolean(hypothesize),
        hallucinationRate: hypothesize ? 0 : null,
      },
      appliedCorrections,
    };

    // Filter files
    const targets = filePaths.filter(fp => {
      if (!includeTests && this.loader.isTestFile(fp)) return false;
      return true;
    });

    for (const relPath of targets) {
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workspace_root, relPath);
      let content = '';
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      report.filesAudited++;

      // Language-aware comment parsing loaded directly from expanded YAML rules
      const ext = path.extname(relPath).toLowerCase();
      const commentCfg = this.loader.getLanguageCommentConfig(ext);

      let docBlockCount = 0;
      let singleLineCount = 0;

      if (commentCfg) {
        for (const pattern of commentCfg.docBlocks) {
          try {
            const matches = content.match(new RegExp(pattern, 'gm'));
            if (matches) docBlockCount += matches.length;
          } catch {}
        }
        for (const pattern of commentCfg.singleLine) {
          try {
            const regex = new RegExp(pattern);
            singleLineCount += content.split('\n').filter(l => regex.test(l)).length;
          } catch {}
        }
      } else {
        // Generic fallback when no specific language YAML config exists
        const genericBlocks = content.match(/\/\*[\s\S]*?\*\/|"""[\s\S]*?"""/g) || [];
        docBlockCount = genericBlocks.length;
        singleLineCount = content.split('\n').filter(l => l.trim().startsWith('#') || l.trim().startsWith('//')).length;
      }

      if (report.commentAudit.counts) {
        report.commentAudit.counts.jsdocBlocks += docBlockCount;
        report.commentAudit.counts.singleLineComments += singleLineCount;
        report.commentAudit.counts.totalComments += (docBlockCount + singleLineCount);
      }

      // Check file header comment loaded from contracts.yaml or default regex
      const firstLines = content.split('\n').slice(0, 10).join('\n');
      const hasHeader = /\/\*[\s\S]*?\*\/|^(?:#\s*.*?\n)+|^"""[\s\S]*?"""|^\/\/[!/]/m.test(firstLines);
      if (!hasHeader) {
        report.commentAudit.missingFileHeaders.push(relPath);
      }

      // Extract symbols using YAML rules
      const extractedNodes = this.loader.extractNodesFromFile(relPath, content);

      // Check comments and contracts across functions, methods, and classes
      for (const node of extractedNodes) {
        if (node.kind === 'function' || node.kind === 'method' || node.kind === 'class' || node.kind === 'struct' || node.kind === 'interface') {
          if (!node.contracts || node.contracts.length === 0) {
            report.commentAudit.missingContracts.push({
              filePath: relPath,
              symbol: node.name,
              line: node.lineStart || 1,
              expected: node.kind === 'class' || node.kind === 'struct' || node.kind === 'interface'
                ? ['@contract', '@invariant']
                : ['@contract', '@returns', '@throws'],
            });
            report.suggestedActions.push({
              action: 'wiki_write',
              reason: `Document contract specifications for ${node.kind} ${node.name} in ${relPath}`,
              payload: { title: `Contract: ${node.name}`, symbol: node.name, filePath: relPath },
            });
          }
        }

        // Compare against canonical DiskSymbolDb
        if (compareGraph) {
          const dbNodes = diskDb.getNodesByFile(wsHash, relPath);
          const matched = dbNodes.find(n => n.id === node.id || n.id.endsWith(`#${node.name}`) || n.id.endsWith(`:${node.name}`));
          if (!matched) {
            report.graphDrift.missingNodes.push({
              filePath: relPath,
              symbol: node.name,
              kind: node.kind,
            });
          } else if (matched.signature && node.signature && matched.signature !== node.signature) {
            report.graphDrift.signatureChanges.push({
              nodeId: matched.id,
              before: matched.signature,
              after: node.signature,
              filePath: relPath,
            });
            report.suggestedActions.push({
              action: 'node_review',
              reason: `Signature drift on ${matched.id}: '${matched.signature}' -> '${node.signature}'`,
            });
          }
        }
      }
    }

    // 2. Local-model hypothesis loop
    if (hypothesize && (report.commentAudit.missingContracts.length > 0 || report.graphDrift.missingNodes.length > 0)) {
      try {
        const { useFreeLLM } = await import('../tools/use-free-llm.js');
        const prompt = `You are a contract verification specialist. Review these audited symbols and hypothesize contracts or missing specs:\n\n${JSON.stringify({
          missingContracts: report.commentAudit.missingContracts.slice(0, 5),
          missingNodes: report.graphDrift.missingNodes.slice(0, 5),
        }, null, 2)}\n\nReply with ONLY a JSON object: {"summary": string, "confidence": number, "uncertainties": string[], "suggestedCommentUpdates": [{"symbol": string, "comment": string, "filePath": string}], "suggestedWikiUpdates": [{"page": string, "content": string}]}`;

        const res = await useFreeLLM({
          messages: [
            { role: 'system', content: 'You are an expert contract auditor. Output ONLY JSON.' },
            { role: 'user', content: prompt }
          ],
          isOnePass: true,
          offline_only: true, // Respect offline-only guard from PR1
        });

        const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || '';
        const match = String(raw).match(/\{[\s\S]*\}/);
        if (match) {
          report.hypothesis = JSON.parse(match[0]);
        }
      } catch (err: any) {
        report.hypothesis = {
          summary: `Local hypothesis skipped or offline: ${err?.message || err}`,
          confidence: 0.5,
          uncertainties: ['Local model offline or unconfigured'],
          suggestedCommentUpdates: [],
          suggestedWikiUpdates: [],
        };
      }
    }

    return report;
  }

  public async auditDocumentation(input: AuditDocInput): Promise<DocAuditReport> {
    const { workspace_root, filePaths, includeTests = false, hypothesize = false, compareGraph = true, applyFeedback } = input;
    const wsHash = await this.scanner.getWorkspaceHash(workspace_root);
    const diskDb = getDiskSymbolDb();

    // 1. Apply user documentation corrections if passed
    let appliedCorrections = 0;
    if (applyFeedback?.corrections && applyFeedback.corrections.length > 0) {
      for (const corr of applyFeedback.corrections) {
        const targetPath = path.isAbsolute(corr.filePath) ? corr.filePath : path.join(workspace_root, corr.filePath);
        if (corr.change === 'update_doc' || corr.change === 'update_skill') {
          try {
            await fs.writeFile(targetPath, corr.content, 'utf-8');
            appliedCorrections++;
          } catch {}
        } else if (corr.change === 'add_header') {
          try {
            const existing = await fs.readFile(targetPath, 'utf-8');
            await fs.writeFile(targetPath, `${corr.content}\n${existing}`, 'utf-8');
            appliedCorrections++;
          } catch {}
        } else if (corr.change === 'add_diagram') {
          try {
            await fs.appendFile(targetPath, `\n\n\`\`\`mermaid\n${corr.content}\n\`\`\`\n`, 'utf-8');
            appliedCorrections++;
          } catch {}
        }
      }
    }

    const report: DocAuditReport = {
      success: true,
      docsAudited: 0,
      diagramAudit: [],
      docDrift: {
        brokenSymbolReferences: [],
        missingArchitectureDocs: [],
      },
      suggestedActions: [],
      appliedCorrections,
    };

    const targets = filePaths.filter(fp => {
      if (!includeTests && this.loader.isTestFile(fp)) return false;
      return true;
    });

    // Cache all nodes once to avoid O(N * M) redundant table scans
    const allDbNodes = compareGraph ? diskDb.getAllNodes(wsHash) : [];

    for (const relPath of targets) {
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workspace_root, relPath);
      let content = '';
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      report.docsAudited++;

      // 1. Audit Mermaid diagrams
      const diagrams = extractMermaidBlocks(content);
      for (const diag of diagrams) {
        report.diagramAudit.push({
          filePath: relPath,
          line: diag.line,
          detectedKeyword: diag.detectedKeyword,
          diagramName: diag.diagramName,
        });
      }

      // Check if document discusses architecture without any diagram
      if (diagrams.length === 0 && /(architecture|lifecycle|workflow|routing|pipeline)/i.test(content)) {
        const intent = classifyDiagramIntent(content);
        report.docDrift.missingArchitectureDocs.push({
          module: relPath,
          suggestedDiagram: `${intent.name} (${intent.keyword})`,
        });
        report.suggestedActions.push({
          action: 'wiki_write',
          reason: `Add ${intent.name} (${intent.keyword}) to ${relPath}`,
          payload: { filePath: relPath, keyword: intent.keyword },
        });
      }

      // 2. Validate wiki [[Symbol]] or `code` references against DiskSymbolDb
      if (compareGraph) {
        const symbolRefs = Array.from(content.matchAll(/\[\[([A-Za-z0-9_.-]+)\]\]/g)).map(m => m[1]);
        for (const sym of symbolRefs) {
          const found = allDbNodes.some(n => n.id.includes(sym) || n.filePath.includes(sym));
          if (!found) {
            report.docDrift.brokenSymbolReferences.push({
              filePath: relPath,
              symbol: sym,
              line: 1,
            });
            report.suggestedActions.push({
              action: 'wiki_write',
              reason: `Resolve broken link [[${sym}]] in ${relPath}`,
            });
          }
        }
      }
    }

    if (hypothesize && report.docDrift.missingArchitectureDocs.length > 0) {
      report.hypothesis = {
        summary: `Identified ${report.docDrift.missingArchitectureDocs.length} documentation modules missing architectural diagrams.`,
        confidence: 0.85,
        suggestedEdits: report.docDrift.missingArchitectureDocs.map(d => ({
          filePath: d.module,
          content: `\`\`\`mermaid\n${classifyDiagramIntent(d.module).keyword}\n  %% Suggested diagram for ${d.module}\n\`\`\``,
        })),
      };
    }

    return report;
  }
}
