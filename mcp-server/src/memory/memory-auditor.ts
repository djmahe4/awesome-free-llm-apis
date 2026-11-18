import fs from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeRuleLoader, type ExtractedKnowledgeNode } from './knowledge-builder.js';
import { getDiskSymbolDb, type DiskSymbolDb } from './disk-symbol-db.js';
import { memoryManager } from './index.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { extractMermaidBlocks, classifyDiagramIntent, sanitizeMermaidCode, MERMAID_DIAGRAM_TYPES } from './mermaid-classifier.js';
import { auditAndPromoteSafePractices, type SafePracticesAuditResult } from './safe-practices.js';
import { LocalModelLock } from '../utils/local-model-lock.js';
import { extractDynamicWorkspaceContext } from './workspace-context.js';
import { DocsSchemaManager, type SchemaAuditResult } from './docs-schema-manager.js';

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
    skillDrift?: Array<{ skillFile: string; brokenSymbol: string; reason: string }>;
    schemaViolations?: Array<{ codePath: string; docPath: string; type: string; reason: string }>;
  };
  suggestedActions: Array<{ action: string; reason: string; payload?: any }>;
  schemaAudit?: SchemaAuditResult;
  safePractices?: SafePracticesAuditResult;
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

      // Check comments and contracts (contracts apply strictly to callable functions and methods)
      for (const node of extractedNodes) {
        if (node.kind === 'function' || node.kind === 'method') {
          if (!node.contracts || node.contracts.length === 0) {
            report.commentAudit.missingContracts.push({
              filePath: relPath,
              symbol: node.name,
              line: node.lineStart || 1,
              expected: ['@contract', '@returns', '@throws'],
            });
            report.suggestedActions.push({
              action: 'wiki_write',
              reason: `Document contract specifications for ${node.name} in ${relPath}`,
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
        const wsContext = await extractDynamicWorkspaceContext(workspace_root);
        const prompt = `You are a contract verification specialist for "${wsContext.name}" (${wsContext.description}). Review these audited symbols and hypothesize contracts or missing specs:\n\n${JSON.stringify({
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
            if (relPath.endsWith('.md') && (relPath.includes('skill') || relPath.includes('SKILL') || relPath.includes('AGENTS'))) {
              if (!report.docDrift.skillDrift) report.docDrift.skillDrift = [];
              report.docDrift.skillDrift.push({
                skillFile: relPath,
                brokenSymbol: sym,
                reason: `Skill or agent instruction references undefined symbol ${sym}`,
              });
            }
          }
        }
      }
    }

    // 3. Promote Safe Practices in AGENTS.md
    try {
      report.safePractices = await auditAndPromoteSafePractices(workspace_root);
      if (report.safePractices.updated) {
        report.suggestedActions.push({
          action: 'safe_practices_updated',
          reason: `Appended safe practices (${report.safePractices.practicesAppended.join(', ')}) to ${report.safePractices.filePath}`,
        });
      }
    } catch (err) {
      console.warn('[memory-auditor] Failed to audit and promote safe practices:', (err as Error)?.message || err);
    }

    // 4. Cross-reference against recorded code-to-docs schema if present
    try {
      const schemaManager = DocsSchemaManager.getInstance();
      const schemaRes = await schemaManager.auditAgainstSchema(workspace_root);
      if (schemaRes.schemaFound) {
        report.schemaAudit = schemaRes;
        if (schemaRes.violations.length > 0) {
          report.docDrift.schemaViolations = schemaRes.violations.map(v => ({
            codePath: v.codePath,
            docPath: v.docPath,
            type: v.type,
            reason: v.reason,
          }));
          report.suggestedActions.push(...schemaRes.suggestedFixes);
        }
      }
    } catch (err) {
      console.warn('[memory-auditor] Failed to audit against docs-schema.yaml:', (err as Error)?.message || err);
    }

    if (hypothesize && report.docDrift.missingArchitectureDocs.length > 0) {
      let llmEdits: Array<{ filePath: string; content: string }> | null = null;
      let hypothesisSummary = `Identified ${report.docDrift.missingArchitectureDocs.length} documentation modules missing architectural diagrams.`;
      let confidence = 0.85;

      try {
        const { useFreeLLM } = await import('../tools/use-free-llm.js');

        // Extract real content snippets from all audited documents to ground the diagram synthesis in actual repository context
        const candidateDocs = report.docDrift.missingArchitectureDocs;
        const docContexts = await Promise.all(
          candidateDocs.map(async (d) => {
            let snippet = '';
            try {
              const full = path.isAbsolute(d.module) ? d.module : path.join(workspace_root, d.module);
              const raw = await fs.readFile(full, 'utf-8');
              snippet = raw.slice(0, 3500).replace(/\r\n/g, '\n');
            } catch {}
            return {
              filePath: d.module,
              suggestedDiagram: d.suggestedDiagram,
              contentSnippet: snippet,
            };
          })
        );

        const wsContext = await extractDynamicWorkspaceContext(workspace_root);
        const prompt = `You are a software architecture documentation specialist for the workspace "${wsContext.name}" (${wsContext.description}).
Workspace summary: ${wsContext.contextSummary}

Review these documentation modules and their actual content snippets:
${JSON.stringify(docContexts, null, 2)}

For each module, generate a concise, syntactically valid Mermaid diagram that accurately models the actual concepts, protocols, components, or user flows described in the snippet.
Do not use generic placeholder participant names (e.g. do NOT use "User->>WorkflowEngine: Initiate Process"). Use the real components, modules, or actors mentioned in the document and workspace context.

Strict Mermaid Syntax Rules:
- The first line must be the diagram header with NO trailing punctuation/semicolon (e.g. "flowchart TD" or "sequenceDiagram", NEVER "graph TD;" or "sequenceDiagram;").
- In flowchart/graph diagrams: use "A -->|Label| B" for labeled transitions (never "A --> B: Label;").
- In flowchart/graph diagrams: quote labels containing spaces or special characters (e.g. Node["Label (Detail)"]).
- Do NOT use semicolons at the end of statements.

Reply with ONLY a JSON object:
{
  "summary": string,
  "confidence": number,
  "diagrams": [
    { "filePath": string, "mermaidCode": string }
  ]
}`;

        const res = await useFreeLLM({
          messages: [
            { role: 'system', content: 'You are an expert architecture documentation generator grounded in the codebase. Output ONLY JSON.' },
            { role: 'user', content: prompt }
          ],
          isOnePass: true,
          offline_only: true,
        });

        const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || '';
        const match = String(raw).match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed.diagrams) && parsed.diagrams.length > 0) {
            llmEdits = parsed.diagrams.map((d: any) => {
              const sanitized = sanitizeMermaidCode(String(d.mermaidCode || ''));
              return {
                filePath: d.filePath,
                content: `\`\`\`mermaid\n${sanitized}\n\`\`\``,
              };
            });
            hypothesisSummary = parsed.summary || hypothesisSummary;
            confidence = typeof parsed.confidence === 'number' ? parsed.confidence : confidence;
          }
        }
      } catch {}

      report.hypothesis = {
        summary: hypothesisSummary,
        confidence,
        suggestedEdits: llmEdits || report.docDrift.missingArchitectureDocs.map(d => {
          const intent = classifyDiagramIntent(d.module);
          const kw = intent.keyword.startsWith('flowchart') && !intent.keyword.includes(' ') ? `${intent.keyword} TD` : intent.keyword;
          return {
            filePath: d.module,
            content: `\`\`\`mermaid\n${kw}\n  %% Suggested diagram for ${d.module}\n\`\`\``,
          };
        }),
      };
    }

    return report;
  }

  /**
   * Remediates skill drift with local model checking and graceful cloud fallback reminder.
   */
  public async applySkillDriftRemediation(input: {
    skillContent: string;
    driftReason: string;
    workspaceRoot?: string;
    allowCloudFallback?: boolean;
    forceDeterministic?: boolean;
  }): Promise<{
    success: boolean;
    remediationType: 'deterministic_template' | 'llm_synthesis';
    patchedContent: string;
    localModelUsed: boolean;
    reminder?: string;
  }> {
    const { skillContent, driftReason, workspaceRoot = process.cwd(), allowCloudFallback = false, forceDeterministic = false } = input;
    const localLock = LocalModelLock.getInstance();
    const isModelLocked = localLock.isLocked();
    const localEndpoint = process.env.OLLAMA_LOCAL_BASE_URL || 'http://127.0.0.1:11434';
    let localReady = false;

    if (!forceDeterministic && !isModelLocked) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 600);
        const res = await fetch(`${localEndpoint}/api/tags`, { signal: controller.signal });
        clearTimeout(timer);
        localReady = res.ok;
      } catch {
        localReady = false;
      }
    }

    let llmPatched: string | null = null;
    let usedLocal = false;

    // Try local model first if ready
    if (localReady) {
      try {
        const { useFreeLLM } = await import('../tools/use-free-llm.js');
        const wsContext = await extractDynamicWorkspaceContext(workspaceRoot);
        const repoContext = `Target workspace: "${wsContext.name}" (${wsContext.description}). Available components/tools: ${wsContext.keyComponents.join(', ') || 'standard workspace tools'}.`;
        const res = await useFreeLLM({
          messages: [
            { role: 'system', content: 'You are an expert agent skill author adhering to the Agent Skills specification and grounded in the target workspace context and tools. Output ONLY the remediated markdown file.' },
            { role: 'user', content: `${repoContext}\n\nImprove this agent skill to resolve drift: ${driftReason}\n\nExisting Content:\n${skillContent}\n\nGround the examples, limitations, and output format in the actual tools and workflows of "${wsContext.name}" (${wsContext.keyComponents.slice(0, 5).join(', ') || 'workspace tools'}) rather than generic unrelated placeholders.` }
          ],
          isOnePass: true,
          offline_only: true,
        });

        const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || '';
        if (raw && raw.length > 20) {
          llmPatched = raw;
          usedLocal = true;
        }
      } catch {}
    }

    // Fall back to cloud model if local failed or was unready, and allowCloudFallback is true
    if (!llmPatched && allowCloudFallback) {
      try {
        const { executeSkill } = await import('../tools/execute-skill.js');
        const res = await executeSkill({
          skill: 'skill-writer',
          input: `Improve this skill to resolve drift: ${driftReason}\n\nContent:\n${skillContent}`,
          workspace_root: workspaceRoot,
        });

        if (res.success && (res.content || res.response)) {
          llmPatched = res.content || res.response || null;
          usedLocal = false;
        }
      } catch {}
    }

    // Post-process patched content: ensure all mandatory sections are present
    let patched = llmPatched || skillContent;
    if (!patched.startsWith('---')) {
      patched = `---\nname: agent-skill\ndescription: Remediated agent skill for ${driftReason}.\n---\n${patched}`;
    }
    if (!/#+\s*[^a-zA-Z\n]*\bWhen to Use\b/i.test(patched)) {
      patched += '\n\n## When to Use\nUse when performing related workspace tasks.';
    }
    if (!/#+\s*[^a-zA-Z\n]*\bLimitations\b/i.test(patched)) {
      patched += '\n\n## Limitations\nSee documentation for operational boundaries and rate limits.';
    }
    if (!/#+\s*[^a-zA-Z\n]*\bOutput format\b/i.test(patched)) {
      patched += '\n\n## Output format contract\n1. Summary\n2. Changes Made\n3. Validation Results\n4. Open Gaps\n';
    }

    const reminder = !localReady && !llmPatched
      ? 'Notice: Local model not detected or busy. For LLM synthesis, ensure Ollama is running or call manage_memory action:"audit_documentation" with hypothesize: true.'
      : undefined;

    return {
      success: true,
      remediationType: llmPatched ? 'llm_synthesis' : 'deterministic_template',
      patchedContent: patched,
      localModelUsed: usedLocal,
      reminder,
    };
  }
}

