import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildCodingAgentWorkspaceContext, sanitizeContextForCloud } from '../src/harness/coding-agent-context.js';
import { assertPatchPathAllowed, isProtectedWritePath } from '../src/harness/write-guard.js';
import { assertSafe } from '../src/tools/coding-agents/diff.js';
import { AGENT_THOUGHT_CONTEXT_APPROVAL, buildHypothesisBlackboard, buildTaskDagBlackboard, codingTaskSucceeded, hasAgentThoughtContextApproval, parseTasksMarkdown, validationTasksBlackboard, withAgentThoughtContextApproval, withHypothesisSummary } from '../src/tools/coding-agents/tasks.js';
import { formatCodingAgentsMarkdown } from '../src/tools/coding-agents/types.js';
import { scanCodingAgentContextFiles } from '../src/tools/coding-agents/session-wiring.js';
import { removeDir } from './helpers/temp-dir.js';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await removeDir(root);
});

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-context-'));
  roots.push(root);
  return root;
}

describe('coding-agent live context', () => {
  it('passes current matching log and JSON data without stale leftovers', () => {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, 'logs'));
    fs.mkdirSync(path.join(root, 'state'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'reader.ts'), 'export function readFailure() { return true; }\n');
    fs.writeFileSync(path.join(root, 'src', 'failure-reader.ts'), "export function getFailureDetails() { return 'diagnostic payload'; }\n");
    fs.writeFileSync(path.join(root, 'logs', 'service.log'), 'INFO startup\nERROR reader failure E-42: current diagnostic\n');
    fs.writeFileSync(path.join(root, 'state', 'recent.json'), JSON.stringify({ failure: { code: 'E-42', detail: 'reader failed with current payload' } }));
    const staleJson = path.join(root, 'state', 'old.json');
    fs.writeFileSync(staleJson, JSON.stringify({ failure: 'OLD-LEFTOVER-SHOULD-NOT-APPEAR' }));
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleJson, old, old);

    const context = buildCodingAgentWorkspaceContext({
      workspaceRoot: root,
      query: 'debug reader failure',
      targetFile: 'src/reader.ts',
      debugKeywords: ['E-42'],
    });

    expect(context).toContain('current diagnostic');
    expect(context).toContain('current payload');
    expect(context).toContain('readFailure');
    expect(context).toContain('diagnostic payload');
    expect(context).not.toContain('OLD-LEFTOVER-SHOULD-NOT-APPEAR');
  });

  it('scans the target directory directly when root traversal cannot reach it', () => {
    const root = tempWorkspace();
    const targetDir = path.join(root, 'one', 'two', 'three', 'four', 'five', 'six', 'harness');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'dir-scanner.ts'), "export function scanMarker() { return 'SCANNER_CONTEXT'; }\n");
    fs.writeFileSync(path.join(targetDir, 'file-outline.ts'), "export function outlineMarker() { return 'OUTLINE_CONTEXT'; }\n");
    const filler = 'x'.repeat(2200);
    fs.writeFileSync(path.join(targetDir, 'large-helper.ts'), `export function selectedHelper() { return 'BODY_MARKER' + '${filler}'; }\n`);

    const context = buildCodingAgentWorkspaceContext({
      workspaceRoot: root,
      query: 'Use scanMarker, outlineMarker, and selectedHelper from the current workspace.',
      targetFile: path.relative(root, path.join(targetDir, 'zed-reader.ts')),
    });

    expect(context).toContain('SCANNER_CONTEXT');
    expect(context).toContain('OUTLINE_CONTEXT');
    expect(context).toContain('BODY_MARKER');
    expect(context).toContain('[excerpt truncated]');
  });

  it('adds target-neighbor and explicitly referenced files to coding context without leaving workspace', async () => {
    const root = tempWorkspace();
    const sourceDir = path.join(root, 'src', 'harness');
    const testsDir = path.join(root, 'tests');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'dir-scanner.ts'), 'export class WorkspaceDirScanner {}\n');
    fs.writeFileSync(path.join(testsDir, 'reader.test.ts'), 'test marker\n');

    const files = await scanCodingAgentContextFiles(
      root,
      ['src/harness/new-reader.ts'],
      'Use WorkspaceDirScanner from src/harness/dir-scanner.ts and verify tests/reader.test.ts; ignore ../outside.ts.',
    );

    expect(files).toContain('src/harness/dir-scanner.ts');
    expect(files).toContain('tests/reader.test.ts');
    expect(files.some(file => file.startsWith('..'))).toBe(false);
  });

  it('includes exact requested API declarations even when outlines split at nested variables', () => {
    const root = tempWorkspace();
    const harness = path.join(root, 'src', 'harness');
    fs.mkdirSync(harness, { recursive: true });
    fs.writeFileSync(path.join(harness, 'dir-scanner.ts'), [
      'export function unrelatedNoise() { return true; }',
      'export interface ScannedFile {',
      '  name: string;',
      '  size: number;',
      '  mtimeMs: number;',
      '}',
      'export interface ScannedFolder {',
      '  files: ScannedFile[];',
      '}',
      'export interface ScanDirOptions { maxDepth?: number; }',
      'export interface DirScanResult {',
      '  root: string;',
      '  folders: ScannedFolder[];',
      '}',
      'export class WorkspaceDirScanner {',
      '  constructor(private readonly workspaceRoot: string) {}',
      '  scanDir(options: ScanDirOptions = {}): DirScanResult {',
      "    const marker = 'SCAN_DIR_BODY_MARKER';",
      '    void options; void marker;',
      '    return { root: this.workspaceRoot, folders: [] };',
      '  }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(harness, 'file-outline.ts'), [
      'export interface FileOutlineSymbol {',
      '  name: string;',
      '  line: number;',
      '}',
      'export interface FileOutline {',
      '  file: string;',
      '  outline: FileOutlineSymbol[];',
      '}',
      'export class FileStructureDag {',
      '  updateFile(filePath: string, source: string): FileOutline {',
      "    const marker = 'UPDATE_FILE_BODY_MARKER';",
      '    void source; void marker;',
      '    return { file: filePath, outline: [] };',
      '  }',
      '  render(filePaths: string[], maxChars = 8000): string {',
      "    const marker = 'RENDER_BODY_MARKER';",
      '    void filePaths; void maxChars; void marker;',
      "    return '';",
      '  }',
      '}',
    ].join('\n'));

    const context = buildCodingAgentWorkspaceContext({
      workspaceRoot: root,
      query: 'Use WorkspaceDirScanner.scanDir(options: ScanDirOptions): DirScanResult; use FileStructureDag.updateFile(filePath, source) and render(filePaths, maxChars).',
      targetFile: 'src/harness/new-reader.ts',
    });

    expect(context).toContain('scanDir(options: ScanDirOptions = {}): DirScanResult');
    expect(context).toContain('SCAN_DIR_BODY_MARKER');
    expect(context).toContain('files: ScannedFile[]');
    expect(context).toContain('  name: string;');
    expect(context).toContain('  mtimeMs: number;');
    expect(context).toContain('updateFile(filePath: string, source: string): FileOutline');
    expect(context).toContain('UPDATE_FILE_BODY_MARKER');
    expect(context).toContain('FileOutlineSymbol');
    expect(context).toContain('render(filePaths: string[], maxChars = 8000): string');
    expect(context).toContain('RENDER_BODY_MARKER');
    expect(context).not.toContain('unrelatedNoise');
  });

  it('does not load coding-agent smoke task fixtures as live JSON context', () => {
    const root = tempWorkspace();
    const fixtureDir = path.join(root, 'scripts', 'smoke', 'coding-agents-tasks', 'currency');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'task.json'), JSON.stringify({ goal: 'currency formatPrice task', staleMarker: 'STALE_CURRENCY_FIXTURE' }));

    const context = buildCodingAgentWorkspaceContext({
      workspaceRoot: root,
      query: 'debug currency formatPrice task',
    });

    expect(context).not.toContain('STALE_CURRENCY_FIXTURE');
    expect(context).not.toContain('Live file: scripts/smoke/coding-agents-tasks/currency/task.json');

    const debugContext = buildCodingAgentWorkspaceContext({
      workspaceRoot: root,
      query: 'debug task.json currency',
      debugKeywords: ['task.json', 'currency'],
    });
    expect(debugContext).not.toContain('STALE_CURRENCY_FIXTURE');
    expect(debugContext).not.toContain('Live file: scripts/smoke/coding-agents-tasks/currency/task.json');
  });

  it('includes actual matching SQLite sample values without sanitizing them', () => {
    const root = tempWorkspace();
    const db = new DatabaseSync(path.join(root, 'events.sqlite'));
    db.exec('CREATE TABLE failure_events (event_id TEXT, detail TEXT)');
    db.prepare('INSERT INTO failure_events VALUES (?, ?)').run('event-1', 'reader failure payload E-42');
    db.close();

    const context = buildCodingAgentWorkspaceContext({
      workspaceRoot: root,
      query: 'reader failure events',
      debugKeywords: ['E-42'],
    });
    expect(context).toContain('event-1');
    expect(context).toContain('reader failure payload E-42');
    expect(context).toContain('values preserved');

    // Cloud safety: row values can be suppressed via option or sanitized before cloud prompt dispatch
    const cloudSafeContext = buildCodingAgentWorkspaceContext({
      workspaceRoot: root,
      query: 'reader failure events',
      debugKeywords: ['E-42'],
      includeRowValues: false,
    });
    expect(cloudSafeContext).toContain('failure_events');
    expect(cloudSafeContext).toContain('row values redacted');
    expect(cloudSafeContext).not.toContain('reader failure payload E-42');

    const sanitized = sanitizeContextForCloud(context);
    expect(sanitized).toContain('failure_events');
    expect(sanitized).toContain('row values redacted for cloud');
    expect(sanitized).not.toContain('reader failure payload E-42');
  });
});

