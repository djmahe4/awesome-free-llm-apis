/**
 * Smoke test for GitHub reverse assets & skill extraction:
 * 1. Validates GithubRepoScanner.analyzeCode wiring for functions, flows, dependencies.
 * 2. Validates reverseTool.scan_github on a real repository (JuliusBrussee/caveman).
 * 3. Validates skill loading & overwrite from skills/ folder (loadSkillPromptFromRepo).
 * 4. Validates README-based skill catalog extraction (parseReadmeSkills).
 * 5. Validates RepoSymbolDb and anti-BLA deception warning wiki generation.
 * 6. Cleans up temp directory safely.
 *
 * Run: npx tsx scripts/smoke/smoke_github_reverse_assets.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GithubRepoScanner } from '../../src/utils/GithubRepoScanner.js';
import { reverseTool } from '../../src/tools/reverse-tool.js';
import { loadSkillPromptFromRepo, parseReadmeSkills } from '../../src/reverse/github-skills.js';
import { RepoSymbolDb, type RepoKnowledgeRecord } from '../../src/reverse/repo-symbol-db.js';
import { httpGetText } from '../../src/utils/http.js';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
};

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-reverse-assets-'));

try {
  // 1. Validates GithubRepoScanner.analyzeCode wiring
  {
    const sampleCode = `
      import express from 'express';
      import { router } from './api/routes.js';
      const crypto = require('crypto');

      function verifySignature(payload, signature) {
        return hashPayload(payload) === signature;
      }

      const hashPayload = (data) => {
        return crypto.createHash('sha256').update(data).digest('hex');
      };

      class Server {
        start() {
          verifySignature('data', 'sig');
        }
      }
    `;

    const analysis = GithubRepoScanner.analyzeCode(sampleCode);

    const hasDeps = analysis.dependencies.includes('express') &&
                    analysis.dependencies.includes('./api/routes.js') &&
                    analysis.dependencies.includes('crypto');
    check('P1 analyzeCode extracts ES & CJS dependencies', hasDeps, JSON.stringify(analysis.dependencies));

    const hasFuncs = analysis.functions.includes('verifySignature') &&
                     analysis.functions.includes('hashPayload') &&
                     analysis.functions.includes('start');
    check('P1 analyzeCode extracts declared functions and methods', hasFuncs, JSON.stringify(analysis.functions));

    const hasFlow = analysis.flow.some(f => f.includes('verifySignature -> hashPayload')) ||
                    analysis.flow.some(f => f.includes('start -> verifySignature'));
    check('P1 analyzeCode traces caller-callee flow', hasFlow, JSON.stringify(analysis.flow));
  }

  // 2. Validates reverseTool.scan_github on real repo (JuliusBrussee/caveman)
  {
    const dbDir = path.join(tmpBase, 'repo-db');
    fs.mkdirSync(dbDir, { recursive: true });

    const res = await reverseTool({
      action: 'scan_github',
      target: 'JuliusBrussee/caveman',
      authorization: 'ctf',
      options: { storageDir: dbDir },
    });

    check('P2 reverseTool.scan_github succeeds on JuliusBrussee/caveman', res.success === true, res.error || '');

    const data = res.data as any;
    const validData = data &&
                      data.owner === 'JuliusBrussee' &&
                      data.repo === 'caveman' &&
                      typeof data.commitSha === 'string' &&
                      data.commitSha.length > 0 &&
                      Array.isArray(data.descriptors) &&
                      data.descriptors.length > 0 &&
                      typeof data.wikiMarkdown === 'string';
    check('P2 reverseTool.scan_github returns commit, descriptors, and wiki markdown', Boolean(validData), JSON.stringify({
      owner: data?.owner,
      repo: data?.repo,
      descriptorsCount: data?.descriptors?.length,
      hasWiki: Boolean(data?.wikiMarkdown),
    }));

    check('P2 reverseTool returns evidence bundle tagged ctf/github_scan', res.evidence?.provenance?.source === 'github_scan', JSON.stringify(res.evidence?.provenance));
  }

  // 3. Validates skill loading & overwrite from skills/ folder
  {
    const skillsDir = path.join(tmpBase, 'installed-skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    // Initial load
    const load1 = await loadSkillPromptFromRepo({
      repoUrl: 'JuliusBrussee/caveman',
      skillName: 'caveman',
      targetSkillsDir: skillsDir,
      overwrite: true,
    });
    check('P3 loadSkillPromptFromRepo loads skill into targetSkillsDir', load1.success === true && typeof load1.prompt === 'string', load1.error || '');

    // Attempt without overwrite should fail
    const load2 = await loadSkillPromptFromRepo({
      repoUrl: 'JuliusBrussee/caveman',
      skillName: 'caveman',
      targetSkillsDir: skillsDir,
      overwrite: false,
    });
    check('P3 loadSkillPromptFromRepo respects overwrite: false', load2.success === false && Boolean(load2.error?.includes('already exists')), load2.error || 'Expected overwrite error');

    // Overwrite: true should succeed
    const load3 = await loadSkillPromptFromRepo({
      repoUrl: 'JuliusBrussee/caveman',
      skillName: 'caveman',
      targetSkillsDir: skillsDir,
      overwrite: true,
    });
    check('P3 loadSkillPromptFromRepo allows overwrite: true', load3.success === true && typeof load3.prompt === 'string', load3.error || '');
  }

  // 4. Validates README-based skill catalog extraction (parseReadmeSkills)
  {
    // Test on real README from inceptionstack/loki-skills if reachable, or synthetic fixture fallback
    const lokiRes = await httpGetText('https://raw.githubusercontent.com/inceptionstack/loki-skills/main/README.md');
    let lokiSkills: any[] = [];
    if (lokiRes.ok && typeof lokiRes.text === 'string') {
      lokiSkills = parseReadmeSkills(lokiRes.text);
    }
    check(
      'P4 parseReadmeSkills extracts catalog from inceptionstack/loki-skills README',
      lokiSkills.length >= 10,
      `Found ${lokiSkills.length} skills (status: ${lokiRes.status}${lokiRes.error ? ', error: ' + lokiRes.error : ''})`
    );

    // Synthetic markdown table validation
    const tableReadme = `
      # Skills Directory
      | Skill | Description | Path |
      | --- | --- | --- |
      | [vuln-scanner](skills/vuln-scanner) | Automated vulnerability triage | skills/vuln-scanner/SKILL.md |
      | [heap-inspector](skills/heap) | Native heap allocation analyzer | skills/heap/SKILL.md |
    `;
    const parsedTable = parseReadmeSkills(tableReadme);
    const tableOk = parsedTable.length === 2 &&
                    parsedTable.some(s => s.name === 'vuln-scanner') &&
                    parsedTable.some(s => s.name === 'heap-inspector');
    check('P4 parseReadmeSkills parses Markdown tables', tableOk, JSON.stringify(parsedTable));

    // Synthetic markdown bullet list validation
    const listReadme = `
      # Skills
      - **[reverse-proxy](proxy/)**: Manages reverse engineering proxy daemon
      - **binary-lifter** - Lifts x86 machine instructions to IR
    `;
    const parsedList = parseReadmeSkills(listReadme);
    const listOk = parsedList.length === 2 &&
                   parsedList.some(s => s.name === 'reverse-proxy') &&
                   parsedList.some(s => s.name === 'binary-lifter');
    check('P4 parseReadmeSkills parses Markdown bullet lists', listOk, JSON.stringify(parsedList));
  }

  // 5. Validates RepoSymbolDb and anti-BLA deception warning wiki generation
  {
    const symbolDir = path.join(tmpBase, 'symbol-db');
    fs.mkdirSync(symbolDir, { recursive: true });

    const db = new RepoSymbolDb(symbolDir);
    const mockRecord: RepoKnowledgeRecord = {
      owner: 'acme-corp',
      repo: 'secure-vault',
      commitSha: 'a1b2c3d4e5f67890123456789abcdef012345678',
      indexedAt: new Date().toISOString(),
      readmeClaims: [
        'High-performance gRPC microservices pipeline architecture',
        'Hardware enclave security with confidential compute isolation',
      ],
      symbols: [
        { name: 'processRequest', kind: 'function', line: 12, filePath: 'src/index.ts' },
      ],
      callFlows: ['startServer -> processRequest'],
      manifests: ['package.json'],
      dependencies: [{ name: 'express', spec: '^4.19.2' }],
      releaseAssets: [],
    };

    db.saveRecord(mockRecord);
    const retrieved = db.getRecord(mockRecord.owner, mockRecord.repo, mockRecord.commitSha);
    check('P5 RepoSymbolDb saves and retrieves records accurately', retrieved !== null && retrieved.repo === 'secure-vault', JSON.stringify(retrieved?.repo));

    const wiki = db.generateWikiMarkdown(mockRecord);
    const hasWarningsSection = wiki.includes('## Anti-BLA Deception / Discrepancy Warnings');
    const hasGrpcWarning = wiki.includes('Documentation claims gRPC microservices, but no gRPC dependencies were discovered');
    const hasEnclaveWarning = wiki.includes('Documentation claims hardware enclave security, but no matching symbols or bindings exist');
    check('P5 generateWikiMarkdown contains deception warnings section', hasWarningsSection, wiki);
    check('P5 generateWikiMarkdown flags gRPC deception mismatch', hasGrpcWarning, wiki);
    check('P5 generateWikiMarkdown flags enclave security deception mismatch', hasEnclaveWarning, wiki);
    check('P5 generateWikiMarkdown contains grounded symbols and architecture', wiki.includes('processRequest') && wiki.includes('package.json'), wiki);
  }
} finally {
  // 6. Safe cleanup of temp directory
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    console.log(`CLEAN  Removed temp directory: ${tmpBase}`);
  } catch (err) {
    console.warn(`WARN   Failed to clean temp directory: ${tmpBase}`, err);
  }
}

const failed = results.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} smoke check(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${results.length} smoke checks passed.`);