export interface TokenOptimizationReport {
  estimatedTokens: number;
  recommendedBudgetTokens: number;
  potentialSavingsTokens: number;
  savingsPercentage: number;
  suggestions: string[];
}

export interface SkillWriterRuleMatch {
  compliant: boolean;
  missingSections: string[];
  missingKeywords: string[];
  driftSuggestions: string[];
  lineCount?: number;
  excessiveLength?: boolean;
  unstructuredReferenceDump?: boolean;
  referencedFiles?: string[];
  unreferencedFiles?: string[];
  tokenOptimization?: TokenOptimizationReport;
}

/**
 * Deterministically checks skill files against skill-writer specifications
 * without invoking any LLM, ensuring zero-latency structural checking.
 * Enforces frontmatter, required sections, trigger coverage, line count budgets (<250 lines),
 * progressive disclosure reference structures, and token optimization recommendations.
 */
export function matchSkillWriterRules(
  skillContent: string,
  availableTools: string[] = [],
  options?: { maxLines?: number; knownReferenceFiles?: string[] }
): SkillWriterRuleMatch {
  const missingSections: string[] = [];
  const missingKeywords: string[] = [];
  const driftSuggestions: string[] = [];
  const tokenSuggestions: string[] = [];

  const maxLines = options?.maxLines ?? 250;
  const lineCount = skillContent.split('\n').length;
  const excessiveLength = lineCount > maxLines;

  // 1. YAML frontmatter check
  const hasFrontmatter = /^---\s*\n([\s\S]*?)\n---/m.test(skillContent);
  if (!hasFrontmatter) {
    missingSections.push('frontmatter');
  } else {
    const frontmatterMatch = skillContent.match(/^---\s*\n([\s\S]*?)\n---/m);
    const fm = frontmatterMatch ? frontmatterMatch[1] : '';
    if (!/name:\s*[A-Za-z0-9_-]+/i.test(fm)) {
      missingSections.push('frontmatter: name');
    }
    if (!/description:\s*.+/i.test(fm)) {
      missingSections.push('frontmatter: description');
    }
  }

  // 2. Required structural sections (allows optional emojis/badges)
  if (!/#+\s*[^a-zA-Z\n]*\bWhen to Use\b/i.test(skillContent)) {
    missingSections.push('## When to Use');
  }
  if (!/#+\s*[^a-zA-Z\n]*\bLimitations\b/i.test(skillContent)) {
    missingSections.push('## Limitations');
  }
  if (!/#+\s*[^a-zA-Z\n]*\bOutput format\b/i.test(skillContent)) {
    missingSections.push('Output format contract');
  }

  // 3. Trigger & tool coverage checks
  const lowerContent = skillContent.toLowerCase();
  for (const tool of availableTools) {
    if (!lowerContent.includes(tool.toLowerCase())) {
      missingKeywords.push(tool);
    }
  }

  // 4. Excessive line budget check (Agent Skills Design Principles)
  if (excessiveLength) {
    driftSuggestions.push(
      `Skill length (${lineCount} lines) exceeds recommended budget of ${maxLines} lines. Decompose monolithic sections into modular references under references/ to avoid context window bloat and generation failure.`
    );
  }

  // 5. References & Progressive Disclosure Analysis
  const referencedFiles = Array.from(
    new Set(Array.from(skillContent.matchAll(/references\/([a-zA-Z0-9_.-]+\.md)/gi)).map(m => m[1]))
  );

  // Check for unstructured reference link dump at end of file
  const hasRefLinkDump = /(?:##\s*[^a-zA-Z\n]*(?:References|Per-Tool Reference|Deep Dives)[\s\S]*?)(?:-\s*\[.*?\]\(references\/[^\)]+\)[\s\S]*)$/i.test(skillContent);
  const hasActionableRefTable = /\|[^\n]+\|[^\n]+\|[\s\S]*?references\//i.test(skillContent);
  const unstructuredReferenceDump = hasRefLinkDump && !hasActionableRefTable;
  if (unstructuredReferenceDump) {
    driftSuggestions.push(
      'Unstructured reference list detected at end of file. Replace flat link lists with an actionable progressive disclosure table (| Task / Capability | Reference Path |).'
    );
    tokenSuggestions.push(
      'Replace end-of-file link dump with an actionable progressive disclosure navigation matrix to allow targeted reference loading.'
    );
  }

  // Check for inline tool documentation duplication against referenced files
  for (const ref of referencedFiles) {
    const toolBase = ref.replace(/\.md$/, '');
    const toolSectionRegex = new RegExp(`###\\s*\`?${toolBase}\`?[\\s\\S]*?(?=\\n###|\\n##|$)`, 'i');
    const match = skillContent.match(toolSectionRegex);
    if (match && match[0].split('\n').length > 15) {
      tokenSuggestions.push(
        `Tool "${toolBase}" has verbose inline documentation (${match[0].split('\n').length} lines) in SKILL.md while references/${ref} exists. Delegate detailed parameters to references/${ref}.`
      );
    }
  }

  // Check for orphaned/unreferenced reference files in workspace if provided
  let unreferencedFiles: string[] | undefined;
  if (options?.knownReferenceFiles && options.knownReferenceFiles.length > 0) {
    unreferencedFiles = options.knownReferenceFiles.filter(f => !referencedFiles.includes(path.basename(f)));
    if (unreferencedFiles.length > 0) {
      driftSuggestions.push(
        `Found ${unreferencedFiles.length} unreferenced documentation file(s) in references/: ${unreferencedFiles.slice(0, 5).join(', ')}. Link them in navigation tables or archive.`
      );
    }
  }

  // 6. Token Footprint & Optimization Budgeting
  const estimatedTokens = Math.round(skillContent.length / 3.8);
  const recommendedBudgetTokens = 1200;
  const potentialSavingsTokens = Math.max(0, estimatedTokens - recommendedBudgetTokens);
  const savingsPercentage = Math.round((potentialSavingsTokens / Math.max(1, estimatedTokens)) * 100);

  if (estimatedTokens > 2000) {
    tokenSuggestions.push(
      `Estimated token footprint (~${estimatedTokens} tokens) is high for a base skill prompt. Target ~${recommendedBudgetTokens} tokens to save up to ${potentialSavingsTokens} tokens (~${savingsPercentage}%) per turn.`
    );
  }

  const tokenOptimization: TokenOptimizationReport = {
    estimatedTokens,
    recommendedBudgetTokens,
    potentialSavingsTokens,
    savingsPercentage,
    suggestions: tokenSuggestions,
  };

  if (missingSections.length > 0) {
    driftSuggestions.push(`Align sections with skill-writer specification: missing ${missingSections.join(', ')}.`);
  }

  const compliant = missingSections.length === 0 && !excessiveLength && !unstructuredReferenceDump;

  return {
    compliant,
    missingSections,
    missingKeywords,
    driftSuggestions,
    lineCount,
    excessiveLength,
    unstructuredReferenceDump,
    referencedFiles,
    unreferencedFiles,
    tokenOptimization,
  };
}

/**
 * Formats a compact markdown pill strictly under 300 characters to prevent
 * chat context bloat while keeping the user informed of doc & skill drift.
 */
export function formatCompactDriftPill(input: {
  docsCount: number;
  skillsCount: number;
  docSamples?: string[];
  skillSamples?: string[];
}): string {
  const { docsCount, skillsCount, docSamples = [], skillSamples = [] } = input;
  const docsText = docsCount > 0 ? `${docsCount} doc(s)` : '';
  const skillsText = skillsCount > 0 ? `${skillsCount} skill(s)` : '';
  const items = [docsText, skillsText].filter(Boolean).join(' & ');

  const sampleDoc = docSamples[0] ? ` (${path.basename(docSamples[0])})` : '';
  const sampleSkill = skillSamples[0] ? ` [${skillSamples[0]}]` : '';

  const pill = `💡 **Memory Drift Alert**: ${items}${sampleDoc}${sampleSkill} drifted. Run \`manage_memory action:"audit_documentation"\` or \`"resolve_workspace_lock"\` to review.`;
  return pill.slice(0, 299);
}