describe('DAG blackboard context', () => {
  it('leads with overall objective and active contract, then includes nearby task state', () => {
    const blackboard = buildTaskDagBlackboard([
      { id: 'task-1', task: 'Read scanner API', status: 'completed', targetFile: 'src/harness/dir-scanner.ts', log: ['resume#1 outcome=confirmed WorkspaceDirScanner.scanDir'] },
      { id: 'task-2', task: 'Implement Zed reader', status: 'in_progress', targetFile: 'src/harness/zed-reader.ts', context: 'Use WorkspaceDirScanner.scanDir and FileStructureDag.updateFile; keep SQLite read-only.', log: [] },
      { id: 'task-3', task: 'Add tests', status: 'pending', targetFile: 'tests/zed-reader.test.ts', context: 'Cover schema and error cases.', log: [] },
    ], 'task-2', 1200, { objective: 'Build coding-agent context from live workspace contracts.' });

    expect(blackboard).toContain('execute ACTIVE task only');
    expect(blackboard).toContain('OVERALL OBJECTIVE:\nBuild coding-agent context');
    expect(blackboard).toContain('ACTIVE task-2 target=src/harness/zed-reader.ts');
    expect(blackboard).toContain('FileStructureDag.updateFile');
    expect(blackboard).toContain('task-1 target=src/harness/dir-scanner.ts');
    expect(blackboard).toContain('outcome=confirmed WorkspaceDirScanner.scanDir');
    expect(blackboard).toContain('task-3 target=tests/zed-reader.test.ts');
    expect(blackboard.length).toBeLessThanOrEqual(1200);
  });

  it('keeps immediate predecessor and successor together under sliding-window budget pressure', () => {
    const tasks = Array.from({ length: 9 }, (_, index) => ({
      id: `task-${index + 1}`,
      task: index === 3 ? 'Active grounding task' : index === 2 ? 'Immediate predecessor' : index === 4 ? 'Immediate successor' : `Far task ${index + 1}`,
      status: index === 3 ? 'in_progress' as const : 'pending' as const,
    }));
    const blackboard = buildTaskDagBlackboard(tasks, 'task-4', 450, { windowRadius: 4 });

    expect(blackboard).toContain('task-3: Immediate predecessor');
    expect(blackboard).toContain('task-5: Immediate successor');
    expect(blackboard).not.toContain('task-1: Far task');
    expect(blackboard).toContain('omitted from context window');
    expect(blackboard.length).toBeLessThanOrEqual(450);
  });

  it('lets caller select extra known DAG tasks without changing the active task', () => {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      id: `task-${index + 1}`,
      task: index === 2 ? 'Active implementation task' : `Subtask ${index + 1}`,
      status: index === 2 ? 'in_progress' as const : 'pending' as const,
      targetFile: `src/task-${index + 1}.ts`,
      ...(index === 0 ? { context: 'Explicit contract: preserve legacy wire format.' } : {}),
      ...(index === 2 ? { log: ['active task latest outcome: API verified'] } : {}),
    }));
    const blackboard = buildTaskDagBlackboard(tasks, 'task-3', 1200, {
      objective: 'Ground implementation in live APIs and validator evidence.',
      windowRadius: 0,
      requestedTaskIds: ['task-1', 'task-3', 'unknown-task'],
    });

    expect(blackboard).toContain('OVERALL OBJECTIVE:\nGround implementation');
    expect(blackboard).toContain('ACTIVE task-3 target=src/task-3.ts');
    expect(blackboard).toContain('task-1 target=src/task-1.ts');
    expect(blackboard).toContain('Explicit contract: preserve legacy wire format.');
    expect(blackboard).toContain('Requested active-task history:\nactive task latest outcome: API verified');
    expect(blackboard).not.toContain('task-2 target=');
    expect(blackboard).not.toContain('unknown-task');
  });

  it('keeps pinned objective and active-task fields complete beyond the optional-row budget', () => {
    const objective = `Full objective begins\n${'O'.repeat(2500)}\nOBJECTIVE-END`;
    const task = { id: 'task-active', task: 'Active contract begins\nIMPLEMENTATION-END', status: 'in_progress' as const, context: 'Constraint begins\nCONSTRAINT-END' };
    const blackboard = buildTaskDagBlackboard([task], task.id, 2400, { objective });

    expect(blackboard).toContain(objective);
    expect(blackboard).toContain(task.task);
    expect(blackboard).toContain(task.context);
    expect(blackboard.length).toBeGreaterThan(2400);
  });

  it('prioritizes refuted hypotheses and reports omitted rows without slicing them', () => {
    const hypotheses = [
      { claim: 'A confirmed claim', probe: 'source:api', status: 'confirmed', evidence: 'api exists' },
      { claim: 'A false assumption must be rejected', probe: 'grep:unsafe-write', status: 'refuted', evidence: 'writer is read-only' },
      ...Array.from({ length: 8 }, (_, index) => ({ claim: `Open assumption ${index + 1}`, probe: `probe:${index + 1}`, status: 'open', evidence: 'not checked' })),
    ];
    const blackboard = buildHypothesisBlackboard(hypotheses, 600);
    const rows = blackboard.split('\n').slice(1);

    expect(blackboard).toContain('REFUTED: A false assumption must be rejected');
    expect(rows[0]).toMatch(/^- REFUTED:/);
    expect(blackboard).toContain('Omitted');
    expect(blackboard.length).toBeLessThanOrEqual(600);
    expect(rows.filter(row => row.startsWith('- ')).every(row => /(?:\[probe: .+\]|Omitted \d+ hypotheses)/.test(row))).toBe(true);
  });
});

