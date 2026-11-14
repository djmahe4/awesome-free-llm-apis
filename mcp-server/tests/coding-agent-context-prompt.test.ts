import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';
import { removeDir } from './helpers/temp-dir.js';

const model = vi.hoisted(() => ({ instructions: [] as string[] }));
vi.mock('../src/tools/local-llm-patch.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  localLlmPatch: async (request: { instruction: string }) => {
    model.instructions.push(request.instruction);
    return {
      success: true,
      patch: '<<<<<<< SEARCH\nexport function readZed() { return false; }\n=======\nexport function readZed() { return true; }\n>>>>>>> REPLACE',
    };
  },
}));

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await removeDir(root);
});

describe('coding-agent prompt gets live workspace context', () => {
  it('passes source excerpts and matching fresh log records to the patch model', async () => {
    model.instructions = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-context-prompt-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'logs'));
    const target = path.join(root, 'src', 'zed-reader.ts');
    fs.writeFileSync(target, 'export function readZed() { return false; }\n');
    fs.writeFileSync(path.join(root, 'src', 'dir-scanner.ts'), [
      'export function scanWorkspace() {',
      "  return 'SCANNER-IMPLEMENTATION';",
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'logs', 'zed.log'), 'ERROR ZED-42 thread decoding failed in workspace reader\n');

    const goal = 'Fix Zed reader thread decoding using src/dir-scanner.ts and the live error record';
    const result = {
      sessionId: 'prompt-test', goal, pipelineStage: 'edit', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
    } as unknown as CodingAgentsResult;
    const generated = await generateFilePatch({
      input: { goal, contextKeywords: ['ZED-42'] } as CodingAgentsInput,
      result,
      relPath: 'src/zed-reader.ts',
      fullPath: target,
      workspaceRoot: root,
      sessionId: 'prompt-test',
      resolvedModel: 'test-model',
      originalContent: fs.readFileSync(target, 'utf8'),
      activeGoal: goal,
      changeFiles: ['src/zed-reader.ts'],
      runContents: new Map(),
      editedInRun: new Set(),
    });

    expect(generated.patchedContent).toContain('return true;');
    expect(model.instructions[0]).toContain('SCANNER-IMPLEMENTATION');
    expect(model.instructions[0]).toContain('thread decoding failed');
    expect(model.instructions[0]).toContain('[Live workspace inventory');
  });

  it('uses active DAG API requirements to ground exact scanner and outline contracts', async () => {
    model.instructions = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-context-dag-'));
    roots.push(root);
    const harness = path.join(root, 'src', 'harness');
    fs.mkdirSync(harness, { recursive: true });
    const target = path.join(harness, 'zed-reader.ts');
    fs.writeFileSync(target, 'export function readZed() { return false; }\n');
    fs.writeFileSync(path.join(harness, 'dir-scanner.ts'), [
      'export interface ScannedFile { name: string; size: number; mtimeMs: number; }',
      'export interface ScannedFolder { path: string; depth: number; files: ScannedFile[]; }',
      'export interface ScanDirOptions { maxDepth?: number; }',
      'export interface DirScanResult { root: string; folders: ScannedFolder[]; }',
      'export class WorkspaceDirScanner {',
      '  scanDir(options: ScanDirOptions = {}): DirScanResult {',
      "    const marker = 'SCAN_DIR_BODY_MARKER';",
      '    void options; void marker;',
      '    return { root: "", folders: [] };',
      '  }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(harness, 'file-outline.ts'), [
      'export interface FileOutline { file: string; }',
      'export class FileStructureDag {',
      '  updateFile(filePath: string, source: string): FileOutline {',
      "    const marker = 'UPDATE_FILE_BODY_MARKER';",
      '    void source; void marker;',
      '    return { file: filePath };',
      '  }',
      '  render(filePaths: string[], maxChars = 8000): string {',
      "    const marker = 'RENDER_BODY_MARKER';",
      '    void filePaths; void maxChars; void marker;',
      "    return '';",
      '  }',
      '}',
    ].join('\n'));

    const goal = 'Create the Zed reader using current workspace APIs.';
    const task = {
      id: 'reader',
      task: 'Use WorkspaceDirScanner.scanDir(options: ScanDirOptions): DirScanResult and ScannedFile.name; update FileStructureDag with updateFile(filePath, source), then render(filePaths, maxChars). Do not invent renderOutlines.',
      status: 'in_progress' as const,
      targetFile: 'src/harness/zed-reader.ts',
      context: 'Use current source declarations as authority.',
    };
    const result = {
      sessionId: 'dag-context-test', goal, pipelineStage: 'edit', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
    } as unknown as CodingAgentsResult;
    await generateFilePatch({
      input: { goal } as CodingAgentsInput,
      result,
      relPath: 'src/harness/zed-reader.ts',
      fullPath: target,
      workspaceRoot: root,
      sessionId: 'dag-context-test',
      resolvedModel: 'test-model',
      originalContent: fs.readFileSync(target, 'utf8'),
      activeGoal: goal,
      objective: 'Recreate the workspace reader from live scanner and file-structure APIs.',
      loadedTasks: [task],
      nextPendingTask: task,
      changeFiles: ['src/harness/zed-reader.ts'],
      runContents: new Map(),
      editedInRun: new Set(),
    });

    const instruction = model.instructions[0];
    expect(instruction).toContain('scanDir(options: ScanDirOptions = {}): DirScanResult');
    expect(instruction).toContain('ScannedFile { name: string; size: number; mtimeMs: number; }');
    expect(instruction).toContain('updateFile(filePath: string, source: string): FileOutline');
    expect(instruction).toContain('render(filePaths: string[], maxChars = 8000): string');
    expect(instruction).toContain('SCAN_DIR_BODY_MARKER');
    expect(instruction).toContain('UPDATE_FILE_BODY_MARKER');
    expect(instruction).toContain('RENDER_BODY_MARKER');
  });
});
