import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { useFreeLLM } from '../tools/use-free-llm.js';
import { visionTool } from '../tools/vision-tool.js';
import { loadSkillPrompt } from '../tools/load-skill-prompt.js';
import { executeSkill } from '../tools/execute-skill.js';
// v1.0.5 Deprecated: Unnecessary feature (Remove this comment and import in new update)
//import { listAvailableFreeModels } from '../tools/list-models.js';
// v1.0.5 Deprecated: Unnecessary feature (DO NOT REMOVE THE CODE COMMENT)
//import { runCodeMode } from '../tools/code-mode.js';
import { manageMemory } from '../tools/manage-memory.js';
import { getTokenStats } from '../tools/get-token-stats.js';
import { validateProvider } from '../tools/validate-provider.js';
import { indexWorkspace } from '../tools/index-workspace.js';
import { toMarkdownResponse } from '../utils/markdown.js';
import { logToolCall } from '../utils/ChatLogger.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { actionEnum, renderActionDocs } from '../browser/actionSchemas.js';
import { dispatchBrowserAction } from '../browser/dispatch.js';
import { getBrowserSessionPool } from '../browser/BrowserSessionPool.js';

/** Derive a stable ws-<hash> session ID from tool args, falling back to __no_ws__. */
async function deriveSessionIdFromArgs(args: Record<string, any> | null | undefined): Promise<string> {
  const explicitSid = (args?.sessionId || '').toString().trim();
  if (explicitSid) return explicitSid;
  const ws: string = (args?.workspace_root || args?.workspaceDir || args?.workspaceRoot || '').toString().trim();
  if (!ws) return '__no_ws__';
  try {
    const hash = await new WorkspaceScanner(process.cwd()).getWorkspaceHash(ws);
    return `ws-${hash.substring(0, 16)}`;
  } catch {
    return '__no_ws__';
  }
}

