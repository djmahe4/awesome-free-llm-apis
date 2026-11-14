import path from 'node:path';
import { type TaskItem } from './types.js';

import { splitSteps } from './goal-steps.js';

function decomposeGoalToTasks(goal: string): TaskItem[] {
  const lines = goal.split('\n').map(l => l.trim()).filter(Boolean);
  const listMarker = /^\s*(?:\d+[.)\-]|[-*])\s+/;
  const items: string[] = [];
  for (const line of lines) {
    // Only lines actually PREFIXED with a numbered/bulleted marker count as
    // separate items — a plain prose line (e.g. an intro sentence before the
    // numbered list) previously fell through .replace() unchanged and still
    // got pushed as its own bogus task, since replace() on a non-match is a
    // no-op, not a skip. Observed live: a goal like "Do these N fixes:\n1. ..."
    // produced N+1 tasks, the intro line becoming a fabricated task-1.
    if (!listMarker.test(line)) continue;
    const clean = line.replace(listMarker, '').trim();
    if (clean) items.push(clean);
  }
  const steps = splitSteps(goal);
  const taskStrings = items.length >= 2 ? items : (steps.length > 0 ? steps : [goal]);
  return taskStrings.map((task, idx) => ({
    id: `task-${idx + 1}`,
    task,
    status: 'pending' as const,
    log: [],
  }));
}

/**
 * LLM-driven subtask decomposition. Uses the cloud model (useFreeLLM), not the
 * local coder model — this is a planning/reasoning task, and the local model
 * (already proven weak at multi-file/architectural reasoning elsewhere in this
 * pipeline) is the wrong tool for it.
 *
 * Two-phase, not one LLM call that both splits AND annotates:
 *   Phase 1 (deterministic): if the goal is already an explicit enumerated
 *     list (numbered/bulleted lines, >=2 items), extract those items VERBATIM
 *     via decomposeGoalToTasks — plain text parsing, zero hallucination risk.
 *     The LLM never gets a chance to drop, reorder, or invent items when the
 *     caller already told us exactly what they are.
 *   Phase 2 (LLM, annotation-only): ask the model only to fill in
 *     targetFile/context for that FIXED list, one line per index, and
 *     validate the response has exactly the same number of entries in the
 *     same order before trusting any of it — a malformed or wrong-length
 *     response is discarded wholesale rather than partially applied,
 *     falling back to un-annotated tasks (still the full correct set).
 * Only when the goal is a single unstructured paragraph (no explicit list)
 * does the LLM get to propose the task breakdown itself — genuinely
 * ambiguous input has no safe deterministic alternative.
 *
 * Observed live: a goal with 5 explicitly numbered subtasks, decomposed via
 * the old single-call approach, came back with 2 of the 5 dropped and 2
 * unrelated ones invented in their place — this two-phase split exists
 * specifically to make that failure mode structurally impossible for any
 * goal that already enumerates its own subtasks.
 */
