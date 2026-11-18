import fs from 'node:fs/promises';
import path from 'node:path';
import { extractDynamicWorkspaceContext } from './workspace-context.js';
import { classifyDiagramIntent, classifyDocAudience, extractMermaidBlocks } from './mermaid-classifier.js';
import { LocalModelLock } from '../utils/local-model-lock.js';

export interface CodeDocsMappingEntry {
  codePath: string;
  docPath: string;
  symbols: string[];
  diagramExpected?: string;
  audience?: 'public' | 'dev';
}

export interface DocsSchemaRules {
  maxSkillLines: number;
  requireMermaidInArchDocs: boolean;
  enforceContractHeadings: boolean;
}

export interface DocsSchema {
  version: string;
  workspace: string;
  description: string;
  initializedAt?: string;
  codeDocsMapping: CodeDocsMappingEntry[];
  schematicRules: DocsSchemaRules;
}

export interface SchemaViolation {
  codePath: string;
  docPath: string;
  type: 'missing_doc' | 'missing_diagram' | 'missing_symbol_reference' | 'audience_mismatch';
  expected: string;
  actual?: string;
  reason: string;
}

export interface SchemaAuditResult {
  valid: boolean;
  schemaFound: boolean;
  violations: SchemaViolation[];
  suggestedFixes: Array<{ action: string; reason: string; payload?: any }>;
}

export class DocsSchemaManager {
  private static instance: DocsSchemaManager;

  public static getInstance(): DocsSchemaManager {
    if (!DocsSchemaManager.instance) {
      DocsSchemaManager.instance = new DocsSchemaManager();
    }
    return DocsSchemaManager.instance;
  }

