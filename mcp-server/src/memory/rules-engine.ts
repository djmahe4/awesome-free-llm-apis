import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

export interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'method' | 'class' | 'struct' | 'enum' | 'trait' | 'interface' | string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  decorators?: string[];
  visibility?: string;
  signature?: string;
  metadata?: Record<string, any>;
}

export interface DetectedSink {
  sinkType: string;
  line: number;
  matchedText?: string;
  column?: number;
  language?: string;
}

export interface SigmaMatch {
  id: string;
  title: string;
  level?: string;
  line: number;
  matchedKeyword: string;
}

export interface NucleiMatch {
  id: string;
  name: string;
  severity?: string;
  line: number;
  matchedText: string;
}

export interface YaraMatch {
  id: string;
  name: string;
  tags?: string[];
  matchedString: string;
  line?: number;
}

export interface SymbolRulesEngineOptions {
  rulesDir?: string;
}

interface LanguageSinkRule {
  type: string;
  regex: string;
}

interface LanguageRuleConfig {
  name: string;
  extensions?: string[];
  sinks?: LanguageSinkRule[];
}

interface SigmaRuleConfig {
  id: string;
  title?: string;
  level?: string;
  status?: string;
  detection?: {
    selection?: {
      keywords?: string[];
    } | string[];
    keywords?: string[];
    condition?: string;
  };
}

interface NucleiMatcherConfig {
  type: 'regex' | 'word' | string;
  regex?: string[];
  words?: string[];
}

interface NucleiTemplateConfig {
  id: string;
  info?: {
    name?: string;
    severity?: string;
    tags?: string | string[];
  };
  matchers?: NucleiMatcherConfig[];
  file?: Array<{
    matchers?: NucleiMatcherConfig[];
  }>;
}

interface YaraRuleConfig {
  id: string;
  name?: string;
  tags?: string[];
  strings?: any;
  condition?: string;
  meta?: Record<string, any>;
}

const DEFAULT_LANGUAGES: Record<string, LanguageRuleConfig> = {
  python: {
    name: 'python',
    extensions: ['.py'],
    sinks: [
      {
        type: 'command_injection',
        regex: '\\b(?:subprocess\\.(?:Popen|call|check_call|check_output|run)|os\\.system|os\\.popen)\\b',
      },
      {
        type: 'code_execution',
        regex: '\\b(?:eval|exec)\\b',
      },
      {
        type: 'deserialization',
        regex: '\\b(?:pickle\\.loads?|yaml\\.load)\\s*\\(',
      },
    ],
  },
  javascript: {
    name: 'javascript',
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs'],
    sinks: [
      {
        type: 'eval_injection',
        regex: '\\b(?:eval|Function)\\s*\\(',
      },
      {
        type: 'command_injection',
        regex: '\\b(?:child_process\\.(?:exec|execSync|spawn|spawnSync)|exec|execSync|spawn|spawnSync)\\s*\\(',
      },
      {
        type: 'dom_xss',
        regex: '\\b(?:innerHTML|outerHTML)\\s*=',
      },
    ],
  },
  rust: {
    name: 'rust',
    extensions: ['.rs'],
    sinks: [
      {
        type: 'unsafe_block',
        regex: '\\bunsafe\\b[ \\t]*\\{',
      },
      {
        type: 'command_injection',
        regex: '\\bCommand::new\\b',
      },
    ],
  },
  go: {
    name: 'go',
    extensions: ['.go'],
    sinks: [
      {
        type: 'command_injection',
        regex: '\\b(?:exec\\.Command|exec\\.CommandContext)\\b',
      },
      {
        type: 'sql_injection',
        regex: '\\b(?:db\\.Query|db\\.Exec)\\s*\\([^)]*\\+',
      },
    ],
  },
};

const DEFAULT_SIGMA_RULES: SigmaRuleConfig[] = [
  {
    id: 'sigma-command-injection',
    title: 'Command Injection Sinks',
    level: 'critical',
    detection: {
      selection: {
        keywords: ['subprocess.call', 'subprocess.check_output', 'os.system', 'execSync'],
      },
    },
  },
  {
    id: 'sigma-eval-injection',
    title: 'Dynamic Eval Code Execution',
    level: 'critical',
    detection: {
      selection: {
        keywords: ['eval(', 'Function(', 'exec('],
      },
    },
  },
];