export async function decomposeGoalIntelligently(
  goal: string,
  workspaceRoot: string,
  candidateFiles: string[],
  sessionId: string,
): Promise<TaskItem[]> {
  const naiveTasks = decomposeGoalToTasks(goal);
  const goalIsExplicitlyEnumerated = naiveTasks.length >= 2;

  if (goalIsExplicitlyEnumerated) {
    return await annotateFixedTaskList(naiveTasks, workspaceRoot, candidateFiles, sessionId);
  }

  try {
    const { useFreeLLM } = await import('../use-free-llm.js');
    const fileList = candidateFiles.slice(0, 60).join('\n');
    const prompt = [
      `Break the following goal into an ordered list of small, independent subtasks, one per file that needs to change.`,
      `Return ONLY a JSON array, no prose, no code fence, no explanation. Each element:`,
      `{ "task": "<imperative, self-contained instruction for this one subtask>", "targetFile": "<relative path from the candidate list, omit if this subtask has no single target file>", "context": "<1-3 sentences: why this file, what it must respect or not break, dependencies on other subtasks>" }`,
      `If the goal is already a single small single-file change, return a single-element array.`,
      `## Goal\n${goal}`,
      `## Candidate files in this workspace (pick from these when possible)\n${fileList || '(none enumerated)'}`,
    ].join('\n\n');

    const res = await useFreeLLM({
      messages: [
        { role: 'system', content: 'You are a senior engineer decomposing a coding goal into an execution plan. Output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      taskType: 'reasoning',
      workspace_root: workspaceRoot,
      sessionId,
      isOnePass: true,
      skipIndexing: true,
    } as any);

    const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
    if (!raw || typeof raw !== 'string') throw new Error('Empty planner response');

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Planner response contained no JSON array');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Planner returned an empty/invalid array');

    const tasks: TaskItem[] = parsed
      .map((item: any, idx: number): TaskItem => ({
        id: `task-${idx + 1}`,
        task: String(item?.task || '').trim(),
        status: 'pending' as const,
        targetFile: item?.targetFile ? path.normalize(String(item.targetFile).trim()).replace(/\\/g, '/') : undefined,
        context: item?.context ? String(item.context).trim() : undefined,
        log: [],
      }))
      .filter(t => t.task.length > 0);

    if (tasks.length === 0) throw new Error('Planner returned no usable tasks');
    return tasks;
  } catch (err: any) {
    console.warn(`[coding-agents] Intelligent decomposition failed, falling back to naive split: ${err.message}`);
    return naiveTasks;
  }
}

/** Phase 2 of decomposeGoalIntelligently: annotate an already-fixed task list
 * with targetFile/context, without letting the LLM change the list itself. */
async function annotateFixedTaskList(
  tasks: TaskItem[],
  workspaceRoot: string,
  candidateFiles: string[],
  sessionId: string,
): Promise<TaskItem[]> {
  try {
    const { useFreeLLM } = await import('../use-free-llm.js');
    const fileList = candidateFiles.slice(0, 60).join('\n');
    const taskList = tasks.map((t, i) => `${i}: ${t.task}`).join('\n');
    const prompt = [
      `These ${tasks.length} subtasks are already fixed and final — do not add, remove, reorder, merge, or reword any of them.`,
      `For EACH one, in the same order, provide only its target file and short context.`,
      `Return ONLY a JSON array of exactly ${tasks.length} elements, no prose, no code fence. Element i corresponds to subtask i:`,
      `{ "targetFile": "<relative path from the candidate list, or null if this subtask has no single target file>", "context": "<1-3 sentences: why this file, what it must respect or not break, dependencies on other subtasks>" }`,
      `## Fixed subtasks (index: text)\n${taskList}`,
      `## Candidate files in this workspace (pick from these when possible)\n${fileList || '(none enumerated)'}`,
    ].join('\n\n');

    const res = await useFreeLLM({
      messages: [
        { role: 'system', content: 'You annotate an already-decided task list with file/context metadata only. You never change the list itself. Output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      taskType: 'reasoning',
      workspace_root: workspaceRoot,
      sessionId,
      isOnePass: true,
      skipIndexing: true,
    } as any);

    const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
    if (!raw || typeof raw !== 'string') throw new Error('Empty annotator response');

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Annotator response contained no JSON array');
    const parsed = JSON.parse(jsonMatch[0]);
    // Wrong length is discarded wholesale, not zipped partially — a
    // mismatched-length response means the model didn't follow the fixed-list
    // constraint and can't be trusted to have kept index alignment either.
    if (!Array.isArray(parsed) || parsed.length !== tasks.length) {
      throw new Error(`Annotator returned ${Array.isArray(parsed) ? parsed.length : 'non-array'}, expected exactly ${tasks.length}`);
    }

    return tasks.map((t, i) => {
      const ann = parsed[i];
      return {
        ...t,
        targetFile: ann?.targetFile ? path.normalize(String(ann.targetFile).trim()).replace(/\\/g, '/') : undefined,
        context: ann?.context ? String(ann.context).trim() : undefined,
      };
    });
  } catch (err: any) {
    console.warn(`[coding-agents] Task annotation failed, using un-annotated (but complete and correct) task list: ${err.message}`);
    return tasks;
  }
}

export const AGENT_THOUGHT_CONTEXT_APPROVAL = 'Include matching agent thought history (read-only local sessions)';

function replaceMarkdownSection(markdown: string, heading: string, body: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:\\n+|^)## ${escaped}\\n[\\s\\S]*?(?=\\n## |$)`, 'i');
  const next = body ? `\n\n## ${heading}\n${body}` : '';
  if (pattern.test(markdown)) return markdown.replace(pattern, next);
  return body ? `${markdown.trimEnd()}${next}\n` : markdown;
}

export function withAgentThoughtContextApproval(markdown: string, approved = false): string {
  return replaceMarkdownSection(markdown, 'Context permissions', `- [${approved ? 'x' : ' '}] ${AGENT_THOUGHT_CONTEXT_APPROVAL}`);
}

export function withHypothesisSummary(
  markdown: string,
  hypotheses: Array<{ claim: string; probe: string; status: string; evidence?: string }>,
): string {
  const body = hypotheses.length
    ? hypotheses.map(h => `- **${h.status.toUpperCase()}** ${h.claim.replace(/\s+/g, ' ')} — \`${h.probe.replace(/`/g, '\\`')}\`${h.evidence ? ` — ${h.evidence.replace(/\s+/g, ' ')}` : ''}`).join('\n')
    : '';
  return replaceMarkdownSection(markdown, 'Hypothesis validation', body);
}

