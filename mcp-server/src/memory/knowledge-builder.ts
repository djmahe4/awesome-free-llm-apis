import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

export interface ApiRule {
  id: string;
  language: string;
  extensions: string[];
  kind: 'function' | 'class' | 'interface' | 'struct' | 'method' | 'decorator' | 'variable' | 'constant' | 'env_var';
  pattern: string;
  message?: string;
  compiledRegex?: RegExp;
}

export interface ContractRule {
  id: string;
  keywords?: string[];
  patterns?: string[];
  message?: string;
}

export interface ExtractedKnowledgeNode {
  id: string;
  name: string;
  kind: 'module' | 'class' | 'struct' | 'interface' | 'function' | 'method' | 'doc' | 'concept' | 'decorator' | 'variable' | 'constant' | 'env_var';
  language: string;
  filePath: string;
  lineStart?: number;
  signature?: string;
  contracts?: string[];
  decorators?: string[];
}

export class KnowledgeRuleLoader {
  private static instance: KnowledgeRuleLoader;
  private apiRules: ApiRule[] = [];
  private contractRules: ContractRule[] = [];
  private testExcludePatterns: string[] = [];
  private rulesDir: string;

  constructor(rulesDir?: string) {
    const candidates = [
      rulesDir,
      path.join(process.cwd(), 'config', 'rules'),
      path.join(process.cwd(), 'mcp-server', 'config', 'rules'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/rules'),
    ].filter((c): c is string => typeof c === 'string' && fs.existsSync(c));

    this.rulesDir = candidates[0] || path.join(process.cwd(), 'config', 'rules');
    this.loadRules();
  }

  public static getInstance(): KnowledgeRuleLoader {
    if (!KnowledgeRuleLoader.instance) {
      KnowledgeRuleLoader.instance = new KnowledgeRuleLoader();
    }
    return KnowledgeRuleLoader.instance;
  }

  public loadRules(): void {
    if (!fs.existsSync(this.rulesDir)) return;

    // Load language-specific rules from languages/*.yaml
    const langDir = path.join(this.rulesDir, 'languages');
    if (fs.existsSync(langDir)) {
      const files = fs.readdirSync(langDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
      for (const file of files) {
        try {
          const parsed = yaml.parse(fs.readFileSync(path.join(langDir, file), 'utf8'));
          const symbols = parsed?.symbols || (Array.isArray(parsed) ? parsed : []);
          const language = parsed?.language || parsed?.name || 'unknown';
          const extensions = parsed?.extensions || [];
          if (Array.isArray(symbols)) {
            for (const r of symbols) {
              this.apiRules.push({
                id: r.id,
                language: r.language || language,
                extensions: r.extensions || extensions,
                kind: r.kind || 'function',
                pattern: r.pattern,
                message: r.message,
                compiledRegex: new RegExp(r.pattern, 'm'),
              });
            }
          }
        } catch (err) {
          console.warn(`[KnowledgeRuleLoader] Failed to parse ${file}:`, err);
        }
      }
    }

    const contractsPath = path.join(this.rulesDir, 'contracts', 'contracts.yaml');
    if (fs.existsSync(contractsPath)) {
      try {
        const parsed = yaml.parse(fs.readFileSync(contractsPath, 'utf8'));
        if (Array.isArray(parsed)) {
          this.contractRules = parsed;
        } else if (parsed && typeof parsed === 'object') {
          this.contractRules = [{ id: 'contracts', keywords: parsed.keywords, patterns: parsed.headerPatterns }];
        }
      } catch (err) {
        console.warn('[KnowledgeRuleLoader] Failed to parse contracts.yaml:', err);
      }
    }

    const testsPath = path.join(this.rulesDir, 'contracts', 'tests.yaml');
    if (fs.existsSync(testsPath)) {
      try {
        const parsed = yaml.parse(fs.readFileSync(testsPath, 'utf8'));
        if (parsed && Array.isArray(parsed.patterns)) {
          this.testExcludePatterns = parsed.patterns;
        }
      } catch (err) {
        console.warn('[KnowledgeRuleLoader] Failed to parse tests.yaml:', err);
      }
    }
  }

  public isTestFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const testKeywords = ['__tests__', '.test.', '.spec.', 'test_', '_test.'];
    return testKeywords.some(kw => normalized.includes(kw));
  }

  public extractNodesFromFile(filePath: string, content: string): ExtractedKnowledgeNode[] {
    const ext = path.extname(filePath).toLowerCase();
    const rulesForExt = this.apiRules.filter(r => r.extensions.includes(ext));
    if (rulesForExt.length === 0) return [];

    const nodes: ExtractedKnowledgeNode[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of rulesForExt) {
        if (!rule.compiledRegex) continue;
        const match = line.match(rule.compiledRegex);
        if (match) {
          const symbolName = match[1] || match[2];
          if (!symbolName) continue;

          // Search preceding lines for contracts and decorators
          const contracts: string[] = [];
          const decorators: string[] = [];
          for (let j = Math.max(0, i - 10); j < i; j++) {
            const checkLine = lines[j].trim();
            if (checkLine.startsWith('@') && !checkLine.startsWith('@contract') && !checkLine.startsWith('@pre') && !checkLine.startsWith('@post') && !checkLine.startsWith('@throws') && !checkLine.startsWith('@returns')) {
              decorators.push(checkLine);
            }
            if (checkLine.includes('@contract') || checkLine.includes('@pre') || checkLine.includes('@post') || checkLine.includes('@throws') || checkLine.includes('@returns')) {
              contracts.push(checkLine);
            }
          }

          nodes.push({
            id: `${filePath}#${symbolName}`,
            name: symbolName,
            kind: rule.kind,
            language: rule.language,
            filePath,
            lineStart: i + 1,
            signature: match[2] ? match[2].trim() : undefined,
            contracts: contracts.length > 0 ? contracts : undefined,
            decorators: decorators.length > 0 ? decorators : undefined,
          });
        }
      }
    }

    return nodes;
  }

  public getApiRules(): ApiRule[] {
    return this.apiRules;
  }

  public getContractRules(): ContractRule[] {
    return this.contractRules;
  }
}