export async function createMCPServer(): Promise<Server> {
  const server = new Server(
    { name: 'free-llm-apis', version: '1.0.8' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'use_free_llm',
        description: [
          'Universal chat interface for all free LLM providers with automatic failover.',
          '',
          'USER STORY: Send a prompt to any free LLM model. If the chosen model or provider is',
          'unavailable (rate-limited, missing key, network error), the pipeline automatically',
          'falls back through a prioritized list of free models until one succeeds.',
          '',
          'WHEN TO USE: For any natural-language task — summarization, code review, Q&A, translation.',
          'Use explicit keywords to help the router choose the best model and documentation.',
          '',
          '⚠️  PROJECT WORK RULE: When performing ANY task scoped to a project or workspace, you MUST',
          '  include BOTH `workspace_root` (absolute path) AND `agentic: true`. Omitting these fields',
          '  disables all memory injection, context enrichment, and session persistence — the response',
          '  will be blind to all prior work. A bare call with only `messages` is for one-off queries only.',
          '',
          'INPUTS:',
          '  messages (required)           — Array of {role, content}. Roles: "system" | "user" | "assistant".',
          '  model (optional)              — Specific model ID. If omitted, the router picks the best for the task.',
          '  keywords (optional)           — Explicit steering tags (e.g. ["api", "sql"]) to prioritize reference map injection.',
          '  agentic (optional)            — Enable agentic mode (task decomposition + memory injection).',
          '                                  Set to true for all project-scoped requests.',
          '  sessionId (optional)          — Unique session slug (e.g. UUID or "my-project"). Partitions state/logs.',
          '                                  Auto-derived from workspace_root if omitted.',
          '  workspace_root (recommended)  — Absolute path to the project root.',
          '                                  Required to enable memory enrichment, context retrieval,',
          '                                  and workspace-scoped recall. Always provide for project tasks.',
          '  google_search (optional)      — Enable Google search for Gemini models (default false).',
          '',
          'OUTPUTS: Assistant response text enriched with workspace memory when agentic=true + workspace_root.',
          '         Multiple choices are labeled AGENT RESPONSE 1, AGENT RESPONSE 2, etc.',
          '         Metadata (model, usage, id) is stripped to keep context lean.',
          '',
          'FAILURE STATES:',
          '  - "No providers available": all fallback models exhausted. Check `get_token_stats`.',
          '  - "Rate limited": provider quota exceeded. Use another model or try later.',
          '  - Context-blind response: missing workspace_root or agentic — memory pipeline was bypassed.',
          '',
          'EXAMPLE (project task — correct):',
          '  { "messages": [...], "agentic": true, "workspace_root": "/abs/path/to/project", "keywords": ["python"] }',
          '',
          'EXAMPLE (one-off query — no memory needed):',
          '  { "messages": [{ "role": "user", "content": "What is a monoid?" }] }',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                  content: { type: 'string' },
                },
                required: ['role', 'content'],
              },
              description: 'Conversation messages. Always include at least one user message.',
            },
            model: { type: 'string', description: 'Specific model request. If omitted, the router picks the best model for the task.' },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicit steering tags to prioritize/filter documentation sections from reference maps.'
            },
            agentic: { type: 'boolean', description: 'Enable agentic mode: task decomposition and intelligent system prompt injection' },
            sessionId: { type: 'string', description: 'Unique session identifier required for agentic mode (e.g. UUID or project slug). Partitions state and logs per project.' },
            workspace_root: { type: 'string', description: 'Workspace path for cache-keying and auto-sessionId derivation' },
            google_search: { type: 'boolean', description: 'Enable Google search for Gemini models (default false)' },
            skill: { type: 'string', description: 'Optional skill id/name loaded dynamically from remote skill index' },
            skipIndexing: {
              type: 'boolean',
              description: 'Skip the pre-emptive full-workspace re-index + wiki-maintenance pass that agentic mode normally runs on every call with workspace_root. Set true for requests narrowly about a specific file/PDF reference that don\'t need (or shouldn\'t pay the latency/provider-budget cost of) a full codebase re-scan — otherwise that unrelated indexing work can starve the actual request of provider quota.'
            },
            action: {
              type: 'string',
              enum: ['run', 'continue', 'status', 'abort'],
              description: [
                'Control action for a long-running agentic (subtask) run, keyed by sessionId.',
                '"run" (default): normal call. If the server\'s internal time budget is exceeded before all',
                '  subtasks finish, it returns a PARTIAL result immediately and keeps working in the background —',
                '  re-call with the same sessionId to fetch progress or the rest.',
                '"status": instantly (no LLM call) reports whether a background run is still active, how many',
                '  subtasks are done, and what remains. Use this to poll instead of re-sending "run".',
                '"continue": resumes a paused/yielded queue (equivalent to replying with "continue <promptId> ...").',
                '"abort": cancels an in-progress background run; the queue stays resumable via "continue".',
              ].join('\n')
            },
            resume_input: { type: 'string', description: 'For action:"continue" — extra input appended to the subtask being resumed.' },
          },
          required: ['messages'],
        },
      },
      {
        name: 'vision_tool',
        description: 'Analyze a local image using a vision-capable model via use_free_llm.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            workspace_root: { type: 'string', description: 'Absolute workspace path' },
            image_path: { type: 'string', description: 'Image URI using file:/// scheme' },
            prompt: { type: 'string', description: 'Optional analysis prompt' },
            model: { type: 'string', description: 'Optional vision model id' },
          },
          required: ['workspace_root', 'image_path'],
        },
      },
       {
         name: 'load_skill_prompt',
         description: 'Search for or load a dynamic skill from the agentic-awesome-skills index. Skills are saved locally to the workspace or home directory. A `type:"load"` for a skill with many files downloads them in the BACKGROUND (a skill can legitimately take a while) — the initial call returns immediately with status:"running"; poll with pollAction:"status" and the same sessionId until it returns the loaded prompt.',
         inputSchema: {
           type: 'object' as const,
           properties: {
             type: { type: 'string', enum: ['load', 'search', 'list'], description: 'Whether to load a specific skill, search for matching skills, or list bundled skills (source:"hermes" only).' },
             name: { type: 'string', description: 'The name or ID of the skill to load (required if type is "load").' },
             keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to search for skills (required if type is "search").' },
             workspaceDir: { type: 'string', description: 'Optional absolute path to a workspace directory for local storage. Defaults to user home directory.' },
             source: { type: 'string', enum: ['agentic-awesome', 'hermes'], description: 'Which skill set to use. Defaults to trying the bundled Hermes set first, then agentic-awesome.' },
             sessionId: { type: 'string', description: 'Identifies a background download run across calls for type:"load"; defaults to the skill name. Reuse the same value to poll a running download.' },
             pollAction: { type: 'string', enum: ['run', 'status'], description: '"run" (default) starts/returns a background download; "status" polls it without starting a new one.' },
           },
           required: ['type'],
         },
       },
      // Deprecated (To be removed in future)
      // {
      //   name: 'list_available_free_models',
      //   description: [
      //     'Enumerate all registered LLM providers and models with rate-limit metadata.',
      //     '',
      //     'USER STORY: Discover which free models and providers are configured and available',
      //     'before sending a request. Use this to select the best model for a task or to check',
      //     'which providers have API keys set.',
      //     '',
      //     'WHEN TO USE: Before calling `use_free_llm` when you want to choose a specific model,',
      //     'or to audit which providers are active in the current environment.',
      //     '',
      //     'INPUTS:',
      //     '  provider (optional)      — Filter results to a single provider ID (e.g. "groq").',
      //     '  available_only (optional)— If true, only return models whose provider has an API key set.',
      //     '',
      //     'OUTPUTS: { models: [{providerId, modelId, modelName, rateLimits, available}], summary }',
      //     '  Each model entry includes rate limits (rpm, rpd, tpm) and availability flag.',
      //     '',
      //     'FAILURE STATES:',
      //     '  - Empty models array: no providers registered or all filtered out.',
      //     '  - available:false entries: provider is registered but API key is not set in environment.',
      //     '',
      //     'EXAMPLE:',
      //     '  { available_only: true }  → lists only models with configured API keys',
      //     '  { provider: "groq" }      → lists all Groq models with rate-limit metadata',
      //   ].join('\n'),
      //   inputSchema: {
      //     type: 'object' as const,
      //     properties: {
      //       provider: { type: 'string', description: 'Filter by provider ID (e.g. "groq", "gemini", "openrouter")' },
      //       available_only: { type: 'boolean', description: 'If true, only return models whose provider API key is configured' },
      //     },
      //   },
      // },
      {
        name: 'get_token_stats',
        description: [
          'Retrieve real-time token and request usage statistics for all loaded providers.',
          '',
          'USER STORY: Monitor per-provider consumption to avoid hitting rate limits. Identify',
          'which providers have remaining quota before selecting a model for the next request.',
          '',
          'WHEN TO USE: Before a batch of requests to baseline quota; after requests to audit',
          'consumption; when a provider returns rate-limit errors.',
          '',
          'INPUTS: None (no parameters required)',
          '',
          'OUTPUTS: Array of provider stat objects:',
          '  [{ id, name, isAvailable, rateLimits:{rpm,rpd,tpm}, usage:{tokens,requests} }]',
          '  Counters reset on server restart. Use isAvailable to skip providers with no API key.',
          '',
          'FAILURE STATES:',
          '  - Empty array: no providers registered (check server configuration).',
          '  - usage.tokens/requests = 0 on fresh start; increments after each `use_free_llm` call.',
          '',
          'EXAMPLE RESPONSE (Groq):',
          '  { id:"groq", name:"Groq", isAvailable:true, rateLimits:{rpm:30,rpd:14400},',
          '    usage:{tokens:1024, requests:2} }',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'validate_provider',
        description: [
          'Run a live health-check and credential validation for a specific LLM provider.',
          '',
          'USER STORY: Verify that a provider is reachable and its API key is valid before',
          'committing to it for a workflow. Use this for onboarding new providers or debugging',
          'authentication failures.',
          '',
          'WHEN TO USE: During environment setup; when `use_free_llm` returns auth errors;',
          'before automated workflows that depend on a specific provider.',
          '',
          'INPUTS:',
          '  providerId (required) — Provider ID to validate (e.g. "groq", "gemini", "openrouter").',
          // '                          Use `list_available_free_models` to get valid provider IDs.',
          '',
          'OUTPUTS: { providerId, status:"healthy"|"degraded"|"unavailable", latencyMs,',
          '           credentialsValid, message }',
          '',
          'FAILURE STATES:',
          '  - status:"unavailable": API key missing or network unreachable.',
          '  - status:"degraded": key valid but provider returning errors (rate limit, model unavailable).',
          '  - Unknown providerId: throws error listing known provider IDs.',
          '',
          'EXAMPLE:',
          '  { providerId: "groq" }  → validates Groq API key and connectivity',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            providerId: { type: 'string', description: 'Provider ID to validate (e.g. "groq", "gemini", "openrouter", "cohere")' },
          },
          required: ['providerId'],
        },
      },
      // v1.0.5 Deprecated: Unnecessary feature (DO NOT REMOVE THE CODE COMMENT)
      // {
      //   name: 'code_mode',
      //   description: [
      //     'Execute code in a sandboxed runtime against input data. Only stdout enters context.',
      //     '',
      //     'USER STORY: Process large API responses or datasets with a script without flooding',
      //     'the LLM context window. Write a filtering/transformation script; only its printed',
      //     'output (stdout) is returned — not the raw DATA payload.',
      //     '',
      //     'WHEN TO USE: When an API response is too large to pass directly to an LLM. Write a',
      //     'script to extract only the relevant fields, then pass the compressed output to',
      //     '`use_free_llm`. Also use for sandboxed computation, data transformation, or testing',
      //     'code snippets in isolation.',
      //     '',
      //     'INPUTS:',
      //     '  code (required)   — Script source. Use print() or console.log() to emit output.',
      //     '                      DATA global contains the input string (from `data` param).',
      //     '  language          — Sandbox runtime (default: "javascript"):',
      //     '                      "javascript" — QuickJS (quickjs-emscripten), in-process',
      //     '                      "python"     — RestrictedPython subprocess; requires python3 + pip install RestrictedPython',
      //     '                      "go"         — goja (pure-Go ECMAScript); requires pre-built binary',
      //     '                                     Build: cd scripts/go-sandbox-runner && go build -o sandbox-runner .',
      //     '                      "rust"       — boa_engine (pure-Rust ECMAScript); requires pre-built binary',
      //     '                                     Build: cd scripts/rust-sandbox-runner && cargo build --release',
      //     '  data              — Raw input string injected as DATA global variable.',
      //     '  command           — Human-readable description of what the script does (for logging).',
      //     '  timeout_ms        — Max execution time in milliseconds (default 5000).',
      //     '',
      //     'OUTPUTS: { stdout, stderr, success, error?, executionTimeMs, compressionRatio? }',
      //     '  compressionRatio = stdout.length / data.length (< 1 = context savings achieved).',
      //     '',
      //     'SANDBOX CONSTRAINTS (all languages):',
      //     '  - No filesystem access (read or write)',
      //     '  - No network access',
      //     '  - No process/OS calls',
      //     '  - Execution time limited by timeout_ms',
      //     '',
      //     'FAILURE STATES:',
      //     '  - success:false + error:"Execution timed out": increase timeout_ms or simplify script.',
      //     '  - success:false + error message: syntax or runtime error in script; check stderr.',
      //     '  - Empty stdout: script ran but called no print()/console.log().',
      //     '  - Binary not found (go/rust): build the runner first per instructions above.',
      //     '',
      //     'JAVASCRIPT EXAMPLE:',
      //     '  code: "const items = JSON.parse(DATA); print(items.map(i=>i.name).join(\\"\\\\n\\"))"',
      //     '  data: \'[{"name":"Alice"},{"name":"Bob"}]\'',
      //     '  → stdout: "Alice\\nBob"',
      //     '',
      //     'PYTHON EXAMPLE:',
      //     '  language: "python"',
      //     '  code: "import json; items=json.loads(DATA); print(len(items))"',
      //     '  data: \'[1,2,3]\'',
      //   ].join('\n'),
      //   inputSchema: {
      //     type: 'object' as const,
      //     properties: {
      //       code: { type: 'string', description: 'Script source code. Use print() or console.log() to emit output. DATA global contains the input data string.' },
      //       language: {
      //         type: 'string',
      //         enum: ['javascript', 'python', 'go', 'rust'],
      //         description: 'Sandbox runtime language (default: "javascript"). Each runs in an isolated, network-free, filesystem-free environment.',
      //       },
      //       data: { type: 'string', description: 'Input data injected as DATA global variable in the sandbox' },
      //       command: { type: 'string', description: 'Human-readable description of what the script does (used for logging and memory)' },
      //       timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 5000). Increase for heavy computations.' },
      //     },
      //     required: ['code'],
      //   },
      // },
      {
        name: 'manage_memory',
        description: [
          'Workspace-aware persistent memory operations: search, list, stats, and clear.',
          '',
          'USER STORY: Retrieve or manage past interactions and compression statistics scoped',
          'to a specific workspace. Use before wide-context actions to recall relevant prior',
          'work, or after processing to inspect memory usage.',
          '',
          'WHEN TO USE:',
          '  - BEFORE large refactoring or research: search memory for prior context.',
          '  - BEFORE planning or acting on a task: call adr_list to check prior architecture',
          '    decisions, and eisenhower_list to see the open task backlog and its priority',
          '    quadrants, so new work is planned against what already exists rather than',
          '    duplicating or contradicting it. Any MCP client (Cursor, Claude Code, etc.) should',
          '    treat these two as a cheap, always-worth-it pre-planning check.',
          '  - AFTER a real architectural decision: call adr_write to record it, so future',
          '    planning (by any agent, in any session) can find and honor it via adr_list.',
          '  - AFTER processing: check stats for token/compression savings.',
          '  - FOR CLEANUP: clear workspace memory when starting fresh.',
          '',
          'INPUTS:',
          '  action (required)        — One of: "search" | "list" | "stats" | "clear" | "wiki_search" |',
          '                              "wiki_write" | "wiki_list" | "wiki_read" | "node_add" |',
          '                              "node_link" | "node_list" | "node_get" | "node_review" |',
          '                              "graph_query" | "adr_write" | "adr_list" | "eisenhower_add" |',
          '                              "eisenhower_list" | "eisenhower_complete" | "pomodoro_start" |',
          '                              "pomodoro_stop" | "pomodoro_list".',
          '  workspace_root (optional)— Absolute path to workspace root. Used to scope memory.',
          '  query (optional)         — Search term for "search"/"wiki_search" (semantic/substring match).',
          '  limit (optional)         — Max results for "search" action (default 10).',
          '  node (optional)          — For "node_add": { type, content?, filePath?, pdfPage?, tags?,',
          '                              halfLifeDays?, confidence? }. type is one of "text"|"image"|',
          '                              "video"|"audio"|"pdf_page". filePath rejected if it ends in',
          '                              .pptx or .docx (excluded media types).',
          '  nodeId (optional)        — For "node_get"/"node_review": the node id.',
          '  tags (optional)          — For "node_list": tags[0] filters by that tag. For "wiki_write"/',
          '                              "adr_write": page tags (adr_write always adds "adr").',
          '  from, to, relation (optional) — For "node_link": edge endpoints (node ids) and label.',
          '  title, content (optional)— For "wiki_write"/"adr_write": page title and body.',
          '  task (optional)          — For "eisenhower_add": the task description.',
          '  urgent, important (optional) — For "eisenhower_add": explicit Eisenhower classification.',
          '                              Required unless autoClassify:true.',
          '  autoClassify (optional)  — For "eisenhower_add": have an LLM classify urgent/important from',
          '                              `task` text instead of requiring them explicitly. OFF BY DEFAULT',
          '                              — must be explicitly set true per call; never triggers implicitly.',
          '  quadrant, includeCompleted (optional) — For "eisenhower_list": filter to one quadrant',
          '                              ("do"|"schedule"|"delegate"|"delete") and/or include done tasks.',
          '  taskId (optional)        — For "eisenhower_complete": the task id to mark done.',
          '  label, durationMinutes (optional) — For "pomodoro_start": session label and length in',
          '                              minutes (default 25).',
          '  sessionRefId, aborted (optional) — For "pomodoro_stop": the session id, and whether it was',
          '                              abandoned rather than completed.',
          '  pomodoroLimit (optional) — For "pomodoro_list": how many recent sessions to return (default 20).',
          '',
          'ACTION DETAILS:',
          '  search     → Returns memory entries matching query for the workspace.',
          '               Input: { action:"search", workspace_root:"/src/app", query:"authentication" }',
          '  list       → Returns workspace identifier and hash for the given root.',
          '               Input: { action:"list", workspace_root:"/src/app" }',
          '  stats      → Returns aggregate compression stats (bytes saved, ratio) across all operations.',
          '               Input: { action:"stats" }',
          '  clear      → Marks workspace memory namespace for clearing.',
          '               Input: { action:"clear", workspace_root:"/src/app" }',
          '  wiki_write/wiki_search/wiki_list/wiki_read → Persistent workspace wiki pages (general',
          '               architecture/codebase notes — separate from ADRs, see adr_write below).',
          '  node_add   → Creates a DAG memory node scoped to workspace_root, with Ebbinghaus decay',
          '               fields (halfLifeDays/confidence) reused from the same decay model as other',
          '               memory entries. Returns the created node.',
          '  node_link  → Creates a directed edge between two existing node ids; rejects (throws) if',
          '               the edge would create a cycle — the store is a DAG, not a general graph.',
          '  node_list  → Lists nodes for the workspace, optionally filtered to one tag.',
          '  node_get   → Fetches a single node by id.',
          '  node_review→ Resets a node\'s decay clock (lastReviewedAt) and bumps its confidence —',
          '               call after actually re-confirming a node is still accurate.',
          '  graph_query→ Returns the full { nodes, edges } graph for the workspace (for rendering).',
          '  adr_write  → Records an architecture decision as a wiki page tagged "adr", stored',
          '               separately from general wiki pages (excluded from wiki_search/wiki_list by',
          '               design, so ADRs don\'t dilute general codebase-wiki search results).',
          '  adr_list   → Lists all ADRs for the workspace — call this BEFORE planning or acting on',
          '               anything non-trivial, so past decisions are honored, not silently redone.',
          '  eisenhower_add → Adds a task classified into the Eisenhower matrix (do/schedule/delegate/',
          '               delete) via explicit urgent+important flags, or autoClassify:true to have',
          '               an LLM infer them (off by default).',
          '  eisenhower_list → Lists open (or all, with includeCompleted:true) tasks, optionally',
          '               filtered to one quadrant — call BEFORE planning to see the live backlog.',
          '  eisenhower_complete → Marks a task done by id.',
          '  pomodoro_start/pomodoro_stop/pomodoro_list → Focus-session timer tracking (label,',
          '               duration, actual elapsed minutes on stop, completed vs aborted status).',
          '',
          'OUTPUTS:',
          '  search     → Array of memory entries with metadata.',
          '  list       → { workspace, hash }',
          '  stats      → { totalOriginalBytes, totalCompressedBytes, overallRatio, operationCount }',
          '  clear      → { success:true, message }',
          '  node_add   → { success:true, node }',
          '  node_link  → { success:true, edge }',
          '  node_list  → { nodes }',
          '  node_get   → { node } (null if not found)',
          '  node_review→ { success:true, node } (null if not found)',
          '  graph_query→ { nodes, edges }',
          '  adr_write  → { success:true, page }',
          '  adr_list   → { adrs }',
          '  eisenhower_add → { success:true, task, autoClassified }',
          '  eisenhower_list → { tasks }',
          '  eisenhower_complete → { success:true, task } (null if not found)',
          '  pomodoro_start → { success:true, session }',
          '  pomodoro_stop → { success:true, session } (null if not found)',
          '  pomodoro_list → { sessions }',
          '',
          'FAILURE STATES:',
          '  - "Unsupported action": only the actions listed above are valid.',
          '  - Empty search results: no prior memory for this workspace or query has no matches.',
          '  - node_add throws if filePath ends in .pptx/.docx.',
          '  - node_link throws if the edge would create a cycle, or if from/to/relation are missing.',
          '  - eisenhower_add throws if urgent/important are omitted without autoClassify:true.',
          '',
          'AGENT REMINDER: Always invoke manage_memory before wide-context actions to retrieve',
          'relevant prior work and avoid redundant processing. Before planning or acting on a',
          'non-trivial task, cross-reference adr_list (past decisions) and eisenhower_list (open',
          'backlog) — cheap calls that prevent re-deciding or duplicating existing work.',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: [
                'search', 'list', 'stats', 'clear', 'wiki_search', 'wiki_write', 'wiki_list', 'wiki_read',
                'node_add', 'node_link', 'node_list', 'node_get', 'node_review', 'graph_query',
                'adr_write', 'adr_list',
                'eisenhower_add', 'eisenhower_list', 'eisenhower_complete',
                'pomodoro_start', 'pomodoro_stop', 'pomodoro_list',
              ],
              description: 'Memory operation: "search"/"list"/"stats"/"clear" (workspace key-value memory), "wiki_*" (persistent wiki pages), "node_*"/"graph_query" (DAG memory node/edge graph), "adr_*" (architecture decision records — check adr_list before planning), "eisenhower_*" (priority matrix — check eisenhower_list before planning), "pomodoro_*" (focus-session timer)',
            },
            workspace_root: { type: 'string', description: 'Absolute path to workspace root for scoping memory operations (e.g. "/home/user/my-project")' },
            query: { type: 'string', description: 'Search term for "search"/"wiki_search" — used for semantic or substring retrieval of prior context' },
            limit: { type: 'number', description: 'Maximum number of results to return for "search" action (default 10)' },
            title: { type: 'string', description: 'For "wiki_write"/"wiki_read"/"adr_write": the page title' },
            content: { type: 'string', description: 'For "wiki_write"/"adr_write": the page content to store' },
            tags: { type: 'array', items: { type: 'string' }, description: 'For "wiki_write"/"adr_write": page tags (adr_write always adds "adr"). For "node_list": tags[0] filters nodes by that tag' },
            links: { type: 'array', items: { type: 'string' }, description: 'For "wiki_write"/"adr_write": related page titles to link' },
            persona: { type: 'string', description: 'For "wiki_search": persona lens to bias search relevance' },
            namespace: { type: 'string', description: 'For "wiki_*"/"adr_*": namespace override (defaults to the workspace hash)' },
            node: {
              type: 'object',
              description: 'For "node_add": the DAG memory node to create',
              properties: {
                type: { type: 'string', enum: ['text', 'image', 'video', 'audio', 'pdf_page'] },
                content: { type: 'string' },
                filePath: { type: 'string', description: 'Rejected if it ends in .pptx or .docx' },
                pdfPage: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
                halfLifeDays: { type: 'number', description: 'Ebbinghaus decay half-life in days (default 30)' },
                confidence: { type: 'number', description: 'Initial confidence 0..1 (default 0.5)' },
              },
              required: ['type'],
            },
            nodeId: { type: 'string', description: 'For "node_get"/"node_review": the node id' },
            from: { type: 'string', description: 'For "node_link": source node id' },
            to: { type: 'string', description: 'For "node_link": target node id' },
            relation: { type: 'string', description: 'For "node_link": edge relation label' },
            task: { type: 'string', description: 'For "eisenhower_add": the task description' },
            urgent: { type: 'boolean', description: 'For "eisenhower_add": explicit urgency flag (time-pressured/has a deadline)' },
            important: { type: 'boolean', description: 'For "eisenhower_add": explicit importance flag (moves a real goal forward)' },
            autoClassify: { type: 'boolean', description: 'For "eisenhower_add": have an LLM classify urgent/important from `task` text. OFF BY DEFAULT — must be explicitly set true; never triggers implicitly' },
            quadrant: { type: 'string', enum: ['do', 'schedule', 'delegate', 'delete'], description: 'For "eisenhower_list": filter to one quadrant' },
            includeCompleted: { type: 'boolean', description: 'For "eisenhower_list": include already-completed tasks (default false)' },
            taskId: { type: 'string', description: 'For "eisenhower_complete": the task id to mark done' },
            label: { type: 'string', description: 'For "pomodoro_start": a label for the session' },
            durationMinutes: { type: 'number', description: 'For "pomodoro_start": session length in minutes (default 25)' },
            sessionRefId: { type: 'string', description: 'For "pomodoro_stop": the session id to stop' },
            aborted: { type: 'boolean', description: 'For "pomodoro_stop": true if abandoned rather than completed' },
            pomodoroLimit: { type: 'number', description: 'For "pomodoro_list": how many recent sessions to return (default 20)' },
          },
          required: ['action'],
        },
      },
      {
        name: 'store_workspace_skill',
        description: [
          'Explicitly harvest structured knowledge and scripts into the workspace.',
          'Use this to persist complex research or multi-step implementations as a reusable skill.',
          '',
          'FOLLOWS @skill-writer schema:',
          '- name: lowercase-hyphenated name of the skill',
          '- description: one-sentence description of the skill and when to trigger it',
          '- what: list of key decisions, findings, or implementation details',
          '- why: supporting rationale or background context',
          '- files: files modified or referenced',
          '- example: code snippet or example usage',
          '- scripts: map of script filename to code content',
          '- workspace_root: absolute path to the workspace root',
          '',
          'When script_instructions is given, script generation (one or more internal LLM calls,',
          'one per script) runs in the BACKGROUND — the call returns immediately with status:"running"',
          'and a sessionId; poll with pollAction:"status" and the same sessionId until it returns the',
          'final result. Without script_instructions, the call is synchronous as before (SKILL.md only).',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Lowercase-hyphenated name of the skill' },
            description: { type: 'string', description: 'One-sentence description of the skill and when to trigger it' },
            what: { type: 'array', items: { type: 'string' }, description: 'List of key decisions, findings, or implementation details' },
            why: { type: 'string', description: 'Supporting rationale or background context' },
            files: { type: 'array', items: { type: 'string' }, description: 'Files modified or referenced' },
            example: { type: 'string', description: 'Code snippet or example usage' },
            script_instructions: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of script filename to an instruction detailing what the script should do. The server will use an internal LLM to intelligently generate the script code. Generation runs in the background — see pollAction.' },
            workspace_root: { type: 'string', description: 'Absolute path to the workspace root' },
            sessionId: { type: 'string', description: 'Identifies a background script-generation run across calls; defaults to the derived skill slug. Reuse the same value to poll a running generation.' },
            pollAction: { type: 'string', enum: ['run', 'status', 'abort'], description: '"run" (default) starts/returns a background script-generation run; "status" polls it; "abort" cancels an in-flight run.' },
          },
          required: ['name', 'description', 'what', 'workspace_root'],
        },
      },
      {
        name: 'index_workspace',
        description: [
          'Proactively index all relevant files in the workspace into the persistent vector database.',
          '',
          'USER STORY: Update the semantic memory of the project so that future queries can find',
          'relevant code snippets even if you haven\'t manually stored them yet.',
          '',
          'WHEN TO USE: After significant code changes, when starting a new session, or when',
          'semantic search results seem outdated.',
          '',
          'INPUTS:',
          '  workspace_root — Absolute path to the workspace root to index.',
          '  force          — If true, wipes the existing index and rebuilds from scratch (self-healing).',
          '',
          'OUTPUTS: { totalFiles, indexedFiles, skippedFiles, errors }',
          '',
          'Note: Uses hash-based tracking to only index changed files, making it fast for subsequent runs.',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            workspace_root: { type: 'string', description: 'Absolute path to workspace root (e.g. "/home/user/my-project")' },
            force: { type: 'boolean', description: 'Force rebuild of the index (wipes existing)' },
          },
          required: ['workspace_root'],
        },
      },
      {
        name: 'execute_skill',
        description: 'Execute a prompt using a specific local skill\'s instructions and reference files.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            skill: { type: 'string', description: 'Name of the skill directory under .free-llm-mcp/skills/' },
            input: { type: 'string', description: 'The prompt or instruction to run with the skill.' },
            model: { type: 'string', description: 'Optional model to use.' },
            workspace_root: { type: 'string', description: 'Optional absolute path to the project root.' },
            sessionId: { type: 'string', description: 'Optional session identifier.' }
          },
          required: ['skill', 'input']
        }
      },
      {
        name: 'browser_tool',
        description: `Browser automation & scraper that owns a real chrome-devtools-mcp session. Actions: ${renderActionDocs()}`,
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: { type: 'string', enum: actionEnum(), description: 'Which browser action to perform' },
            url: { type: 'string', description: 'Target website URL (required for navigate/scrape; optional elsewhere)' },
            sessionId: { type: 'string', description: 'Session identifier — reuses a live browser session and checkpoint across calls' },
            outputDir: { type: 'string', description: 'Directory to store output datasets, checkpoints, and network dumps' },
            userInstructions: { type: 'string', description: 'Prompt/instructions for extraction actions' },
            strict: { type: 'boolean', description: 'When true (default), extraction failures return data:null + errors instead of best-effort guesses' },
            params: { type: 'object', description: 'Action-specific parameters (see the action list above)' }
          },
          required: ['action']
        }
      },
      {
        name: 'cyber_tool',
        description: 'Educational cyber security coach plus registry/wiki manager for security binaries (sqlmap, nmap, ffuf). Never executes commands — it teaches the exact commands, explains why, tracks CTF decision graphs, and remembers per-tool run suggestions across sessions so the learner can resume where they left off. For osint with autoSearch:true, the search-provider dork lookups run in the BACKGROUND — the call returns immediately with searchStatus:"running"; poll with action:"osint_status" (same sessionId + target) until searchStatus:"done".',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: { type: 'string', enum: ['list_tools', 'get_tool', 'register_tool', 'wiki_lookup', 'learn', 'coach', 'save_graph', 'load_graph', 'tool_memory', 'osint', 'osint_status'], description: 'Cyber tool action' },
            toolName: { type: 'string', description: 'Security tool name (e.g. sqlmap, nmap, ffuf)' },
            githubUrl: { type: 'string', description: 'GitHub repository URL for tool registration' },
            sessionId: { type: 'string', description: 'Session/CTF-challenge id; keys the progress record and decision graph for learn/coach/save_graph/load_graph, and (with target) the background search run for osint/osint_status' },
            goal: { type: 'string', description: 'Natural-language objective for the learn action, e.g. "find SQLi on a lab web app"' },
            level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'], description: 'Learner skill level; defaults to beginner' },
            observation: { type: 'string', description: 'For coach: what the learner ran and what they observed' },
            graphNode: {
              type: 'object',
              description: 'For save_graph: a decision-graph node to add, optionally linked from a prior node',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', enum: ['goal', 'hypothesis', 'action', 'finding', 'deadend'] },
                from: { type: 'string', description: 'id of the node this one follows from' }
              }
            },
            memoryOp: { type: 'string', enum: ['read', 'write'], description: 'For tool_memory: read or append to that tool\'s run-suggestion memory' },
            note: { type: 'string', description: 'For tool_memory write: the run suggestion/note to append' },
            target: { type: 'string', description: 'For osint/osint_status: domain, IP, or username to investigate' },
            osintType: { type: 'string', enum: ['domain', 'ip', 'username', 'all'], description: 'For osint: what kind of target this is; controls which DNS lookups run' },
            autoSearch: { type: 'boolean', description: 'For osint: also run recon dorks through a search provider in the background (poll with osint_status)' },
            allowPrivateIps: { type: 'boolean', description: 'For osint: allow private/loopback targets (SSRF guard is on by default)' },
          },
          required: ['action']
        }
      },
      {
        name: 'quantum_tool',
        description: 'Multi-branch/persona reasoning aid using a quantum-circuit metaphor: "qubits" are reasoning branches, "gates" (H/X/Y/Z/RY/RZ/CNOT/CZ/SWAP/MEASURE) adjust each branch\'s stance/confidence via real single-qubit rotation math, and "analyze" calls an LLM to synthesize across branch states. Research/exploration tool, not a production decision system — state is in-memory per session only.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: { type: 'string', enum: ['setup', 'step', 'pause', 'continue', 'modify', 'reset', 'status', 'get_state', 'analyze'], description: 'Quantum circuit action' },
            sessionId: { type: 'string', description: 'Session id keying the circuit state' },
            numBranches: { type: 'number', description: 'For setup: number of reasoning branches/qubits (default 3)' },
            personas: { type: 'array', items: { type: 'string' }, description: 'For setup/reset: persona label per branch' },
            gates: {
              type: 'array',
              description: 'For modify: gate operations to add to the circuit',
              items: {
                type: 'object',
                properties: {
                  qubit: { type: 'number' },
                  column: { type: 'number', description: 'Circuit step (0..maxStep-1) this gate applies at' },
                  gate: { type: 'string', enum: ['H', 'X', 'Y', 'Z', 'RY', 'RZ', 'CNOT', 'CZ', 'SWAP', 'MEASURE', 'BARRIER'] },
                  target: { type: 'number', description: 'Second qubit for CNOT/CZ/SWAP' },
                  param: { type: 'number', description: 'Angle in radians for RY/RZ' }
                },
                required: ['qubit', 'column', 'gate']
              }
            },
            query: { type: 'string', description: 'For analyze: the question to reason about across branches' },
            temperature: { type: 'number', description: 'For analyze: 0..1 prompt-compression aggressiveness (1 = uncompressed)' }
          },
          required: ['action', 'sessionId']
        }
      },
      {
        name: 'local_llm_patch',
        description: '[DEPRECATED: Prefer coding_agents] Single-file code patching and creation tool using a locally running Ollama instance. Ranks installed local coding models, enriches the request with local workspace context, and returns proposed patch or file content.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            filePath: { type: 'string', description: 'Relative or absolute path to the file to be patched or created' },
            instruction: { type: 'string', description: 'Instruction explaining what edits or additions to make' },
            workspace_root: { type: 'string', description: 'Optional root workspace directory for context enrichment' },
            sessionId: { type: 'string', description: 'Optional session identifier for audit logging' },
            allowCreate: { type: 'boolean', description: 'Allow creating a new file if target does not exist (default true)' }
          },
          required: ['filePath', 'instruction']
        }
      },
      {
        name: 'coding_agents',
        description: [
          'OMP-pattern autonomous multi-file coding agent: performs workspace enumeration, VectorStore',
          'TF-IDF RAG file discovery, line-anchored [PATH#TAG] snapshot diff generation, AST symbol',
          'extraction, and TypeScript/LSP syntax diagnostics verification.',
          '',
          'EXECUTION MODEL: dryRun:true (default), plan creation, and rollback are synchronous — you get',
          'a result immediately. Real execution (dryRun:false, no plan/pauseOnTaskPlan) runs in the',
          'BACKGROUND instead: local/cloud LLM patch generation over several files can legitimately take',
          'a long time for a large goal, so the call returns immediately with status:"running" and the',
          'sessionId; poll with action:"status" (same sessionId) until it returns the final patch result.',
          'Use action:"abort" to cancel an in-flight background run after its current file.',
          '',
          'MULTI-TASK GOALS: pass pauseOnTaskPlan:true (or action:"plan") to decompose the goal into',
          'tasks.md and pause; then call action:"resume" (same sessionId) to execute the next pending',
          'task — each resume call follows the same dryRun-decides-sync-vs-background rule above.',
          '',
          'PLANNING: decomposition uses a cloud model (via use_free_llm) purely to break the goal into',
          'an ordered subtask list with a target file and short "why/what not to break" context per',
          'subtask — planning is a reasoning task, not a code-generation one, so it does not run through',
          'local_llm_patch. Falls back to a naive line-split if the planner call fails for any reason.',
          'Actual per-subtask EDITING during resume is unchanged: local_llm_patch runs first, falling',
          'back to the cloud model only if the local one fails or is unavailable.',
          '',
          'BLACKBOARD (tasks.md): each task in tasks.md carries its planner-assigned file/context plus an',
          'append-only log of every resume attempt (files touched, model used, applied, diagnostic count,',
          'or the failure reason) — the AI-agent <-> local_llm_patch interaction history, not just a',
          'checkbox. A resume that fails to produce a real patch (generation failure or the',
          'hallucinated-replacement guard) leaves that task \'pending\' with the failure appended to its',
          'log, so the next resume retries the SAME task instead of silently moving on.',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            goal: { type: 'string', description: 'The refactoring, feature addition, or bugfix goal' },
            workspaceRoot: { type: 'string', description: 'Workspace root path (defaults to current working directory)' },
            dryRun: { type: 'boolean', description: 'Whether to return the line-anchored patch plan without mutating disk, synchronously (default true). false triggers real background execution — see description.' },
            targetFiles: { type: 'array', items: { type: 'string' }, description: 'Explicit list of target file paths to edit or create (bypasses RAG location)' },
            topKFiles: { type: 'number', description: 'Maximum candidate files to locate with VectorStore RAG (default 5)' },
            sessionId: { type: 'string', description: 'Session identifier for audit logging, snapshot caching, tasks.md pause/resume, and the background run key for status/abort. Reuse the same value across a plan→resume→status sequence.' },
            verifyLspDiagnostics: { type: 'boolean', description: 'Verify syntactic/AST diagnostics before completing plan (default true)' },
            action: { type: 'string', enum: ['plan', 'execute', 'resume', 'status', 'abort'], description: '"plan" writes tasks.md and pauses; "execute" (default) runs the goal directly; "resume" advances the next pending tasks.md task; "status" polls a background run started by a prior dryRun:false call; "abort" cancels one.' },
            pauseOnTaskPlan: { type: 'boolean', description: 'Same effect as action:"plan" — decompose the goal into tasks.md and pause instead of executing' },
            astEditOps: {
              type: 'array',
              description: 'Structural ast-grep-style rewrites ($$$VAR pattern matching) to apply instead of LLM generation for this call — deterministic, no local/cloud model involved',
              items: {
                type: 'object',
                properties: {
                  pat: { type: 'string', description: 'ast-grep pattern to match, e.g. "computeTotal($$$A)"' },
                  out: { type: 'string', description: 'Replacement pattern, e.g. "calculateFinal($$$A)"' },
                },
                required: ['pat', 'out'],
              },
            },
            resolve: {
              type: 'object',
              description: 'How to finalize a non-dry-run patch, or trigger a rollback',
              properties: {
                action: { type: 'string', enum: ['apply', 'rollback'], description: '"apply" writes patches to disk via the CAS-checkpointed atomic writer; "rollback" restores a prior CAS checkpoint (synchronous either way)' },
                checkpointId: { type: 'string', description: 'For rollback: specific checkpoint to restore; defaults to the most recent one for this sessionId' },
              },
            },
            lspAction: { type: 'object', description: 'Optional direct LSP dispatch request (diagnostics/symbols/definition/references) instead of the full edit pipeline' },
          },
          required: ['goal']
        }
      },
      {
        name: 'movie_tool',
        description: 'Vibe movie media engine: timeline manifest, asset generation (Pollinations FLUX T2I, Kokoro TTS, MusicGen BGM), and approvals.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['init_project', 'propose_slots', 'add_artifact', 'approve_artifact', 'reroll_artifact', 'generate_assets', 'generate_story', 'compile_timeline', 'get_timeline', 'apply_effect', 'undo_effect'],
              description: 'The movie_tool action to execute'
            },
            projectId: { type: 'string', description: 'Project ID' },
            premise: { type: 'string', description: 'Premise or logline for the project' },
            sessionId: { type: 'string', description: 'Session identifier' },
            projectDir: { type: 'string', description: 'Custom project directory path' },
            track: { type: 'string', enum: ['video', 'vfx', 'bgm', 'bgm_drums', 'bgm_bass', 'bgm_melody', 'vocal', 'song', 'script', 'dialogue'], description: 'Timeline track lane' },
            start_ms: { type: 'number', description: 'Start timestamp in milliseconds' },
            end_ms: { type: 'number', description: 'End timestamp in milliseconds' },
            label: { type: 'string', description: 'Human readable artifact label' },
            engine: { type: 'string', description: 'Generation engine name' },
            model: { type: 'string', description: 'Specific model identifier' },
            artifact_path: { type: 'string', description: 'File path to media artifact' },
            prompt: { type: 'string', description: 'Prompt for generation' },
            artifactId: { type: 'string', description: 'Artifact ID for approval, reroll, or effect manipulation' },
            apiKey: { type: 'string', description: 'Optional API key for Pollinations or external provider' },
            hfToken: { type: 'string', description: 'Optional Hugging Face access token' },
            effect: {
              type: 'object',
              description: 'DSP remix or video FX effect object. If invalid or omitted during apply_effect, parameters/type are automatically randomized.'
            },
            remix: {
              type: 'boolean',
              description: 'Whether to render media remix immediately using FFmpeg (defaults to true)'
            }
          },
          required: ['action']
        }
      }
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const { name, arguments: args } = request.params;
    const _start = Date.now();

    let response: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

    try {
      if (name === 'use_free_llm' || name === 'free_llm_api') {
        const input = args as unknown as Parameters<typeof useFreeLLM>[0];
        const result = await useFreeLLM(input);

        // Extract only the assistant content — strip headers, usage, id, etc.
        // Handles multiple choices (e.g. n>1 or beam-search providers) by joining.
        const choices: Array<{ message?: { content?: string }; text?: string }> =
          Array.isArray(result?.choices) ? result.choices : [];

        const texts = choices
          .map((c) => (c?.message?.content ?? c?.text ?? '').trim())
          .filter(Boolean);

        const responseText = texts.length === 0
          ? JSON.stringify(result, null, 2) // fallback: no choices at all
          : texts.length === 1
            ? texts[0]  // single response — return as-is, no label overhead
            : texts.map((t, i) => `AGENT RESPONSE ${i + 1}\n\n${t}`).join('\n\n');

        response = {
          content: [{ type: 'text' as const, text: toMarkdownResponse(responseText) }],
        };
      } else if (name === 'vision_tool') {
        const result = await visionTool(args as any);
        response = {
          content: [{ type: 'text' as const, text: toMarkdownResponse(result.response) }],
        };
      } else if (name === 'load_skill_prompt') {
        const result = await loadSkillPrompt(args as any);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } else if (name === 'manage_memory') {
        const input = args as unknown as Parameters<typeof manageMemory>[0];
        const result = await manageMemory(input);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } else if (name === 'store_workspace_skill') {
        const { storeWorkspaceSkill } = await import('../tools/store-workspace-skill.js');
        const input = args as any;
        const result = await storeWorkspaceSkill(input);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } else if (name === 'get_token_stats') {
        const result = await getTokenStats();
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } else if (name === 'validate_provider') {
        const { providerId } = args as { providerId: string };
        const result = await validateProvider(providerId);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } else if (name === 'index_workspace') {
        const input = args as any;
        const result = await indexWorkspace(input);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } else if (name === 'execute_skill') {
        const input = args as any;
        const result = await executeSkill(input);
        const text = result.success ? (result.response ?? '') : `Error: ${result.error}`;
        response = {
          content: [{ type: 'text' as const, text: toMarkdownResponse(text) }],
          isError: !result.success,
        };
      } else if (name === 'browser_tool') {
        const result = await dispatchBrowserAction(args);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      } else if (name === 'cyber_tool') {
        const { cyberTool } = await import('../tools/cyber-tool.js');
        const result = await cyberTool(args as any);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
        };
      } else if (name === 'quantum_tool') {
        const { quantumTool } = await import('../tools/quantum-tool.js');
        const result = await quantumTool(args as any);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      } else if (name === 'local_llm_patch') {
        const { localLlmPatch } = await import('../tools/local-llm-patch.js');
        const result = await localLlmPatch(args as any);
        response = {
          content: [{ type: 'text' as const, text: toMarkdownResponse(result.content || result.markdown || '') }],
          isError: !result.success,
        };
      } else if (name === 'coding_agents') {
        const { CodingAgentsHandler } = await import('../tools/coding-agents.js');
        const result = await CodingAgentsHandler(args as any);
        response = {
          content: [{ type: 'text' as const, text: toMarkdownResponse(result.content || result.markdown || '') }],
          isError: !result.applied && !!result.error,
        };
      } else if (name === 'movie_tool') {
        const { runMovieTool } = await import('../tools/movie-tool.js');
        const result = await runMovieTool(args as any);
        response = {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: !result.success,
        };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      response = {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }

    // Fire-and-forget logging — never delays the MCP response
    deriveSessionIdFromArgs(args as any).then(sessionId =>
      logToolCall(sessionId, name, args, response, Date.now() - _start, !!response.isError)
        .catch(() => {})
    ).catch(() => {});

    return response;
  });

  return server;
}