export function hasAgentThoughtContextApproval(markdown: string): boolean {
  const escapedLabel = AGENT_THOUGHT_CONTEXT_APPROVAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*-\\s*\\[x\\]\\s*${escapedLabel}\\s*$`, 'im').test(markdown);
}

export function validationTasksBlackboard(
  action: string | undefined,
  tasksMarkdown?: string,
  loadedTasks?: TaskItem[],
): string {
  if (action !== 'resume') return '';
  if (tasksMarkdown !== undefined) return tasksMarkdown.slice(-5000);
  return loadedTasks?.map(task => `- [${task.status}] ${task.task}${task.context ? ` — ${task.context}` : ''}`).join('\n') ?? '';
}

export function codingTaskSucceeded(result: {
  applied: boolean;
  error?: string;
  diagnostics: Array<{ severity: string }>;
  patches: Array<{ unchanged?: boolean }>;
}): boolean {
  if (result.error || result.diagnostics.some(diagnostic => diagnostic.severity === 'error')) return false;
  return result.applied || (result.patches.length > 0 && result.patches.every(patch => patch.unchanged));
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function compactText(value: string, maxChars: number): string {
  const text = singleLine(value);
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function buildHypothesisBlackboard(
  hypotheses: Array<{ claim: string; probe: string; status: string; evidence?: string }>,
  maxChars = 1600,
): string {
  if (hypotheses.length === 0 || maxChars < 200) return '';
  const statusOrder: Record<string, number> = { refuted: 0, confirmed: 1, open: 2 };
  const ordered = hypotheses.map((hypothesis, index) => ({ hypothesis, index }))
    .sort((a, b) => (statusOrder[a.hypothesis.status] ?? 3) - (statusOrder[b.hypothesis.status] ?? 3) || a.index - b.index);
  const header = '[Hypothesis gate: refuted assumptions must not be used; confirmed claims use listed evidence; open claims remain unverified.]';
  const rowFor = (hypothesis: typeof hypotheses[number]): string => {
    const status = statusOrder[hypothesis.status] === undefined ? 'OPEN' : hypothesis.status.toUpperCase();
    const claim = singleLine(hypothesis.claim);
    const probe = singleLine(hypothesis.probe).replace(/`/g, "'");
    const evidence = hypothesis.evidence ? ` — evidence: ${singleLine(hypothesis.evidence)}` : '';
    return `- ${status}: ${claim} [probe: ${probe}]${evidence}`;
  };
  const required = ordered.filter(({ hypothesis }) => hypothesis.status === 'refuted').map(({ hypothesis }) => rowFor(hypothesis));
  const optional = ordered.filter(({ hypothesis }) => hypothesis.status !== 'refuted')
    .map(({ hypothesis }) => ({ status: statusOrder[hypothesis.status] === undefined ? 'OPEN' : hypothesis.status.toUpperCase(), row: rowFor(hypothesis) }));
  const keptOptional: typeof optional = [];
  const omittedByStatus: Record<string, number> = { CONFIRMED: 0, OPEN: 0 };
  let used = header.length + required.reduce((total, row) => total + row.length + 1, 0);
  for (const item of optional) {
    if (used + item.row.length + 1 <= maxChars) {
      keptOptional.push(item);
      used += item.row.length + 1;
    } else {
      omittedByStatus[item.status in omittedByStatus ? item.status : 'OPEN']++;
    }
  }
  let omitted = omittedByStatus.CONFIRMED + omittedByStatus.OPEN;
  while (omitted > 0) {
    const note = `- Omitted ${omitted} hypotheses (C:${omittedByStatus.CONFIRMED} O:${omittedByStatus.OPEN}); see validation report.`;
    if (used + note.length + 1 <= maxChars || keptOptional.length === 0) break;
    const removed = keptOptional.pop()!;
    used -= removed.row.length + 1;
    omittedByStatus[removed.status in omittedByStatus ? removed.status : 'OPEN']++;
    omitted++;
  }
  const output = [header, ...required, ...keptOptional.map(item => item.row)];
  if (omitted > 0) {
    output.push(`- Omitted ${omitted} hypotheses (C:${omittedByStatus.CONFIRMED} O:${omittedByStatus.OPEN}); see validation report.`);
  }
  return output.join('\n');
}