  public getSchemaPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.free-llm-mcp', 'docs-schema.yaml');
  }

  public async loadSchema(workspaceRoot: string): Promise<DocsSchema | null> {
    try {
      const p = this.getSchemaPath(workspaceRoot);
      const raw = await fs.readFile(p, 'utf-8');
      return this.parseSimpleYaml(raw);
    } catch {
      return null;
    }
  }

  public async saveSchema(workspaceRoot: string, schema: DocsSchema): Promise<string> {
    const dir = path.join(workspaceRoot, '.free-llm-mcp');
    await fs.mkdir(dir, { recursive: true });
    const p = this.getSchemaPath(workspaceRoot);
    const yaml = this.serializeToYaml(schema);
    await fs.writeFile(p, yaml, 'utf-8');
    return p;
  }

  /**
   * Automatically derives a rich code-to-docs schema mapping for the workspace.
   * If a local Ollama model is available, hypothesizes preferred mapping and diagrams;
   * otherwise uses deterministic AST / file-matching heuristics.
   */
  public async generateSuggestedSchema(workspaceRoot: string, allowLocalModel = true): Promise<DocsSchema> {
    const wsContext = await extractDynamicWorkspaceContext(workspaceRoot);
    const mappings: CodeDocsMappingEntry[] = [];

    // Excluded directory names to avoid crawling dependencies, caches, and build artifacts
    const EXCLUDE_DIRS = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      '.free-llm-mcp',
      '.gemini',
      '.cache',
      'coverage',
      '.next',
      '.nuxt',
      '__pycache__',
      '.venv',
      'venv',
      'tmp',
      'temp',
    ]);

    // Source code extensions recognized across various software ecosystems
    const CODE_EXTS = new Set([
      '.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
      '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt'
    ]);

    const DOC_EXTS = new Set(['.md', '.mdx']);

    const discoveredCodeFiles: string[] = [];
    const discoveredDocs: string[] = [];

    // Completely dynamic recursive filesystem scan across the workspaceRoot
    async function scanDirectory(dir: string, currentDepth = 0, maxDepth = 6): Promise<void> {
      if (currentDepth > maxDepth) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
              await scanDirectory(path.join(dir, entry.name), currentDepth + 1, maxDepth);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const relPath = path.relative(workspaceRoot, path.join(dir, entry.name)).replace(/\\/g, '/');
            if (DOC_EXTS.has(ext)) {
              discoveredDocs.push(relPath);
            } else if (CODE_EXTS.has(ext)) {
              const lower = entry.name.toLowerCase();
              if (!lower.includes('.test.') && !lower.includes('.spec.') && !lower.endsWith('.d.ts')) {
                discoveredCodeFiles.push(relPath);
              }
            }
          }
        }
      } catch {}
    }

    await scanDirectory(workspaceRoot);

    // Dynamically map discovered code files to docs based on normalized name/slug alignment
    for (const code of discoveredCodeFiles) {
      const baseName = path.basename(code).replace(/\.[^/.]+$/, '').toLowerCase().replace(/[-_]/g, '');
      if (baseName.length < 3) continue;

      const matchedDoc = discoveredDocs.find(d => {
        const docBase = path.basename(d).replace(/\.[^/.]+$/, '').toLowerCase().replace(/[-_]/g, '');
        return docBase === baseName || docBase.includes(baseName) || baseName.includes(docBase);
      });

      if (matchedDoc) {
        let expectedDiagram = 'flowchart TD';
        const lowerCode = code.toLowerCase();
        if (lowerCode.includes('execute') || lowerCode.includes('proxy') || lowerCode.includes('dispatch') || lowerCode.includes('action')) {
          expectedDiagram = 'sequenceDiagram';
        } else if (lowerCode.includes('agents') || lowerCode.includes('harness') || lowerCode.includes('state') || lowerCode.includes('lifecycle')) {
          expectedDiagram = 'stateDiagram-v2';
        } else if (lowerCode.includes('schema') || lowerCode.includes('model') || lowerCode.includes('db') || lowerCode.includes('entity')) {
          expectedDiagram = 'classDiagram';
        } else {
          expectedDiagram = 'flowchart TD';
        }

        mappings.push({
          codePath: code,
          docPath: matchedDoc,
          symbols: [path.basename(code).replace(/\.[^/.]+$/, '')],
          diagramExpected: expectedDiagram,
          audience: matchedDoc.includes('reference') || matchedDoc.includes('internal') || matchedDoc.includes('api') ? 'dev' : 'public',
        });
      }
    }

    // If local model is available and enabled, hypothesize enhancements
    if (allowLocalModel && mappings.length > 0) {
      try {
        const localLock = LocalModelLock.getInstance();
        if (!localLock.isLocked()) {
          const { useFreeLLM } = await import('../tools/use-free-llm.js');
          const prompt = `You are a software architecture specialist. Review these code-to-docs mappings for workspace "${wsContext.name}":
${JSON.stringify(mappings.slice(0, 5), null, 2)}
Suggest any additional symbols or refined expected diagrams (flowchart TD, sequenceDiagram, stateDiagram-v2, classDiagram). Output ONLY JSON:
{"mappings": [{"codePath": string, "docPath": string, "symbols": string[], "diagramExpected": string}]}`;

          const res = await useFreeLLM({
            messages: [{ role: 'user', content: prompt }],
            isOnePass: true,
            offline_only: true,
          });

          const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || '';
          const match = String(raw).match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (Array.isArray(parsed.mappings) && parsed.mappings.length > 0) {
              for (const m of parsed.mappings) {
                const existing = mappings.find(ex => ex.codePath === m.codePath);
                if (existing) {
                  if (Array.isArray(m.symbols)) existing.symbols = Array.from(new Set([...existing.symbols, ...m.symbols]));
                  if (m.diagramExpected) existing.diagramExpected = m.diagramExpected;
                }
              }
            }
          }
        }
      } catch {}
    }

    return {
      version: '1.0.0',
      workspace: wsContext.name,
      description: wsContext.description,
      initializedAt: new Date().toISOString(),
      codeDocsMapping: mappings,
      schematicRules: {
        maxSkillLines: 250,
        requireMermaidInArchDocs: true,
        enforceContractHeadings: true,
      },
    };
  }

  /**
   * Audits actual codebase and documentation against the recorded docs-schema.yaml.
   */
  public async auditAgainstSchema(workspaceRoot: string): Promise<SchemaAuditResult> {
    const schema = await this.loadSchema(workspaceRoot);
    if (!schema) {
      return {
        valid: false,
        schemaFound: false,
        violations: [
          {
            codePath: workspaceRoot,
            docPath: '.free-llm-mcp/docs-schema.yaml',
            type: 'missing_doc',
            expected: 'docs-schema.yaml',
            reason: 'Workspace lock active: no code-to-docs schema map found. Run manage_memory with action:"resolve_workspace_lock" to initialize.',
          },
        ],
        suggestedFixes: [
          {
            action: 'init_docs_schema',
            reason: 'Initialize .free-llm-mcp/docs-schema.yaml from workspace scan and local model.',
          },
        ],
      };
    }

    const violations: SchemaViolation[] = [];
    const suggestedFixes: Array<{ action: string; reason: string; payload?: any }> = [];

    for (const mapping of schema.codeDocsMapping) {
      const fullDoc = path.isAbsolute(mapping.docPath) ? mapping.docPath : path.join(workspaceRoot, mapping.docPath);
      let content = '';
      try {
        content = await fs.readFile(fullDoc, 'utf-8');
      } catch {
        violations.push({
          codePath: mapping.codePath,
          docPath: mapping.docPath,
          type: 'missing_doc',
          expected: `Document at ${mapping.docPath}`,
          reason: `Mapped documentation file ${mapping.docPath} for ${mapping.codePath} does not exist on disk.`,
        });
        suggestedFixes.push({
          action: 'wiki_write',
          reason: `Create missing documentation for ${mapping.codePath} at ${mapping.docPath}`,
          payload: { filePath: mapping.docPath },
        });
        continue;
      }

      // Check for expected diagram
      if (schema.schematicRules.requireMermaidInArchDocs && mapping.diagramExpected) {
        const diagrams = extractMermaidBlocks(content);
        if (diagrams.length === 0) {
          violations.push({
            codePath: mapping.codePath,
            docPath: mapping.docPath,
            type: 'missing_diagram',
            expected: mapping.diagramExpected,
            reason: `Document ${mapping.docPath} has no Mermaid diagrams, expected ${mapping.diagramExpected}.`,
          });
          suggestedFixes.push({
            action: 'add_diagram',
            reason: `Add ${mapping.diagramExpected} diagram to ${mapping.docPath}`,
            payload: { filePath: mapping.docPath, keyword: mapping.diagramExpected },
          });
        }
      }

      // Check for mapped symbol mentions
      for (const sym of mapping.symbols) {
        if (!content.includes(sym)) {
          violations.push({
            codePath: mapping.codePath,
            docPath: mapping.docPath,
            type: 'missing_symbol_reference',
            expected: `Reference to symbol "${sym}"`,
            reason: `Document ${mapping.docPath} does not mention mapped code symbol "${sym}" from ${mapping.codePath}.`,
          });
          suggestedFixes.push({
            action: 'wiki_write',
            reason: `Document symbol "${sym}" in ${mapping.docPath}`,
            payload: { filePath: mapping.docPath, symbol: sym },
          });
        }
      }
    }

    return {
      valid: violations.length === 0,
      schemaFound: true,
      violations,
      suggestedFixes,
    };
  }

  private serializeToYaml(schema: DocsSchema): string {
    const lines: string[] = [
      '# Code-to-Docs Mapping Schema for Agentic Verification',
      `version: "${schema.version}"`,
      `workspace: "${schema.workspace}"`,
      `description: "${schema.description.replace(/"/g, '\\"')}"`,
      `initializedAt: "${schema.initializedAt || new Date().toISOString()}"`,
      '',
      'schematicRules:',
      `  maxSkillLines: ${schema.schematicRules.maxSkillLines}`,
      `  requireMermaidInArchDocs: ${schema.schematicRules.requireMermaidInArchDocs}`,
      `  enforceContractHeadings: ${schema.schematicRules.enforceContractHeadings}`,
      '',
      'codeDocsMapping:',
    ];

    for (const m of schema.codeDocsMapping) {
      lines.push('  -');
      lines.push(`    codePath: "${m.codePath}"`);
      lines.push(`    docPath: "${m.docPath}"`);
      lines.push(`    symbols: [${m.symbols.map(s => `"${s}"`).join(', ')}]`);
      if (m.diagramExpected) lines.push(`    diagramExpected: "${m.diagramExpected}"`);
      if (m.audience) lines.push(`    audience: "${m.audience}"`);
    }

    return lines.join('\n') + '\n';
  }

  private parseSimpleYaml(yaml: string): DocsSchema {
    const version = yaml.match(/^version:\s*"([^"]+)"/m)?.[1] || '1.0.0';
    const workspace = yaml.match(/^workspace:\s*"([^"]+)"/m)?.[1] || 'workspace';
    const description = yaml.match(/^description:\s*"([^"]+)"/m)?.[1] || '';
    const initializedAt = yaml.match(/^initializedAt:\s*"([^"]+)"/m)?.[1];

    const maxSkillLines = parseInt(yaml.match(/maxSkillLines:\s*(\d+)/)?.[1] || '250', 10);
    const requireMermaid = (yaml.match(/requireMermaidInArchDocs:\s*(true|false)/)?.[1] || 'true') === 'true';
    const enforceContracts = (yaml.match(/enforceContractHeadings:\s*(true|false)/)?.[1] || 'true') === 'true';

    const mappings: CodeDocsMappingEntry[] = [];
    const mappingBlocks = yaml.split(/\n\s*-\s*\n/).slice(1);

    for (const block of mappingBlocks) {
      const codePath = block.match(/codePath:\s*"([^"]+)"/)?.[1];
      const docPath = block.match(/docPath:\s*"([^"]+)"/)?.[1];
      const diag = block.match(/diagramExpected:\s*"([^"]+)"/)?.[1];
      const audience = block.match(/audience:\s*"([^"]+)"/)?.[1] as any;
      const symbolsMatch = block.match(/symbols:\s*\[(.*?)\]/);
      const symbols = symbolsMatch ? symbolsMatch[1].split(',').map(s => s.replace(/["'\s]/g, '')).filter(Boolean) : [];

      if (codePath && docPath) {
        mappings.push({
          codePath,
          docPath,
          symbols,
          diagramExpected: diag,
          audience,
        });
      }
    }

    return {
      version,
      workspace,
      description,
      initializedAt,
      codeDocsMapping: mappings,
      schematicRules: {
        maxSkillLines: maxSkillLines,
        requireMermaidInArchDocs: requireMermaid,
        enforceContractHeadings: enforceContracts,
      },
    };
  }
}