const DEFAULT_NUCLEI_TEMPLATES: NucleiTemplateConfig[] = [
  {
    id: 'nuclei-hardcoded-secrets',
    info: {
      name: 'High-Entropy API Keys and Hardcoded Tokens',
      severity: 'high',
    },
    file: [
      {
        matchers: [
          {
            type: 'regex',
            regex: ["(?:api[_-]?key|secret|token|password)[ \\t]*=[ \\t]*['\"][a-zA-Z0-9_-]{16,}['\"]"],
          },
        ],
      },
    ],
  },
  {
    id: 'nuclei-rce-sinks',
    info: {
      name: 'Remote Code Execution and Shell Process Sinks',
      severity: 'critical',
    },
    file: [
      {
        matchers: [
          {
            type: 'regex',
            regex: ['\\b(?:child_process\\.exec|subprocess\\.Popen|Command::new|os\\.system)\\b'],
          },
        ],
      },
    ],
  },
];

const DEFAULT_YARA_RULES: YaraRuleConfig[] = [
  {
    id: 'yara-reverse-shells',
    name: 'ReverseShellPayload',
    tags: ['ctf', 'payload'],
    strings: [
      '$bash_tcp = "/dev/tcp/" ascii',
      '$sh_pipe = "/bin/sh -i" ascii',
      '$nc_e = "nc -e /bin/sh" ascii',
    ],
  },
];

export class SymbolRulesEngine {
  private rulesDir: string | null = null;
  private languageRules = new Map<string, LanguageRuleConfig>();
  private sigmaRules: SigmaRuleConfig[] = [];
  private nucleiTemplates: NucleiTemplateConfig[] = [];
  private yaraRules: YaraRuleConfig[] = [];
  private regexCache = new Map<string, RegExp>();

  constructor(options?: SymbolRulesEngineOptions) {
    this.resolveAndLoadRules(options?.rulesDir);
  }

  private getOrCreateRegex(pattern: string, flags?: string): RegExp | null {
    const key = flags ? `${pattern}::${flags}` : pattern;
    if (this.regexCache.has(key)) {
      return this.regexCache.get(key)!;
    }
    try {
      const reg = new RegExp(pattern, flags);
      this.regexCache.set(key, reg);
      return reg;
    } catch {
      return null;
    }
  }

  private resolveAndLoadRules(explicitDir?: string): void {
    let dirname = '';
    try {
      dirname = path.dirname(fileURLToPath(import.meta.url));
    } catch {
      dirname = process.cwd();
    }

    const candidates = [
      explicitDir,
      path.join(process.cwd(), 'config/rules'),
      path.resolve(dirname, '../../config/rules'),
      path.resolve(process.cwd(), 'mcp-server/config/rules'),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        this.rulesDir = candidate;
        break;
      }
    }

    if (this.rulesDir) {
      this.loadFromDirectory(this.rulesDir);
    } else {
      this.loadDefaults();
    }

