/**
 * Which input a tool action reads, as claims that can be checked against the handler source.
 *
 * Each entry says "action X uses field Y" and carries a probe (grep:<regex>@<file>) that finds the line in the
 * handler that proves it: an error message for a required field, or the line that reads an optional one. The
 * dashboard playground shows a field only for the actions listed here (`showFor`), so the form cannot offer an
 * input an action ignores or hide one it needs. tests/dashboard-showfor-hypotheses.test.ts runs every probe and
 * compares this table with dashboard/js/04-playground-form.js.
 *
 * Fields used by every action of a tool (sessionId, workspaceRoot) are left out: no `showFor` means always shown.
 */

export interface FieldUse {
  tool: string;
  field: string;
  /** Actions that read the field. */
  actions: string[];
  /** required: the handler throws or returns an error without it. read: it is used when present. */
  need: 'required' | 'read';
  /** grep:<regex>@<handler file> proving the use. */
  probe: string;
}

const BROWSER = 'src/browser/dispatch.ts';
const CYBER = 'src/tools/cyber-tool.ts';
const MOVIE = 'src/tools/movie-tool.ts';
const AGENTS = 'src/tools/coding-agents/pipeline.ts';
const AGENTS_HTTP = 'src/tools/coding-agents/http-input.ts';

const g = (pattern: string, file: string) => `grep:${pattern}@${file}`;

