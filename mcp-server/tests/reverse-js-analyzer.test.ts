import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { analyzeJsFile, analyzeJsSource, type JsAnalyzerOptions } from '../src/reverse/js-analyzer.js';
import { PathSafetyError } from '../src/reverse/path-safety.js';

describe('Reverse JavaScript & TypeScript Analyzer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'js-analyzer-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts routes from Express, Fastify, and router instances', async () => {
    const filePath = path.join(tmpDir, 'server.js');
    const code = `
      const express = require('express');
      const app = express();
      const router = express.Router();

      app.get('/api/v1/status', (req, res) => {
        res.json({ ok: true });
      });

      app.post('/api/v1/run', async (req, res) => {
        res.status(202).send('running');
      });

      router.delete('/api/v1/session/:id', (req, res) => {
        res.sendStatus(204);
      });
    `;
    fs.writeFileSync(filePath, code, 'utf8');

    const evidence = await analyzeJsFile(filePath, { workspaceRoot: tmpDir });

    expect(evidence.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
    expect(evidence.coverage.status).toBe('complete');
    expect(evidence.analysis_profile.language).toBe('javascript');
    expect(evidence.provenance.trusted).toBe(false);

    const routes = evidence.normalized_result.routes as Array<{ method: string; path: string; line?: number }>;
    expect(routes).toBeDefined();

    const routeKeys = routes.map((r) => `${r.method} ${r.path}`);
    expect(routeKeys).toContain('GET /api/v1/status');
    expect(routeKeys).toContain('POST /api/v1/run');
    expect(routeKeys).toContain('DELETE /api/v1/session/:id');
  });

  it('detects dangerous sinks including eval, exec, new Function, and vm.runInContext', async () => {
    const filePath = path.join(tmpDir, 'sinks.ts');
    const code = `
      import cp from 'node:child_process';
      import vm from 'node:vm';

      function dangerousOps(untrustedCode: string, cmd: string, sandbox: any) {
        // eval
        eval(untrustedCode);

        // exec
        cp.exec(cmd, (err, stdout) => console.log(stdout));

        // new Function
        const fn = new Function('a', 'b', untrustedCode);

        // vm.runInContext
        vm.runInContext(untrustedCode, sandbox);

        // spawn
        cp.spawn('sh', ['-c', cmd]);
      }
    `;
    fs.writeFileSync(filePath, code, 'utf8');

    const evidence = await analyzeJsFile(filePath, { workspaceRoot: tmpDir });

    expect(evidence.analysis_profile.language).toBe('typescript');

    const sinks = evidence.normalized_result.sinks as Array<{ type: string; snippet?: string; line?: number }>;
    expect(sinks).toBeDefined();

    const sinkTypes = sinks.map((s) => s.type);
    expect(sinkTypes).toContain('eval');
    expect(sinkTypes).toContain('exec');
    expect(sinkTypes).toContain('new Function');
    expect(sinkTypes).toContain('vm.runInContext');
    expect(sinkTypes).toContain('spawn');
  });

  it('extracts ES and CommonJS imports and exports', async () => {
    const filePath = path.join(tmpDir, 'module.js');
    const code = `
      import express from 'express';
      import { readFile, writeFile } from 'node:fs/promises';
      import * as path from 'node:path';
      const crypto = require('node:crypto');

      export const secretHandler = () => {};
      export function executeTask() {}
      export default class MainService {}
      module.exports = { secretHandler };
    `;
    fs.writeFileSync(filePath, code, 'utf8');

    const evidence = await analyzeJsFile(filePath, { workspaceRoot: tmpDir });

    const imports = evidence.normalized_result.imports as Array<{ source: string; specifiers?: string[] }>;
    const importSources = imports.map((i) => i.source);
    expect(importSources).toContain('express');
    expect(importSources).toContain('node:fs/promises');
    expect(importSources).toContain('node:path');
    expect(importSources).toContain('node:crypto');

    const exportsList = evidence.normalized_result.exports as Array<{ name: string; type: string }>;
    const exportNames = exportsList.map((e) => e.name);
    expect(exportNames).toContain('secretHandler');
    expect(exportNames).toContain('executeTask');
    expect(exportNames).toContain('MainService');
    expect(exportNames).toContain('module.exports');
  });

  it('scans and identifies secrets such as JWTs and API keys', async () => {
    const filePath = path.join(tmpDir, 'config.ts');
    const code = `
      // JWT token
      const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

      // OpenAI API Key
      const openAiKey = "sk-proj-abc1234567890def1234567890gh";

      // Google API Key
      const googleApiKey = "AIzaSyD-1234567890abcdefghijklmnopqrstuv";

      // GitHub Personal Access Token
      const ghToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz12";
    `;
    fs.writeFileSync(filePath, code, 'utf8');

    const evidence = await analyzeJsFile(filePath, { workspaceRoot: tmpDir });

    const secrets = evidence.normalized_result.secrets as Array<{ type: string; snippet: string }>;
    expect(secrets.length).toBeGreaterThanOrEqual(4);

    const secretTypes = secrets.map((s) => s.type);
    expect(secretTypes).toContain('jwt');
    expect(secretTypes).toContain('api_key');
    expect(secretTypes).toContain('google_api_key');
    expect(secretTypes).toContain('github_token');
  });

  it('gracefully handles empty and whitespace-only files', async () => {
    const emptyFilePath = path.join(tmpDir, 'empty.js');
    fs.writeFileSync(emptyFilePath, '', 'utf8');

    const evidence = await analyzeJsFile(emptyFilePath, { workspaceRoot: tmpDir });

    expect(evidence.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
    expect(evidence.coverage.status).toBe('complete');
    expect(evidence.analysis_profile.lines).toBe(0);
    expect(evidence.analysis_profile.sizeBytes).toBe(0);
    expect(evidence.normalized_result.routes).toEqual([]);
    expect(evidence.normalized_result.sinks).toEqual([]);
    expect(evidence.normalized_result.imports).toEqual([]);
    expect(evidence.normalized_result.exports).toEqual([]);
    expect(evidence.normalized_result.secrets).toEqual([]);
  });

  it('handles minified and oversized code with resilient bounded sliding window without backtracking', async () => {
    const minifiedFilePath = path.join(tmpDir, 'bundle.min.js');

    // Construct a ~150KB single-line minified file with embedded route, sink, and secret
    const fillerChunk = 'var _0x1a=function(n){for(var i=0;i<10;i++){n+=i}return n};';
    const filler = fillerChunk.repeat(2500); // ~150KB on 1 line

    const code = `${filler}app.get('/api/v1/status',function(q,s){eval(q.body);var k="sk-proj-000000000011111111112222222222";});${filler}`;
    fs.writeFileSync(minifiedFilePath, code, 'utf8');

    const startTime = Date.now();
    const evidence = await analyzeJsFile(minifiedFilePath, {
      workspaceRoot: tmpDir,
      windowSize: 4096,
      windowOverlap: 256,
    });
    const duration = Date.now() - startTime;

    // Must execute quickly without catastrophic backtracking
    expect(duration).toBeLessThan(3000);
    expect(evidence.evidence_id).toBeDefined();

    const routes = evidence.normalized_result.routes as Array<{ method: string; path: string }>;
    expect(routes.some((r) => r.method === 'GET' && r.path === '/api/v1/status')).toBe(true);

    const sinks = evidence.normalized_result.sinks as Array<{ type: string }>;
    expect(sinks.some((s) => s.type === 'eval')).toBe(true);

    const secrets = evidence.normalized_result.secrets as Array<{ type: string }>;
    expect(secrets.some((s) => s.type === 'api_key')).toBe(true);
  });

  it('enforces path safety containment and rejects invalid extensions', async () => {
    const invalidPath = path.join(tmpDir, 'test.py');
    fs.writeFileSync(invalidPath, 'print("hello")', 'utf8');

    await expect(analyzeJsFile(invalidPath, { workspaceRoot: tmpDir })).rejects.toThrow(PathSafetyError);
  });

  it('degrades gracefully to native analysis when REA proxy executable fails', async () => {
    const filePath = path.join(tmpDir, 'app.js');
    fs.writeFileSync(filePath, "app.get('/api/v1/status', (req, res) => res.send('ok'));", 'utf8');

    const evidence = await analyzeJsFile(filePath, {
      workspaceRoot: tmpDir,
      reaAgentsPath: 'non_existent_engine_binary_9999',
    });

    expect(evidence.evidence_id).toBeDefined();
    const routes = evidence.normalized_result.routes as Array<{ method: string; path: string }>;
    expect(routes.some((r) => r.path === '/api/v1/status')).toBe(true);
  });

  it('parses multiline ES imports correctly', () => {
    const code = `
      import {
        foo,
        bar as baz
      } from 'my-pkg';
    `;
    const evidence = analyzeJsSource(code);
    const imports = evidence.normalized_result.imports as Array<{ source: string; specifiers?: string[] }>;
    expect(imports).toBeDefined();
    expect(imports.some((i) => i.source === 'my-pkg' && i.specifiers?.includes('foo'))).toBe(true);
  });

  it('extracts exported alias from named export blocks', () => {
    const code = `export { originalFunc as exportedAlias, simpleFunc };`;
    const evidence = analyzeJsSource(code);
    const exportsList = evidence.normalized_result.exports as Array<{ name: string; type: string }>;
    const names = exportsList.map((e) => e.name);
    expect(names).toContain('exportedAlias');
    expect(names).toContain('simpleFunc');
    expect(names).not.toContain('originalFunc');
  });

  it('handles default anonymous function and class exports with default fallback', () => {
    const code = `
      export default function() {
        return 1;
      }
      export default class {
        init() {}
      }
    `;
    const evidence = analyzeJsSource(code);
    const exportsList = evidence.normalized_result.exports as Array<{ name: string; type: string }>;
    const defaultExports = exportsList.filter((e) => e.type === 'default');
    expect(defaultExports.length).toBeGreaterThanOrEqual(1);
    expect(defaultExports.every((e) => e.name === 'default')).toBe(true);
    expect(defaultExports.some((e) => e.name === 'function' || e.name === 'class')).toBe(false);
  });

  it('analyzes JavaScript source directly via analyzeJsSource', () => {
    const code = `
      app.get('/health', (req, res) => res.send('ok'));
      eval('1 + 1');
    `;
    const evidence = analyzeJsSource(code, { language: 'javascript', target: 'direct.js' });
    expect(evidence.provenance.tool).toBe('analyze_javascript');
    expect(evidence.analysis_profile.target).toBe('direct.js');
    expect(evidence.normalized_result.routeList).toContain('GET /health');
    expect(evidence.normalized_result.sinkTypes).toContain('eval');
  });

  it('ensures boundary stride safety when windowOverlap >= windowSize', () => {
    const code = `
      app.get('/test', (req, res) => res.send('ok'));
    `.repeat(10);
    const evidence = analyzeJsSource(code, {
      windowSize: 1024,
      windowOverlap: 2048,
    });
    expect(evidence.normalized_result.routeList).toContain('GET /test');
  });

  it('segments exceptionally long lines into hashmap segments and records segmentation metadata', () => {
    const padding = ' '.repeat(500);
    const code = `app.get('/first', () => {});${padding}app.post('/second', () => {});`;
    const evidence = analyzeJsSource(code, { maxLineLength: 300 });

    const segmentation = evidence.normalized_result.segmentation as {
      didSegment: boolean;
      segmentedLines: Array<{ line: number; originalLength: number; segmentCount: number; segmentSize: number }>;
      totalSegments: number;
    };

    expect(segmentation.didSegment).toBe(true);
    expect(segmentation.segmentedLines.length).toBe(1);
    expect(segmentation.segmentedLines[0].line).toBe(1);
    expect(segmentation.segmentedLines[0].segmentSize).toBe(300);
    expect(segmentation.segmentedLines[0].segmentCount).toBeGreaterThanOrEqual(2);

    const routes = evidence.normalized_result.routes as Array<{ method: string; path: string; line?: number; segment?: number }>;
    const firstRoute = routes.find((r) => r.path === '/first');
    const secondRoute = routes.find((r) => r.path === '/second');

    expect(firstRoute).toBeDefined();
    expect(firstRoute?.segment).toBe(1);
    expect(secondRoute).toBeDefined();
    expect(secondRoute?.segment).toBeGreaterThan(1);
  });
});