export interface TaskDagBlackboardOptions {
  objective?: string;
  windowRadius?: number;
  requestedTaskIds?: string[];
}

export function buildTaskDagBlackboard(
  tasks: TaskItem[],
  activeTaskId?: string,
  maxChars = 2400,
  options: TaskDagBlackboardOptions = {},
): string {
  if (tasks.length === 0 || maxChars < 200) return '';
  const activeIndex = Math.max(0, tasks.findIndex(task => task.id === activeTaskId || (!activeTaskId && task.status === 'in_progress')));
  const active = tasks[activeIndex];
  if (!active) return '';

  const requestedRadius = options.windowRadius ?? 1;
  const radius = Number.isFinite(requestedRadius) ? Math.max(0, Math.min(5, Math.floor(requestedRadius))) : 1;
  const requestedIds = Array.from(new Set(options.requestedTaskIds ?? [])).slice(0, 8);
  const requestedIndexes = requestedIds
    .map(id => tasks.findIndex(task => task.id === id))
    .filter(index => index >= 0 && index !== activeIndex);
  const unknownRequestedCount = requestedIds.filter(id => !tasks.some(task => task.id === id)).length;
  const output = [
    '[DAG blackboard: execute ACTIVE task only; do not start pending tasks. Live source and tests are authority; history is advisory. Do not invent APIs or imports.]',
    ...(options.objective ? [`OVERALL OBJECTIVE:\n${options.objective.trim()}`] : []),
    `ACTIVE ${active.id}${active.targetFile ? ` target=${active.targetFile}` : ''}:\n${active.task.trim()}`,
    ...(active.context ? [`Constraints:\n${active.context.trim()}`] : []),
    ...(requestedIds.includes(active.id) ? [`Requested active-task history:\n${active.log?.at(-1)?.trim() ?? '[no prior outcome recorded]'}`] : []),
    `Task context (sliding radius=${radius}; requested IDs are read-only selections):`,
  ];
  let used = output.join('\n').length;
  const selected = new Map<number, string>();
  const rowFor = (task: TaskItem, detailed = false): string => {
    const mark = task.status === 'completed' ? 'x' : task.status === 'in_progress' ? '~' : task.status === 'failed' ? '!' : ' ';
    const target = task.targetFile ? ` target=${task.targetFile}` : '';
    const latest = task.log?.at(-1);
    const prefix = `- [${mark}] ${task.id}${target}`;
    if (detailed) {
      return `${prefix}\n  Task: ${task.task.trim()}${task.context ? `\n  Context: ${task.context.trim()}` : ''}${latest ? `\n  Latest outcome: ${latest.trim()}` : ''}`;
    }
    return `${prefix}: ${compactText(task.task, 180)}${latest ? ` | last: ${compactText(latest, 160)}` : ''}`;
  };
  const selectionBudget = Math.max(used, maxChars - 96);
  const omittedIndexes = new Set<number>();

  const neighborIndexes = radius >= 1 ? [activeIndex - 1, activeIndex + 1].filter(index => index >= 0 && index < tasks.length) : [];
  const neighborRows = neighborIndexes.map(index => ({ index, row: rowFor(tasks[index]) }));
  const neighborChars = neighborRows.reduce((total, entry) => total + entry.row.length + 1, 0);
  let canExpandWindow = true;
  if (used + neighborChars <= selectionBudget) {
    for (const entry of neighborRows) {
      selected.set(entry.index, entry.row);
      used += entry.row.length + 1;
    }
  } else {
    neighborIndexes.forEach(index => omittedIndexes.add(index));
    canExpandWindow = false;
  }

  for (const index of requestedIndexes) {
    const previous = selected.get(index);
    if (previous) used -= previous.length + 1;
    const row = rowFor(tasks[index], true);
    selected.set(index, row);
    used += row.length + 1;
  }

  for (let distance = 2; canExpandWindow && distance <= radius; distance++) {
    const ring = tasks.map((_, index) => index).filter(index => Math.abs(index - activeIndex) === distance && !selected.has(index));
    const ringRows = ring.map(index => ({ index, row: rowFor(tasks[index]) }));
    const ringChars = ringRows.reduce((total, entry) => total + entry.row.length + 1, 0);
    if (used + ringChars > selectionBudget) {
      tasks.forEach((_, index) => {
        if (Math.abs(index - activeIndex) >= distance && !selected.has(index)) omittedIndexes.add(index);
      });
      break;
    }
    for (const entry of ringRows) {
      selected.set(entry.index, entry.row);
      used += entry.row.length + 1;
    }
  }

  output.push(...Array.from(selected.entries()).sort(([a], [b]) => a - b).map(([, row]) => row));
  const omitted = omittedIndexes.size;
  if (omitted > 0) output.push(`- ${omitted} task(s) omitted from context window; tasks.md remains authoritative.`);
  if (unknownRequestedCount > 0) output.push(`- ${unknownRequestedCount} requested task ID(s) were not found in tasks.md.`);
  return output.join('\n');
}

