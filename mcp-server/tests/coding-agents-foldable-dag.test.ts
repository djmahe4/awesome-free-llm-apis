import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiskSymbolDb } from '../src/memory/disk-symbol-db.js';
import { FoldableDag } from '../src/memory/foldable-dag.js';
import { AuditTaintBridge } from '../src/memory/audit-taint-bridge.js';
import { SymbolRulesEngine } from '../src/memory/rules-engine.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('Coding Agents & Reverse Tool Foldable DAG Pipeline Integration', () => {
  let tmpDir: string;
  let db: DiskSymbolDb;
  let dag: FoldableDag;
  let rulesEngine: SymbolRulesEngine;
  let taintBridge: AuditTaintBridge;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `test-pipeline-int-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    db = new DiskSymbolDb({ baseDir: tmpDir });
    dag = new FoldableDag(db, 'integration_repo');
    rulesEngine = new SymbolRulesEngine();
    taintBridge = new AuditTaintBridge();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('indexes multi-language symbols with decorators and ownership into disk DAG without RAM bloat', () => {
    const pythonCode = `
@bp.route('/api/auth/token', methods=['POST'])
@auth_required(role='service')
def issue_service_token(client_id: str) -> dict:
    return {"token": "secret"}
`;
    const rustCode = `
pub(crate) struct TokenVault {
    secret: Vec<u8>,
}

impl TokenVault {
    pub fn verify_token(&mut self, token: &str) -> bool {
        true
    }
}
`;

    const pySymbols = rulesEngine.extractSymbols(pythonCode, 'python', 'app/auth.py');
    for (const sym of pySymbols) {
      dag.addSymbol({
        id: `auth::${sym.name}`,
        module: 'auth',
        kind: sym.kind as any,
        filePath: sym.filePath,
        signature: `${sym.name}()`,
        metadata: sym.metadata,
      });
    }

    const rsSymbols = rulesEngine.extractSymbols(rustCode, 'rust', 'src/vault.rs');
    for (const sym of rsSymbols) {
      dag.addSymbol({
        id: `vault::${sym.name}`,
        module: 'vault',
        kind: sym.kind as any,
        filePath: sym.filePath,
        signature: `${sym.name}()`,
        metadata: sym.metadata,
      });
    }

    dag.addInvocation('auth::issue_service_token', 'vault::verify_token');

    // Verify folded summary
    const summary = dag.getFoldedSummary();
    expect(summary.modules).toHaveLength(2);
    expect(summary.modules.some((m) => m.name === 'auth')).toBe(true);
    expect(summary.modules.some((m) => m.name === 'vault')).toBe(true);

    // Verify blast radius
    const blast = dag.computeBlastRadius('vault::verify_token');
    expect(blast.directCallers).toContain('auth::issue_service_token');
    expect(blast.totalAffected).toBe(1);
  });

  it('correlates manifest audits to DAG symbol callsites', () => {
    const callSites = [
      { caller: 'src/api/auth.ts::handleLogin', calleePackage: 'jsonwebtoken', calleeMethod: 'verify', line: 30 },
      { caller: 'src/storage/db.ts::connect', calleePackage: 'pg', calleeMethod: 'connect', line: 12 },
    ];

    const npmAudit = {
      vulnerabilities: {
        jsonwebtoken: {
          severity: 'critical',
          via: [{ title: 'Insecure Key Verification', url: 'https://nvd.nist.gov/vuln/detail/CVE-2022-23529' }],
        },
      },
    };

    const advisories = taintBridge.normalizeNpmAudit(npmAudit);
    const tainted = taintBridge.findTaintedCallSites(callSites, advisories);

    expect(tainted).toHaveLength(1);
    expect(tainted[0].caller).toBe('src/api/auth.ts::handleLogin');
    expect(tainted[0].severity).toBe('critical');
    expect(tainted[0].vulnerabilityTitle).toBe('Insecure Key Verification');
  });
});