describe('human context approval and write boundary', () => {
  it('requires the tasks.md checkbox for external agent-thought history', () => {
    const initial = withAgentThoughtContextApproval('# Tasks Plan: inspect');
    expect(hasAgentThoughtContextApproval(initial)).toBe(false);
    const approved = initial.replace(`[ ] ${AGENT_THOUGHT_CONTEXT_APPROVAL}`, `[x] ${AGENT_THOUGHT_CONTEXT_APPROVAL}`);
    expect(hasAgentThoughtContextApproval(approved)).toBe(true);
    const withValidation = withHypothesisSummary(approved, [{ claim: 'reader file exists', probe: 'file:src/reader.ts', status: 'refuted', evidence: 'file missing' }]);
    expect(withValidation).toContain('Hypothesis validation');
    expect(hasAgentThoughtContextApproval(withValidation)).toBe(true);
    const parsedTasks = parseTasksMarkdown(withAgentThoughtContextApproval('# Tasks Plan: inspect\n- [ ] [task-1] inspect reader'));
    expect(parsedTasks).toHaveLength(1);
    expect(parsedTasks[0].task).toBe('inspect reader');
    const response = formatCodingAgentsMarkdown({
      sessionId: 'test', goal: 'check assumptions', pipelineStage: 'completed', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false,
      hypotheses: [{ id: 'h1', claim: 'reader file exists', probe: 'file:src/reader.ts', status: 'refuted', evidence: 'file missing' }],
    });
    expect(response).toContain('Hypothesis Validation');
    expect(response).toContain('file missing');
  });

  it('keeps a failed or unapplied coding task pending', () => {
    expect(codingTaskSucceeded({ applied: false, diagnostics: [{ severity: 'error' }], patches: [{ unchanged: false }] })).toBe(false);
    expect(codingTaskSucceeded({ applied: false, diagnostics: [], patches: [] })).toBe(false);
    expect(codingTaskSucceeded({ applied: true, diagnostics: [], patches: [{ unchanged: false }] })).toBe(true);
    expect(codingTaskSucceeded({ applied: false, diagnostics: [], patches: [{ unchanged: true }] })).toBe(true);
  });

  it('uses tasks.md blackboard only when resuming a planned task', () => {
    const staleTasks = '# Tasks Plan: old currency task\n- [ ] stale requirement';
    expect(validationTasksBlackboard('run', staleTasks)).toBe('');
    expect(validationTasksBlackboard(undefined, staleTasks, [{ id: 'old', task: 'stale task', status: 'pending', log: [] }])).toBe('');
    expect(validationTasksBlackboard('resume', staleTasks)).toBe(staleTasks);
  });

  it('keeps tasks.md agent-uneditable and blocks lexical and symlink escapes', () => {
    const root = tempWorkspace();
    expect(isProtectedWritePath(root, path.join(root, 'tasks.md'))).toBe(true);
    expect(() => assertPatchPathAllowed(root, path.join(root, 'tasks.md'))).toThrow(/protected harness path/);
    expect(() => assertSafe(path.join(root, '..', 'outside.ts'), root)).toThrow(/outside/);

    const outside = tempWorkspace();
    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => assertSafe(path.join(link, 'new-file.ts'), root)).toThrow(/Symlink escape/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
    }
  });
});
