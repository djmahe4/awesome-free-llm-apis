import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodingAgentContextFiles } from '../src/tools/coding-agents/session-wiring.js';
import { deriveHypotheses } from '../src/tools/coding-agents/hypothesis-gate.js';
import { removeDir } from './helpers/temp-dir.js';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await removeDir(root);
});

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-subproject-'));
  roots.push(root);
  return root;
}

describe('TDD: Multi-subproject discovery and CTF/C-symbol hypothesis filtering', () => {
  describe('🔴 RED: scanCodingAgentContextFiles subproject directory & stem discovery', () => {
    it('discovers files in subproject directory mentioned in parentheses like (quant-blm)', async () => {
      const root = tempWorkspace();
      const quantDir = path.join(root, 'quant-blm', 'brain');
      const katanaDir = path.join(root, 'ctf-katana', 'agent');
      fs.mkdirSync(quantDir, { recursive: true });
      fs.mkdirSync(katanaDir, { recursive: true });

      fs.writeFileSync(path.join(quantDir, 'indexer.py'), 'def index_symbols(): pass\n');
      fs.writeFileSync(path.join(katanaDir, 'judge.py'), 'def assemble_context(): pass\n');
      fs.writeFileSync(path.join(katanaDir, 'skill_scan.py'), 'def scan(): pass\n');

      const files = await scanCodingAgentContextFiles(
        root,
        [],
        'Extend QBrain (quant-blm) to support Go language and extend ctf-katana judge context assembly',
      );

      // Should discover files from quant-blm and the judge module from ctf-katana
      expect(files).toContain('quant-blm/brain/indexer.py');
      expect(files).toContain('ctf-katana/agent/judge.py');
    });

    it('matches module stems when referenced without file extension (e.g. ctf-katana judge)', async () => {
      const root = tempWorkspace();
      const katanaDir = path.join(root, 'ctf-katana', 'agent');
      fs.mkdirSync(katanaDir, { recursive: true });
      fs.writeFileSync(path.join(katanaDir, 'judge.py'), 'def judge(): pass\n');
      fs.writeFileSync(path.join(katanaDir, 'propose.py'), 'def propose(): pass\n');

      const files = await scanCodingAgentContextFiles(
        root,
        [],
        'Refine ctf-katana/agent/judge and propose logic',
      );

      expect(files).toContain('ctf-katana/agent/judge.py');
      expect(files).toContain('ctf-katana/agent/propose.py');
    });
  });

  describe('🔴 RED: deriveHypotheses ignores C stdlib and target binary/challenge symbols', () => {
    it('does not create defined: probes for C stdlib symbols like fgets, printf, memcpy', () => {
      const hypotheses = deriveHypotheses({
        goal: 'Fix buffer overflow check when `fgets` and `memcpy` read user input',
        files: ['ctf-katana/agent/propose.py'],
      });

      const probes = hypotheses.map(h => h.probe);
      expect(probes).not.toContain('defined:fgets');
      expect(probes).not.toContain('defined:memcpy');
    });

    it('does not create defined: probes for challenge binary symbols (e.g. do_stuff(), win()) mentioned in CTF goals', () => {
      const hypotheses = deriveHypotheses({
        goal: 'Investigate exploit payload where do_stuff() calls win() in CTF challenge binary',
        files: ['ctf-katana/agent/propose.py'],
      });

      const probes = hypotheses.map(h => h.probe);
      expect(probes).not.toContain('defined:do_stuff');
      expect(probes).not.toContain('defined:win');
    });
  });
});