export const FIELD_USES: FieldUse[] = [
  // ---- browser_tool --------------------------------------------------------------------------------------------
  { tool: 'browser_tool', field: 'url', actions: ['navigate'], need: 'required', probe: g('navigate requires url', BROWSER) },
  { tool: 'browser_tool', field: 'url', actions: ['scrape'], need: 'read', probe: g('url', BROWSER) },
  { tool: 'browser_tool', field: 'userInstructions', actions: ['scrape'], need: 'read', probe: g('userInstructions', BROWSER) },
  { tool: 'browser_tool', field: 'outputDir', actions: ['screenshot', 'extract', 'api_replay', 'deep_scrape', 'checkpoint', 'scrape'], need: 'read', probe: g('defaultOutputDir', BROWSER) },

  // ---- cyber_tool ----------------------------------------------------------------------------------------------
  { tool: 'cyber_tool', field: 'toolName', actions: ['get_tool'], need: 'required', probe: g('toolName parameter required for get_tool', CYBER) },
  { tool: 'cyber_tool', field: 'toolName', actions: ['register_tool'], need: 'required', probe: g('toolName and url required for register_tool', CYBER) },
  { tool: 'cyber_tool', field: 'toolName', actions: ['wiki_lookup'], need: 'required', probe: g('toolName required for wiki_lookup', CYBER) },
  { tool: 'cyber_tool', field: 'toolName', actions: ['tool_memory'], need: 'required', probe: g('toolName required for tool_memory', CYBER) },
  { tool: 'cyber_tool', field: 'toolName', actions: ['learn', 'coach', 'resolve_tool'], need: 'read', probe: g('toolName', CYBER) },
  { tool: 'cyber_tool', field: 'githubUrl', actions: ['register_tool'], need: 'read', probe: g('githubUrl', CYBER) },
  { tool: 'cyber_tool', field: 'target', actions: ['osint'], need: 'required', probe: g('target is required and cannot be empty for osint', CYBER) },
  { tool: 'cyber_tool', field: 'target', actions: ['osint_status'], need: 'required', probe: g('target is required for osint_status', CYBER) },
  { tool: 'cyber_tool', field: 'target', actions: ['run_action'], need: 'required', probe: g('run_action requires actionName and target', CYBER) },
  { tool: 'cyber_tool', field: 'osintType', actions: ['osint'], need: 'read', probe: g('osintType', CYBER) },
  { tool: 'cyber_tool', field: 'autoSearch', actions: ['osint'], need: 'read', probe: g('autoSearch', CYBER) },
  { tool: 'cyber_tool', field: 'allowPrivateIps', actions: ['osint'], need: 'read', probe: g('allowPrivateIps', CYBER) },
  { tool: 'cyber_tool', field: 'goal', actions: ['learn'], need: 'required', probe: g('goal parameter required for learn', CYBER) },
  { tool: 'cyber_tool', field: 'goal', actions: ['coach'], need: 'read', probe: g('goal', CYBER) },
  { tool: 'cyber_tool', field: 'level', actions: ['learn', 'coach'], need: 'read', probe: g('level', CYBER) },
  { tool: 'cyber_tool', field: 'observation', actions: ['coach'], need: 'read', probe: g('observation', CYBER) },
  { tool: 'cyber_tool', field: 'graphNode', actions: ['save_graph'], need: 'read', probe: g('graphNode', CYBER) },
  { tool: 'cyber_tool', field: 'memoryOp', actions: ['tool_memory'], need: 'read', probe: g('memoryOp', CYBER) },
  { tool: 'cyber_tool', field: 'note', actions: ['tool_memory'], need: 'required', probe: g('note required for tool_memory write', CYBER) },
  { tool: 'cyber_tool', field: 'prompt', actions: ['resolve_tool'], need: 'read', probe: g('prompt', CYBER) },
  { tool: 'cyber_tool', field: 'source', actions: ['resolve_tool'], need: 'read', probe: g('source', CYBER) },
  { tool: 'cyber_tool', field: 'choice', actions: ['resolve_tool'], need: 'read', probe: g('choice', CYBER) },

  // ---- movie_tool ----------------------------------------------------------------------------------------------
  { tool: 'movie_tool', field: 'premise', actions: ['init_project'], need: 'required', probe: g('projectId and premise required for init_project', MOVIE) },
  { tool: 'movie_tool', field: 'premise', actions: ['propose_slots'], need: 'required', probe: g('premise required for propose_slots', MOVIE) },
  { tool: 'movie_tool', field: 'premise', actions: ['generate_story'], need: 'required', probe: g('premise or prompt required for generate_story', MOVIE) },
  { tool: 'movie_tool', field: 'prompt', actions: ['generate_assets'], need: 'required', probe: g('prompt required for generate_assets', MOVIE) },
  { tool: 'movie_tool', field: 'prompt', actions: ['generate_story'], need: 'required', probe: g('premise or prompt required for generate_story', MOVIE) },
  { tool: 'movie_tool', field: 'track', actions: ['generate_assets'], need: 'required', probe: g('track required for generate_assets', MOVIE) },
  { tool: 'movie_tool', field: 'track', actions: ['add_artifact'], need: 'required', probe: g('track, start_ms, and end_ms required for add_artifact', MOVIE) },
  { tool: 'movie_tool', field: 'track', actions: ['propose_slots', 'apply_effect'], need: 'read', probe: g('track', MOVIE) },
  { tool: 'movie_tool', field: 'start_ms', actions: ['add_artifact'], need: 'required', probe: g('track, start_ms, and end_ms required for add_artifact', MOVIE) },
  { tool: 'movie_tool', field: 'start_ms', actions: ['update_artifact_bounds'], need: 'required', probe: g('artifactId, start_ms, and end_ms required for update_artifact_bounds', MOVIE) },
  { tool: 'movie_tool', field: 'end_ms', actions: ['add_artifact'], need: 'required', probe: g('track, start_ms, and end_ms required for add_artifact', MOVIE) },
  { tool: 'movie_tool', field: 'end_ms', actions: ['update_artifact_bounds'], need: 'required', probe: g('artifactId, start_ms, and end_ms required for update_artifact_bounds', MOVIE) },
  { tool: 'movie_tool', field: 'label', actions: ['add_artifact'], need: 'read', probe: g('label', MOVIE) },
  { tool: 'movie_tool', field: 'artifact_path', actions: ['add_artifact', 'generate_assets'], need: 'read', probe: g('artifact_path', MOVIE) },
  { tool: 'movie_tool', field: 'artifactId', actions: ['reroll_artifact'], need: 'required', probe: g('artifactId required for reroll_artifact', MOVIE) },
  { tool: 'movie_tool', field: 'artifactId', actions: ['approve_artifact'], need: 'required', probe: g('artifactId required for approve_artifact', MOVIE) },
  { tool: 'movie_tool', field: 'artifactId', actions: ['apply_effect'], need: 'required', probe: g('artifactId required for apply_effect', MOVIE) },
  { tool: 'movie_tool', field: 'artifactId', actions: ['undo_effect'], need: 'required', probe: g('artifactId required for undo_effect', MOVIE) },
  { tool: 'movie_tool', field: 'artifactId', actions: ['update_artifact_bounds'], need: 'required', probe: g('artifactId, start_ms, and end_ms required for update_artifact_bounds', MOVIE) },

  // ---- coding_agents ('' is the default run, which behaves like execute) ----------------------------------------
  { tool: 'coding_agents', field: 'goal', actions: ['', 'plan', 'execute'], need: 'required', probe: g('Goal is required for coding_agents planning', AGENTS) },
  { tool: 'coding_agents', field: 'goal', actions: ['resume'], need: 'read', probe: g('input.goal', AGENTS) },
  { tool: 'coding_agents', field: 'topKFiles', actions: ['', 'plan', 'execute'], need: 'read', probe: g('topKFiles', AGENTS) },
  { tool: 'coding_agents', field: 'dryRun', actions: ['', 'execute', 'resume'], need: 'read', probe: g('dryRun', AGENTS) },
  { tool: 'coding_agents', field: 'pauseOnTaskPlan', actions: ['', 'execute'], need: 'read', probe: g('pauseOnTaskPlan', AGENTS) },
  { tool: 'coding_agents', field: 'verifyCommand', actions: ['', 'execute', 'resume'], need: 'read', probe: g('verifyCommand', AGENTS) },
  { tool: 'coding_agents', field: 'feedback', actions: ['', 'execute', 'resume'], need: 'read', probe: g('input.feedback', AGENTS) },
  { tool: 'coding_agents', field: 'verifyReport', actions: ['', 'execute', 'resume'], need: 'read', probe: g('verifyReport', AGENTS) },
  { tool: 'coding_agents', field: 'targetFiles', actions: ['', 'plan', 'execute', 'resume'], need: 'read', probe: g('input.targetFiles', AGENTS) },
  { tool: 'coding_agents', field: 'verifyLspDiagnostics', actions: ['', 'execute'], need: 'read', probe: g('verifyLspDiagnostics', AGENTS) },
  { tool: 'coding_agents', field: 'astEditOps', actions: ['', 'execute', 'resume'], need: 'read', probe: g('astEditOps', AGENTS) },
  { tool: 'coding_agents', field: 'resolve', actions: ['', 'execute', 'resume'], need: 'read', probe: g('input.resolve', AGENTS) },
  { tool: 'coding_agents', field: 'lspAction', actions: ['', 'execute'], need: 'read', probe: g('lspAction', AGENTS) },
];

/** Per tool, per field: the actions that use it (a field used for one of its actions only through `read` counts). */
export function showForTable(tool: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const u of FIELD_USES.filter(x => x.tool === tool)) {
    out[u.field] = [...new Set([...(out[u.field] ?? []), ...u.actions])];
  }
  return out;
}

export { AGENTS_HTTP };
