import { describe, it, expect } from 'vitest';
import { extractSymbolsAndFlow, formatGrepAstView, type SymbolNode } from '../src/reverse/grep-ast.js';

describe('Grep-AST Symbol Grounding & Flow Tracer', () => {
  it('extracts functions, classes, routes and calls in TypeScript/JavaScript', () => {
    const code = `
import express from 'express';
const app = express();

export class AuthService {
  async validateToken(token: string) {
    return this.verifySignature(token);
  }
  private verifySignature(t: string) {
    return eval(t);
  }
}

app.post('/api/login', (req, res) => {
  const auth = new AuthService();
  auth.validateToken(req.body.token);
});
`;

    const res = extractSymbolsAndFlow('src/auth.ts', code);
    expect(res.symbols.length).toBeGreaterThanOrEqual(3);

    const authClass = res.symbols.find(s => s.name === 'AuthService');
    expect(authClass).toBeDefined();
    expect(authClass?.kind).toBe('class');

    const evalSink = res.dangerousSinks.find(s => s.sink === 'eval');
    expect(evalSink).toBeDefined();
    expect(evalSink?.line).toBe(10);

    expect(res.callFlows).toContain('validateToken -> verifySignature');
    expect(res.callFlows).toContain('POST /api/login -> validateToken');
    expect(res.callFlows).not.toContain('POST /api/login -> post');
  });

  it('extracts functions, classes and arguments in Python code', () => {
    const pyCode = `
import argparse

class Scanner:
    def scan_target(self, target):
        self.execute_probe(target)

    def execute_probe(self, target):
        print(f"Scanning {target}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('-t', '--target', required=True)
    args = parser.parse_args()
    s = Scanner()
    s.scan_target(args.target)
`;

    const res = extractSymbolsAndFlow('scanner.py', pyCode);
    expect(res.symbols.some(s => s.name === 'Scanner' && s.kind === 'class')).toBe(true);
    expect(res.symbols.some(s => s.name === 'scan_target' && s.kind === 'function')).toBe(true);
    expect(res.callFlows).toContain('scan_target -> execute_probe');
    expect(res.flags).toContain('-t/--target');
  });

  it('generates condensed syntactic grep-ast view preserving hierarchy without noise', () => {
    const code = `
function helperStep(a: number) {
  return a * 2;
}

function complexAlgorithm(a: number, b: number) {
  // line 1 noise
  // line 2 noise
  const r = helperStep(a);
  return r + b;
}
`;
    const res = extractSymbolsAndFlow('algo.ts', code);
    const view = formatGrepAstView('algo.ts', res);

    expect(view).toContain('algo.ts');
    expect(view).toContain('complexAlgorithm');
    expect(view).toContain('helperStep');
  });

  it('excludes HTTP verbs, undeclared calls, and trailing code past last function', () => {
    const code = `
function stepOne() {
  return 1;
}

function lastFunction() {
  stepOne();
  undeclaredFunction();
}

// Trailing code at indent level 0
stepOne();
`;

    const res = extractSymbolsAndFlow('flow.ts', code);
    expect(res.callFlows).toContain('lastFunction -> stepOne');
    expect(res.callFlows).not.toContain('lastFunction -> undeclaredFunction');
    expect(res.callFlows).not.toContain('lastFunction -> lastFunction');
    expect(res.callFlows.filter(f => f.startsWith('lastFunction ->'))).toEqual(['lastFunction -> stepOne']);
  });

  it('does not claim trailing code past last function in Python', () => {
    const pyCode = `
def helper():
    pass

def last_worker():
    helper()

# Trailing top-level call at indent 0
helper()
`;

    const res = extractSymbolsAndFlow('worker.py', pyCode);
    expect(res.callFlows).toContain('last_worker -> helper');
    expect(res.callFlows.filter(f => f.startsWith('last_worker ->'))).toEqual(['last_worker -> helper']);
  });

  it('correctly traces call flows when function has return type annotation with braces', () => {
    const code = `
function helperStep(a: number) {
  return a * 2;
}

function foo(): { x: number } {
  return helperStep(1);
}
`;

    const res = extractSymbolsAndFlow('return-type.ts', code);
    expect(res.callFlows).toContain('foo -> helperStep');
  });

  it('correctly traces call flows when function has destructured parameters', () => {
    const code = `
function helperStep(a: number) {
  return a * 2;
}

function foo({ a }: { a: number }) {
  return helperStep(a);
}
`;

    const res = extractSymbolsAndFlow('destructured.ts', code);
    expect(res.callFlows).toContain('foo -> helperStep');
  });
});