export function serializeTasksMarkdown(goal: string, tasks: TaskItem[]): string {
  const firstLine = goal.split('\n')[0].replace(/^#+\s*/, '');
  const lines = [`# Tasks Plan: ${firstLine}\n`];
  for (const t of tasks) {
    const check = t.status === 'completed' ? '[x]' : (t.status === 'in_progress' ? '[~]' : '[ ]');
    lines.push(`- ${check} [${t.id}] ${t.task}`);
    if (t.targetFile) lines.push(`  - file: ${t.targetFile}`);
    if (t.context) lines.push(`  - context: ${t.context}`);
    if (t.log && t.log.length > 0) {
      lines.push(`  - log:`);
      for (const entry of t.log) lines.push(`    - ${entry}`);
    }
  }
  return lines.join('\n');
}

/** Parses tasks.md back, including the per-task file/context metadata and the
 * blackboard log — a simple line-state-machine since each task can span
 * several indented lines, not just its own checkbox line. */
export function parseTasksMarkdown(content: string): TaskItem[] {
  const lines = content.split(/\r?\n/);
  const tasks: TaskItem[] = [];
  let current: TaskItem | null = null;
  let inLog = false;
  for (const line of lines) {
    const taskMatch = line.match(/^-\s*\[([ xX~])\]\s*(?:\[([^\]]+)\])?\s*(.+)$/);
    if (taskMatch) {
      if (taskMatch[3].trim() === AGENT_THOUGHT_CONTEXT_APPROVAL) continue;
      const mark = taskMatch[1].toLowerCase();
      const status: TaskItem['status'] = mark === 'x' ? 'completed' : (mark === '~' ? 'in_progress' : 'pending');
      const id = taskMatch[2] || `task-${tasks.length + 1}`;
      const task = taskMatch[3].trim();
      current = { id, task, status, log: [] };
      tasks.push(current);
      inLog = false;
      continue;
    }
    if (!current) continue;
    const fileMatch = line.match(/^\s{2}-\s*file:\s*(.+)$/);
    if (fileMatch) { current.targetFile = fileMatch[1].trim(); inLog = false; continue; }
    const contextMatch = line.match(/^\s{2}-\s*context:\s*(.+)$/);
    if (contextMatch) { current.context = contextMatch[1].trim(); inLog = false; continue; }
    if (/^\s{2}-\s*log:\s*$/.test(line)) { inLog = true; continue; }
    const logEntryMatch = line.match(/^\s{4}-\s*(.+)$/);
    if (inLog && logEntryMatch) {
      (current.log ??= []).push(logEntryMatch[1].trim());
      continue;
    }
  }
  return tasks;
}

/** Recovers the original plan goal recorded in a tasks.md header, so resume calls don't overwrite it with a per-task or stale `input.goal`. */
export function extractGoalFromTasksMarkdown(content: string): string | undefined {
  const match = content.match(/^#\s*Tasks Plan:\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

export function extractCodeBlock(text: string): string {
  const fenced = text.match(/```(?:[a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/);
  if (fenced) return fenced[1];
  // No closing fence found (truncated cloud response) — regex above needs
  // BOTH fences to match at all, so an unclosed opening fence previously fell
  // through to returning `text` completely unstripped, leaving a literal
  // "```\n<!DOCTYPE html>..." at the top of the applied file. Strip a leading
  // opening-fence line on its own even with no matching close.
  const openOnly = text.match(/^```[a-zA-Z0-9_+-]*\r?\n([\s\S]*)$/);
  return openOnly ? openOnly[1] : text;
}

/**
 * Sliding-window context extractor for large non-module files (HTML, classic JS).
 * Scores each line by how many instruction terms it contains, then returns
 * the best ~120-line window + the surrounding line indices so the caller can
 * splice the patched window back into the full content.
 * Returns null when the file is small enough to send whole.
 */