    // Ensure fallback defaults exist if directories were empty or missing certain categories
    for (const [k, v] of Object.entries(DEFAULT_LANGUAGES)) {
      if (!this.languageRules.has(k)) {
        this.languageRules.set(k, v);
      }
    }
    if (this.sigmaRules.length === 0) {
      this.sigmaRules = [...DEFAULT_SIGMA_RULES];
    }
    if (this.nucleiTemplates.length === 0) {
      this.nucleiTemplates = [...DEFAULT_NUCLEI_TEMPLATES];
    }
    if (this.yaraRules.length === 0) {
      this.yaraRules = [...DEFAULT_YARA_RULES];
    }
  }

  private loadDefaults(): void {
    for (const [k, v] of Object.entries(DEFAULT_LANGUAGES)) {
      this.languageRules.set(k, v);
    }
    this.sigmaRules = [...DEFAULT_SIGMA_RULES];
    this.nucleiTemplates = [...DEFAULT_NUCLEI_TEMPLATES];
    this.yaraRules = [...DEFAULT_YARA_RULES];
  }

  private loadFromDirectory(rulesDir: string): void {
    // 1. Languages
    const langDir = path.join(rulesDir, 'languages');
    if (fs.existsSync(langDir) && fs.statSync(langDir).isDirectory()) {
      try {
        const files = fs.readdirSync(langDir);
        for (const file of files) {
          if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            try {
              const content = fs.readFileSync(path.join(langDir, file), 'utf8');
              const parsed = yaml.parse(content) as LanguageRuleConfig;
              if (parsed && parsed.name) {
                this.languageRules.set(parsed.name.toLowerCase(), parsed);
              }
            } catch {
              // ignore malformed rule
            }
          }
        }
      } catch {
        // ignore read error
      }
    }

    // 2. Sigma
    const sigmaDir = path.join(rulesDir, 'sigma');
    if (fs.existsSync(sigmaDir) && fs.statSync(sigmaDir).isDirectory()) {
      try {
        const files = fs.readdirSync(sigmaDir);
        for (const file of files) {
          if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            try {
              const content = fs.readFileSync(path.join(sigmaDir, file), 'utf8');
              const parsed = yaml.parse(content);
              if (parsed) {
                if (Array.isArray(parsed.rules)) {
                  this.sigmaRules.push(...parsed.rules);
                } else if (parsed.id) {
                  this.sigmaRules.push(parsed);
                }
              }
            } catch {
              // ignore malformed
            }
          }
        }
      } catch {
        // ignore read error
      }
    }

    // Security/sigma.yaml fallback
    const secSigma = path.join(rulesDir, 'security/sigma.yaml');
    if (fs.existsSync(secSigma)) {
      try {
        const content = fs.readFileSync(secSigma, 'utf8');
        const parsed = yaml.parse(content);
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          this.sigmaRules.push(...parsed.rules);
        }
      } catch {
        // ignore
      }
    }

    // 3. Nuclei
    const nucleiDir = path.join(rulesDir, 'nuclei');
    if (fs.existsSync(nucleiDir) && fs.statSync(nucleiDir).isDirectory()) {
      try {
        const files = fs.readdirSync(nucleiDir);
        for (const file of files) {
          if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            try {
              const content = fs.readFileSync(path.join(nucleiDir, file), 'utf8');
              const parsed = yaml.parse(content);
              if (parsed) {
                if (Array.isArray(parsed.templates)) {
                  this.nucleiTemplates.push(...parsed.templates);
                } else if (parsed.id) {
                  this.nucleiTemplates.push(parsed);
                }
              }
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore read error
      }
    }

    // 4. Yara
    const yaraDir = path.join(rulesDir, 'yara');
    if (fs.existsSync(yaraDir) && fs.statSync(yaraDir).isDirectory()) {
      try {
        const files = fs.readdirSync(yaraDir);
        for (const file of files) {
          if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            try {
              const content = fs.readFileSync(path.join(yaraDir, file), 'utf8');
              const parsed = yaml.parse(content);
              if (parsed) {
                if (Array.isArray(parsed.rules)) {
                  this.yaraRules.push(...parsed.rules);
                } else if (parsed.id || parsed.name) {
                  this.yaraRules.push(parsed);
                }
              }
            } catch {
              // ignore
            }
          } else if (file.endsWith('.yar') || file.endsWith('.yara')) {
            try {
              const content = fs.readFileSync(path.join(yaraDir, file), 'utf8');
              const parsedRules = this.parseYaraFile(content);
              this.yaraRules.push(...parsedRules);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore read error
      }
    }

    // Security/yara.yaml fallback
    const secYara = path.join(rulesDir, 'security/yara.yaml');
    if (fs.existsSync(secYara)) {
      try {
        const content = fs.readFileSync(secYara, 'utf8');
        const parsed = yaml.parse(content);
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          this.yaraRules.push(...parsed.rules);
        }
      } catch {
        // ignore
      }
    }
  }

  private normalizeLanguage(language: string): string {
    const l = language.toLowerCase().trim();
    if (['py', 'python'].includes(l)) return 'python';
    if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'javascript', 'typescript'].includes(l)) return 'javascript';
    if (['rs', 'rust'].includes(l)) return 'rust';
    if (['go', 'golang'].includes(l)) return 'go';
    return l;
  }

  extractSymbols(code: string, language: string, filePath: string): ExtractedSymbol[] {
    const normLang = this.normalizeLanguage(language);
    if (normLang === 'python') {
      return this.extractPythonSymbols(code, filePath);
    }
    if (normLang === 'rust') {
      return this.extractRustSymbols(code, filePath);
    }
    if (normLang === 'javascript') {
      return this.extractJsSymbols(code, filePath);
    }
    return [];
  }

  private countParenDelta(text: string): number {
    let delta = 0;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (!inSingle && !inDouble) {
        if (ch === '(') delta++;
        else if (ch === ')') delta--;
      }
    }
    return delta;
  }

  private extractPythonSymbols(code: string, filePath: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = code.split(/\r?\n/);
    let currentDecorators: string[] = [];
    let decoratorStartLine = -1;
    let decoratorParenDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (decoratorParenDepth > 0) {
        if (currentDecorators.length > 0) {
          currentDecorators[currentDecorators.length - 1] += ' ' + trimmed;
        }
        decoratorParenDepth += this.countParenDelta(trimmed);
        if (decoratorParenDepth < 0) decoratorParenDepth = 0;
        continue;
      }

      if (trimmed.startsWith('@')) {
        if (currentDecorators.length === 0) {
          decoratorStartLine = i + 1;
        }
        currentDecorators.push(trimmed);
        decoratorParenDepth += this.countParenDelta(trimmed);
        if (decoratorParenDepth < 0) decoratorParenDepth = 0;
        continue;
      }

      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }

      // Check function definition
      const fnMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(([\s\S]*)/);
      if (fnMatch) {
        const name = fnMatch[1];
        const decorators = [...currentDecorators];
        const metadata = this.parsePythonDecoratorMetadata(decorators);

        symbols.push({
          name,
          kind: 'function',
          filePath,
          lineStart: decoratorStartLine !== -1 ? decoratorStartLine : i + 1,
          decorators: decorators.length > 0 ? decorators : undefined,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });

        currentDecorators = [];
        decoratorStartLine = -1;
        decoratorParenDepth = 0;
        continue;
      }

      // Check class definition
      const classMatch = trimmed.match(/^class\s+([a-zA-Z_]\w*)/);
      if (classMatch) {
        const name = classMatch[1];
        const decorators = [...currentDecorators];
        const metadata = this.parsePythonDecoratorMetadata(decorators);

        symbols.push({
          name,
          kind: 'class',
          filePath,
          lineStart: decoratorStartLine !== -1 ? decoratorStartLine : i + 1,
          decorators: decorators.length > 0 ? decorators : undefined,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });

        currentDecorators = [];
        decoratorStartLine = -1;
        decoratorParenDepth = 0;
        continue;
      }

      // Any other non-empty non-decorator line resets decorator chain
      currentDecorators = [];
      decoratorStartLine = -1;
      decoratorParenDepth = 0;
    }

    return symbols;
  }

  private parsePythonDecoratorMetadata(decorators: string[]): Record<string, any> {
    const metadata: Record<string, any> = {};

    for (const dec of decorators) {
      // HTTP method: methods=['GET'] or methods=["GET"]
      const methodsMatch = dec.match(/methods\s*=\s*\[\s*['"]([A-Z]+)['"]/i);
      if (methodsMatch) {
        metadata.httpMethod = methodsMatch[1].toUpperCase();
      } else {
        const directMethodMatch = dec.match(/\.(get|post|put|delete|patch|options|head)\s*\(/i);
        if (directMethodMatch) {
          metadata.httpMethod = directMethodMatch[1].toUpperCase();
        }
      }

      // routePath: @bp.route('/api/...', ...) or @app.get('/api/...'
      const routeMatch = dec.match(/(?:\.route|\.(?:get|post|put|delete|patch|options|head))\s*\(\s*['"]([^'"]+)['"]/i);
      if (routeMatch) {
        metadata.routePath = routeMatch[1];
      }

      // authRole: role='admin' or role="admin"
      const roleMatch = dec.match(/role\s*=\s*['"]([^'"]+)['"]/i);
      if (roleMatch) {
        metadata.authRole = roleMatch[1];
      }
    }

    return metadata;
  }

  private extractRustSymbols(code: string, filePath: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = code.split(/\r?\n/);

    let currentImpl: string | null = null;
    let braceDepth = 0;
    let implBraceDepth = -1;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check impl block start
      const implMatch = trimmed.match(/^impl(?:\s*<[^>]+>)?\s*(?:(\w+)\s+for\s+)?(\w+)/);
      if (implMatch) {
        currentImpl = implMatch[2] || implMatch[1];
        implBraceDepth = braceDepth;
      }

      // Struct
      const structMatch = trimmed.match(/^((?:pub(?:\([^)]+\))?\s+)?)struct\s+([a-zA-Z_]\w*)/);
      if (structMatch) {
        const vis = structMatch[1].trim() || undefined;
        const name = structMatch[2];
        symbols.push({
          name,
          kind: 'struct',
          filePath,
          lineStart: i + 1,
          visibility: vis,
        });
      }

      // Enum
      const enumMatch = trimmed.match(/^((?:pub(?:\([^)]+\))?\s+)?)enum\s+([a-zA-Z_]\w*)/);
      if (enumMatch) {
        const vis = enumMatch[1].trim() || undefined;
        const name = enumMatch[2];
        symbols.push({
          name,
          kind: 'enum',
          filePath,
          lineStart: i + 1,
          visibility: vis,
        });
      }

      // Trait
      const traitMatch = trimmed.match(/^((?:pub(?:\([^)]+\))?\s+)?)trait\s+([a-zA-Z_]\w*)/);
      if (traitMatch) {
        const vis = traitMatch[1].trim() || undefined;
        const name = traitMatch[2];
        symbols.push({
          name,
          kind: 'trait',
          filePath,
          lineStart: i + 1,
          visibility: vis,
        });
      }

      // Function or Method
      let fnMatch = trimmed.match(/^((?:pub(?:\([^)]+\))?\s+)?)(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)(?:\s*->\s*([^{;]+))?/);
      if (!fnMatch && /^((?:pub(?:\([^)]+\))?\s+)?)(?:async\s+)?fn\s+([a-zA-Z_]\w*)/.test(trimmed)) {
        let fullFnText = trimmed;
        let j = i;
        while (!fullFnText.includes('{') && !fullFnText.includes(';') && j + 1 < lines.length) {
          j++;
          fullFnText += ' ' + lines[j].trim();
        }
        fnMatch = fullFnText.match(/^((?:pub(?:\([^)]+\))?\s+)?)(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)(?:\s*->\s*([^{;]+))?/);
      }

      if (fnMatch) {
        const vis = fnMatch[1].trim() || undefined;
        const name = fnMatch[2];
        const params = fnMatch[3] || '';
        const returnType = fnMatch[4] || '';

        const metadata: Record<string, any> = {};
        if (/&mut\s+self\b/.test(params)) {
          metadata.isMutSelf = true;
        }
        if (/\bBox\s*</.test(returnType)) {
          metadata.returnsBox = true;
        }
        if (/\bArc\s*</.test(returnType)) {
          metadata.returnsArc = true;
        }

        symbols.push({
          name,
          kind: currentImpl ? 'method' : 'function',
          filePath,
          lineStart: i + 1,
          visibility: vis,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      }

      // Update brace depth: strip string literals ("...") and comments (//..., /*...*/)
      let sanitized = '';
      let inString = false;
      let escaped = false;
      for (let j = 0; j < line.length; j++) {
        if (inBlockComment) {
          if (line[j] === '*' && line[j + 1] === '/') {
            inBlockComment = false;
            j++;
          }
          continue;
        }
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (line[j] === '\\') {
            escaped = true;
          } else if (line[j] === '"') {
            inString = false;
          }
          continue;
        }
        if (line[j] === '/' && line[j + 1] === '/') {
          break;
        }
        if (line[j] === '/' && line[j + 1] === '*') {
          inBlockComment = true;
          j++;
          continue;
        }
        if (line[j] === '"') {
          inString = true;
          continue;
        }
        if (line[j] === "'") {
          if (line[j + 1] === '\\' && line[j + 3] === "'") {
            j += 3;
            continue;
          } else if (line[j + 2] === "'") {
            j += 2;
            continue;
          }
        }
        sanitized += line[j];
      }

      for (const ch of sanitized) {
        if (ch === '{') braceDepth++;
        if (ch === '}') {
          braceDepth--;
          if (currentImpl !== null && braceDepth <= implBraceDepth) {
            currentImpl = null;
            implBraceDepth = -1;
          }
        }
      }
    }

    return symbols;
  }

  private extractJsSymbols(code: string, filePath: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = code.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Function
      const fnMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z_]\w*)/);
      if (fnMatch) {
        symbols.push({
          name: fnMatch[1],
          kind: 'function',
          filePath,
          lineStart: i + 1,
        });
        continue;
      }

      // Class
      const classMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?class\s+([a-zA-Z_]\w*)/);
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          filePath,
          lineStart: i + 1,
        });
        continue;
      }

      // Interface
      const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([a-zA-Z_]\w*)/);
      if (interfaceMatch) {
        symbols.push({
          name: interfaceMatch[1],
          kind: 'interface',
          filePath,
          lineStart: i + 1,
        });
        continue;
      }
    }

    return symbols;
  }

  detectSinks(code: string, language: string): DetectedSink[] {
    const sinks: DetectedSink[] = [];
    const normLang = this.normalizeLanguage(language);
    const langRule = this.languageRules.get(normLang);

    const lines = code.split(/\r?\n/);

    if (langRule?.sinks) {
      const compiled = langRule.sinks.map((s) => ({
        type: s.type,
        regex: this.getOrCreateRegex(s.regex),
      })).filter((s): s is { type: string; regex: RegExp } => s.regex !== null);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const sink of compiled) {
          const match = line.match(sink.regex);
          if (match) {
            sinks.push({
              sinkType: sink.type,
              line: i + 1,
              matchedText: match[0],
              column: match.index !== undefined ? match.index + 1 : undefined,
              language: normLang,
            });
          }
        }
      }
    }

    return sinks;
  }

  matchSigmaRules(code: string): SigmaMatch[] {
    const matches: SigmaMatch[] = [];
    const lines = code.split(/\r?\n/);

    for (const rule of this.sigmaRules) {
      const keywords = this.extractSigmaKeywords(rule);
      if (keywords.length === 0) continue;

      const compiled = keywords.map((kw) => ({
        keyword: kw,
        regex: this.getOrCreateRegex(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      }));

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const item of compiled) {
          if (item.regex ? item.regex.test(line) : line.includes(item.keyword)) {
            matches.push({
              id: rule.id,
              title: rule.title || rule.id,
              level: rule.level || 'medium',
              line: i + 1,
              matchedKeyword: item.keyword,
            });
          }
        }
      }
    }

    return matches;
  }

  private extractSigmaKeywords(rule: SigmaRuleConfig): string[] {
    const sel = rule.detection?.selection;
    if (Array.isArray(sel)) return sel;
    if (sel && typeof sel === 'object' && Array.isArray((sel as any).keywords)) {
      return (sel as any).keywords;
    }
    if (Array.isArray(rule.detection?.keywords)) {
      return rule.detection.keywords;
    }
    return [];
  }

  matchNucleiTemplates(code: string): NucleiMatch[] {
    const matches: NucleiMatch[] = [];
    const lines = code.split(/\r?\n/);

    for (const template of this.nucleiTemplates) {
      const matchers: NucleiMatcherConfig[] = [];
      if (Array.isArray(template.matchers)) {
        matchers.push(...template.matchers);
      }
      if (Array.isArray(template.file)) {
        for (const f of template.file) {
          if (Array.isArray(f.matchers)) {
            matchers.push(...f.matchers);
          }
        }
      }

      const compiledRegexes: RegExp[] = [];
      const words: string[] = [];

      for (const matcher of matchers) {
        if (matcher.type === 'regex' && Array.isArray(matcher.regex)) {
          for (const pattern of matcher.regex) {
            const reg = this.getOrCreateRegex(pattern);
            if (reg) compiledRegexes.push(reg);
          }
        } else if (matcher.type === 'word' && Array.isArray(matcher.words)) {
          for (const word of matcher.words) {
            words.push(word);
          }
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const regex of compiledRegexes) {
          const match = line.match(regex);
          if (match) {
            matches.push({
              id: template.id,
              name: template.info?.name || template.id,
              severity: template.info?.severity,
              line: i + 1,
              matchedText: match[0],
            });
          }
        }
        for (const word of words) {
          if (line.includes(word)) {
            matches.push({
              id: template.id,
              name: template.info?.name || template.id,
              severity: template.info?.severity,
              line: i + 1,
              matchedText: word,
            });
          }
        }
      }
    }

    return matches;
  }

  matchYaraRules(content: string): YaraMatch[] {
    const matches: YaraMatch[] = [];

    for (const rule of this.yaraRules) {
      const stringPatterns = this.parseYaraStrings(rule.strings);
      for (const sp of stringPatterns) {
        const regex = this.getYaraPatternRegex(sp.pattern);
        if (!regex) continue;
        const match = regex.exec(content);
        if (match) {
          const line = content.slice(0, match.index).split(/\r?\n/).length;
          matches.push({
            id: rule.id,
            name: rule.name || rule.id,
            tags: rule.tags,
            matchedString: sp.pattern,
            line,
          });
        }
      }
    }

    return matches;
  }

  private getYaraPatternRegex(pattern: string): RegExp | null {
    const cacheKey = `yara:${pattern}`;
    if (this.regexCache.has(cacheKey)) {
      return this.regexCache.get(cacheKey)!;
    }
    let escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    escaped = escaped.replace(/\\r\\?\\\\n|\\r\\\\n|\\\\n|\r?\n/g, '\\r?\\n');
    const regex = this.getOrCreateRegex(escaped);
    if (regex) {
      this.regexCache.set(cacheKey, regex);
    }
    return regex;
  }

  private hexToBinaryString(hexStr: string): string {
    const clean = hexStr.replace(/[{}]/g, '').trim();
    const tokens = clean.split(/\s+/).filter(Boolean);
    if (tokens.length > 0 && tokens.every((t) => /^[0-9a-fA-F]{1,2}$/.test(t))) {
      return tokens.map((b) => String.fromCharCode(parseInt(b, 16))).join('');
    }
    const continuous = clean.replace(/\s+/g, '');
    if (/^[0-9a-fA-F]+$/.test(continuous) && continuous.length % 2 === 0) {
      const chars: string[] = [];
      for (let i = 0; i < continuous.length; i += 2) {
        chars.push(String.fromCharCode(parseInt(continuous.slice(i, i + 2), 16)));
      }
      return chars.join('');
    }
    return hexStr;
  }

  private parseYaraStrings(ruleStrings?: any): Array<{ identifier: string; pattern: string }> {
    const result: Array<{ identifier: string; pattern: string }> = [];
    if (!ruleStrings) return result;

    if (Array.isArray(ruleStrings)) {
      for (const item of ruleStrings) {
        if (typeof item === 'string') {
          const hexMatch = item.match(/\$([a-zA-Z0-9_]+)\s*=\s*\{\s*([0-9a-fA-F\s]+)\s*\}/);
          if (hexMatch) {
            result.push({ identifier: hexMatch[1], pattern: this.hexToBinaryString(hexMatch[2]) });
            continue;
          }

          const strMatch = item.match(/\$([a-zA-Z0-9_]+)\s*=\s*"([\s\S]*?)"/);
          if (strMatch) {
            result.push({ identifier: strMatch[1], pattern: strMatch[2] });
            continue;
          }

          const rawHexMatch = item.match(/^\{\s*([0-9a-fA-F\s]+)\s*\}$/);
          if (rawHexMatch) {
            result.push({ identifier: 'hex', pattern: this.hexToBinaryString(rawHexMatch[1]) });
            continue;
          }

          const rawText = item.startsWith('"') && item.endsWith('"') ? item.slice(1, -1) : item;
          result.push({ identifier: 'str', pattern: rawText });
        } else if (item && typeof item === 'object') {
          const ident = (item.id || item.name || item.identifier || 'str').replace(/^\$/, '');
          if (item.type === 'hex' || item.hex) {
            result.push({
              identifier: ident,
              pattern: this.hexToBinaryString(item.value || item.hex || ''),
            });
          } else if (item.value !== undefined) {
            result.push({ identifier: ident, pattern: String(item.value) });
          } else if (item.pattern !== undefined) {
            result.push({ identifier: ident, pattern: String(item.pattern) });
          }
        }
      }
    } else if (typeof ruleStrings === 'object') {
      for (const [key, val] of Object.entries(ruleStrings)) {
        const ident = key.replace(/^\$/, '');
        if (typeof val === 'string') {
          const hexMatch = val.match(/^\{\s*([0-9a-fA-F\s]+)\s*\}$/);
          if (hexMatch) {
            result.push({ identifier: ident, pattern: this.hexToBinaryString(hexMatch[1]) });
          } else {
            const rawText = val.startsWith('"') && val.endsWith('"') ? val.slice(1, -1) : val;
            result.push({ identifier: ident, pattern: rawText });
          }
        } else if (val && typeof val === 'object') {
          const obj = val as any;
          if (obj.type === 'hex' || obj.hex) {
            result.push({
              identifier: ident,
              pattern: this.hexToBinaryString(obj.value || obj.hex || ''),
            });
          } else if (obj.value !== undefined) {
            result.push({ identifier: ident, pattern: String(obj.value) });
          } else if (obj.pattern !== undefined) {
            result.push({ identifier: ident, pattern: String(obj.pattern) });
          }
        }
      }
    }

    return result;
  }

  private parseYaraFile(content: string): YaraRuleConfig[] {
    const rules: YaraRuleConfig[] = [];
    const ruleHeaderRegex = /rule\s+([a-zA-Z0-9_]+)(?:\s*:\s*([^{]+))?\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = ruleHeaderRegex.exec(content)) !== null) {
      const ruleName = match[1];
      const tagsStr = match[2];
      const tags = tagsStr ? tagsStr.trim().split(/\s+/).filter(Boolean) : undefined;
      const startIndex = ruleHeaderRegex.lastIndex;

      let depth = 1;
      let endIndex = -1;
      let inString = false;
      let quoteChar = '';

      for (let i = startIndex; i < content.length; i++) {
        const char = content[i];
        if (inString) {
          if (char === '\\') {
            i++;
          } else if (char === quoteChar) {
            inString = false;
          }
        } else {
          if (char === '/' && content[i + 1] === '/') {
            const nextNl = content.indexOf('\n', i);
            if (nextNl === -1) break;
            i = nextNl;
            continue;
          }
          if (char === '/' && content[i + 1] === '*') {
            const closeComment = content.indexOf('*/', i + 2);
            if (closeComment === -1) break;
            i = closeComment + 1;
            continue;
          }
          if (char === '"' || char === "'") {
            inString = true;
            quoteChar = char;
          } else if (char === '{') {
            depth++;
          } else if (char === '}') {
            depth--;
            if (depth === 0) {
              endIndex = i;
              break;
            }
          }
        }
      }

      if (endIndex === -1) break;

      const body = content.slice(startIndex, endIndex);
      ruleHeaderRegex.lastIndex = endIndex + 1;

      const ruleConfig: YaraRuleConfig = {
        id: ruleName,
        name: ruleName,
        tags,
      };

      const sectionIndices: Array<{ name: 'meta' | 'strings' | 'condition'; index: number; headerLen: number }> = [];
      const metaMatch = /\bmeta\s*:/.exec(body);
      if (metaMatch) sectionIndices.push({ name: 'meta', index: metaMatch.index, headerLen: metaMatch[0].length });
      const stringsMatch = /\bstrings\s*:/.exec(body);
      if (stringsMatch) sectionIndices.push({ name: 'strings', index: stringsMatch.index, headerLen: stringsMatch[0].length });
      const condMatch = /\bcondition\s*:/.exec(body);
      if (condMatch) sectionIndices.push({ name: 'condition', index: condMatch.index, headerLen: condMatch[0].length });

      sectionIndices.sort((a, b) => a.index - b.index);

      for (let s = 0; s < sectionIndices.length; s++) {
        const current = sectionIndices[s];
        const next = sectionIndices[s + 1];
        const sectionContent = body.slice(current.index + current.headerLen, next ? next.index : body.length).trim();

        if (current.name === 'meta') {
          const meta: Record<string, any> = {};
          const metaLines = sectionContent.split(/\r?\n/);
          for (const line of metaLines) {
            const m = line.trim().match(/^([a-zA-Z0-9_]+)\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|(.*))$/);
            if (m) {
              meta[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4].trim());
            }
          }
          ruleConfig.meta = meta;
        } else if (current.name === 'strings') {
          const strings: string[] = [];
          const strLines = sectionContent.split(/\r?\n/);
          let currentStr = '';
          let inBraceBlock = false;

          for (const line of strLines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('//')) continue;

            if (inBraceBlock) {
              currentStr += ' ' + trimmed;
              if (trimmed.includes('}')) {
                strings.push(currentStr);
                currentStr = '';
                inBraceBlock = false;
              }
              continue;
            }

            if (trimmed.includes('{') && !trimmed.includes('}')) {
              currentStr = trimmed;
              inBraceBlock = true;
              continue;
            }

            strings.push(trimmed);
          }
          if (currentStr) {
            strings.push(currentStr);
          }
          ruleConfig.strings = strings;
        } else if (current.name === 'condition') {
          ruleConfig.condition = sectionContent;
        }
      }

      rules.push(ruleConfig);
    }

    return rules;
  }
}
