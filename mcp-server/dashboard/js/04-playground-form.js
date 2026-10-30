'use strict';
// ─── TOOL PLAYGROUND ─────────────────────────────────────────────

// Tool definitions
const TOOLS = [
  {
    id: 'use_free_llm', label: 'use_free_llm', icon: '💬',
    tag: 'Chat / Coding',
    fields: [
      { id: 'prompt', label: 'User Message', type: 'textarea', placeholder: 'Write a Hello World in Go' },
      { id: 'model',  label: 'Model Override', type: 'model-picker' },
      { id: 'keywords', label: 'Keywords (comma-separated)', type: 'text', placeholder: 'e.g. jwt, security' },
    ]
  },
  {
    id: 'vision_tool', label: 'vision_tool', icon: '👁',
    tag: 'Vision / VLM',
    fields: [
      { id: 'image_path', label: 'Image Path', type: 'text', placeholder: 'file:///C:/path/to/screenshot.png' },
      { id: 'prompt',     label: 'Analysis Prompt', type: 'textarea', placeholder: 'Describe the UI layout' },
      { id: 'model',      label: 'Model Override', type: 'model-picker' },
    ]
  },
  {
    id: 'execute_skill', label: 'execute_skill', icon: '⚡',
    tag: 'Skill Execution',
    fields: [
      { id: 'skill', label: 'Skill Name', type: 'text', placeholder: 'ab-test-setup' },
      { id: 'input', label: 'Task Input', type: 'textarea', placeholder: 'Design an A/B test for the checkout button' },
      { id: 'model', label: 'Model Override', type: 'model-picker' },
    ]
  },
  {
    id: 'load_skill_prompt', label: 'load_skill_prompt', icon: '📥',
    tag: 'Skill Loading',
    actionField: 'type',
    fields: [
      { id: 'type',         label: 'Action Type', type: 'select', options: ['load', 'search', 'list'] },
      { id: 'name',         label: 'Skill Name', type: 'text', placeholder: 'tdd-workflow', showFor: ['load'] },
      { id: 'keywords',     label: 'Keywords (comma-separated for search)', type: 'text', placeholder: 'tdd, testing', showFor: ['search'] },
      { id: 'workspaceDir', label: 'Workspace Directory (optional)', type: 'text', placeholder: 'C:/path/to/workspace' },
      { id: 'source',       label: 'Source (optional)', type: 'select', options: ['', 'agentic-awesome', 'hermes'] },
      { id: 'sessionId',    label: 'Session ID (for background download polling)', type: 'text', placeholder: 'load-1' },
      { id: 'pollAction',   label: 'Poll Action (optional)', type: 'select', options: ['', 'run', 'status'] },
    ]
  },
  {
    id: 'manage_memory', label: 'manage_memory', icon: '🧠',
    tag: 'Memory',
    fields: [
      { id: 'action',         label: 'Action', type: 'select', options: ['search','list','stats','clear','wiki_search','wiki_write','wiki_list','wiki_read','node_add','node_link','node_list','node_get','node_review','graph_query','adr_write','adr_list','eisenhower_add','eisenhower_list','eisenhower_complete','pomodoro_start','pomodoro_stop','pomodoro_list'] },
      { id: 'query',          label: 'Query', type: 'text', placeholder: 'authentication patterns', showFor: ['search','wiki_search'] },
      { id: 'limit',          label: 'Limit (results)', type: 'number', placeholder: '5', showFor: ['search','wiki_search'] },
      { id: 'title',          label: 'Title', type: 'text', placeholder: 'Auth Overview', showFor: ['wiki_write','wiki_read','adr_write'] },
      { id: 'content',        label: 'Content', type: 'textarea', placeholder: 'Page content...', showFor: ['wiki_write','adr_write'] },
      { id: 'tags',           label: 'Tags (comma-separated; node_list filters by tags[0])', type: 'text', placeholder: 'auth, security', showFor: ['wiki_write','adr_write','node_list','eisenhower_add'] },
      { id: 'links',          label: 'Links (comma-separated)', type: 'text', placeholder: 'Related Page', showFor: ['wiki_write','adr_write'] },
      { id: 'persona',        label: 'Persona', type: 'text', placeholder: 'coder', showFor: ['wiki_search'] },
      { id: 'namespace',      label: 'Namespace (letters, digits, . - _)', type: 'text', placeholder: 'global-cyber-tools', showFor: ['wiki_search','wiki_write','wiki_list','wiki_read','adr_write','adr_list'] },
      { id: 'node',           label: 'Node JSON', type: 'textarea', placeholder: '{"type":"text","content":"..."}', showFor: ['node_add'] },
      { id: 'nodeId',         label: 'Node ID', type: 'text', placeholder: 'a1b2c3...', showFor: ['node_get','node_review'] },
      { id: 'from',           label: 'From Node ID', type: 'text', placeholder: 'a1b2c3...', showFor: ['node_link'] },
      { id: 'to',             label: 'To Node ID', type: 'text', placeholder: 'd4e5f6...', showFor: ['node_link'] },
      { id: 'relation',       label: 'Relation Label', type: 'text', placeholder: 'relates-to', showFor: ['node_link'] },
      { id: 'task',           label: 'Task', type: 'text', placeholder: 'Ship the release notes', showFor: ['eisenhower_add'] },
      { id: 'urgent',         label: 'Urgent', type: 'toggle', showFor: ['eisenhower_add'] },
      { id: 'important',      label: 'Important', type: 'toggle', showFor: ['eisenhower_add'] },
      { id: 'autoClassify',   label: 'Let an LLM classify urgent/important (opt-in)', type: 'toggle', showFor: ['eisenhower_add'] },
      { id: 'quadrant',       label: 'Quadrant', type: 'select', options: ['', 'do', 'schedule', 'delegate', 'delete'], showFor: ['eisenhower_list'] },
      { id: 'includeCompleted', label: 'Include completed', type: 'toggle', showFor: ['eisenhower_list'] },
      { id: 'taskId',         label: 'Task ID', type: 'text', placeholder: 'task id from eisenhower_list', showFor: ['eisenhower_complete'] },
      { id: 'label',          label: 'Session label', type: 'text', placeholder: 'Write tests', showFor: ['pomodoro_start'] },
      { id: 'durationMinutes', label: 'Duration (minutes)', type: 'number', placeholder: '25', showFor: ['pomodoro_start'] },
      { id: 'sessionRefId',   label: 'Session ID', type: 'text', placeholder: 'id from pomodoro_start', showFor: ['pomodoro_stop'] },
      { id: 'aborted',        label: 'Abandoned (not completed)', type: 'toggle', showFor: ['pomodoro_stop'] },
      { id: 'pomodoroLimit',  label: 'How many recent sessions', type: 'number', placeholder: '20', showFor: ['pomodoro_list'] },
    ]
  },
  {
    id: 'index_workspace', label: 'index_workspace', icon: '🗂',
    tag: 'Indexing',
    fields: [
      { id: 'force', label: 'Force Re-index', type: 'toggle', hint: 'Re-index even if already indexed' },
    ]
  },
  {
    id: 'browser_tool', label: 'browser_tool', icon: '🌐',
    tag: 'Web Scraping',
    fields: [
      { id: 'action', label: 'Action', type: 'select', options: ['navigate', 'snapshot', 'click', 'scroll', 'wait', 'evaluate', 'network', 'api_replay', 'extract', 'deep_scrape', 'screenshot', 'checkpoint', 'session', 'scrape'] },
      { id: 'url', label: 'Target URL', type: 'text', placeholder: 'https://example.com', showFor: ['navigate', 'scrape'] },
      { id: 'userInstructions', label: 'Extraction Instructions', type: 'textarea', placeholder: 'Scrape page headlines and stats', showFor: ['scrape'] },
      { id: 'outputDir', label: 'Output Directory (optional)', type: 'text', placeholder: 'browser-output', showFor: ['screenshot', 'extract', 'api_replay', 'deep_scrape', 'checkpoint', 'scrape'] },
      { id: 'params', label: 'Action params JSON (click: {"by":"uid","value":"..."}; scroll: {"target":"page"}; wait: {"until":"dom-stable"}; evaluate: {"function":"..."}; network/checkpoint/session: {"op":"..."})', type: 'textarea', placeholder: '{"by":"uid","value":"1_2"}' },
      { id: 'sessionId', label: 'Session ID', type: 'text', placeholder: 'browser_session_1' }
    ]
  },
  {
    id: 'cyber_tool', label: 'cyber_tool', icon: '🛡️',
    tag: 'Cyber Security',
    fields: [
      { id: 'action', label: 'Action', type: 'select', options: ['osint', 'osint_status', 'list_tools', 'get_tool', 'register_tool', 'wiki_lookup', 'learn', 'coach', 'save_graph', 'load_graph', 'tool_memory', 'run_action', 'resolve_tool'] },
      { id: 'prompt', label: 'Question (for resolve_tool)', type: 'textarea', placeholder: 'what libraries does hexstrike-ai depend on?', showFor: ['resolve_tool'] },
      { id: 'source', label: 'Source (for resolve_tool)', type: 'select', options: ['', 'github', 'docker', 'apt'], showFor: ['resolve_tool'] },
      { id: 'choice', label: 'Reply to follow-up (for resolve_tool)', type: 'text', placeholder: 'docker', showFor: ['resolve_tool'] },
      { id: 'target', label: 'Target (for osint)', type: 'text', placeholder: 'example.com or johndoe', showFor: ['osint', 'osint_status', 'run_action'] },
      { id: 'osintType', label: 'OSINT Type (for osint)', type: 'select', options: ['all', 'domain', 'ip', 'username'], showFor: ['osint'] },
      { id: 'autoSearch', label: 'Auto Search Recon Dorks (osint)', type: 'select', options: ['false', 'true'], showFor: ['osint'] },
      { id: 'allowPrivateIps', label: 'Allow Private / Internal IPs (SSRF Bypass)', type: 'select', options: ['false', 'true'], showFor: ['osint'] },
      { id: 'toolName', label: 'Tool Name', type: 'text', placeholder: 'sqlmap', showFor: ['get_tool', 'register_tool', 'wiki_lookup', 'tool_memory', 'learn', 'coach', 'resolve_tool'] },
      { id: 'githubUrl', label: 'GitHub URL (for register)', type: 'text', placeholder: 'https://github.com/sqlmapproject/sqlmap', showFor: ['register_tool'] },
      { id: 'sessionId', label: 'Session / CTF ID', type: 'text', placeholder: 'ctf-challenge-1' },
      { id: 'goal', label: 'Goal (for learn)', type: 'textarea', placeholder: 'enumerate services on a lab host with nmap', showFor: ['learn', 'coach'] },
      { id: 'level', label: 'Level (for learn)', type: 'select', options: ['', 'beginner', 'intermediate', 'advanced'], showFor: ['learn', 'coach'] },
      { id: 'observation', label: 'Observation (for coach)', type: 'textarea', placeholder: 'nmap showed port 80 open', showFor: ['coach'] },
      { id: 'graphNode', label: 'Graph Node JSON (for save_graph)', type: 'textarea', placeholder: '{"id":"hyp-1","label":"try SQLi on login form","type":"hypothesis","from":"root"}', showFor: ['save_graph'] },
      { id: 'memoryOp', label: 'Memory Op (for tool_memory)', type: 'select', options: ['', 'read', 'write'], showFor: ['tool_memory'] },
      { id: 'note', label: 'Note (for tool_memory write)', type: 'textarea', placeholder: '-sV -p- for a full service scan on lab targets', showFor: ['tool_memory'] }
    ]
  },
  {
    id: 'store_workspace_skill', label: 'store_workspace_skill', icon: '💾',
    tag: 'Skill Storage',
    fields: [
      { id: 'name',        label: 'Skill Name', type: 'text', placeholder: 'db-migration-helper' },
      { id: 'description', label: 'Description', type: 'text', placeholder: 'Database migration verification utility' },
      { id: 'what',        label: 'What was done (one item per line)', type: 'textarea', placeholder: 'Added verify-migrations.sh\nIntegrated schema diff checks' },
      { id: 'why',         label: 'Why', type: 'text', placeholder: 'Prevent schema drift during deployments' },
      { id: 'files',       label: 'Files (comma-separated)', type: 'text', placeholder: 'scripts/verify-migrations.sh' },
      { id: 'example',     label: 'Example (optional)', type: 'textarea', placeholder: 'Code snippet or usage example' },
      { id: 'script_instructions', label: 'Script Instructions JSON (optional, triggers background generation)', type: 'textarea', placeholder: '{"verify.py":"Diff Prisma schema against live DB"}' },
      { id: 'workspace_root', label: 'Workspace Root (required)', type: 'text', placeholder: 'C:/path/to/project' },
      { id: 'sessionId',   label: 'Session ID (for background generation polling)', type: 'text', placeholder: 'skill-gen-1' },
      { id: 'pollAction',  label: 'Poll Action (optional)', type: 'select', options: ['', 'run', 'status', 'abort'] },
    ]
  },
  {
    id: 'quantum_tool', label: 'quantum_tool', icon: '⚛️',
    tag: 'Multi-Branch Reasoning',
    fields: [
      { id: 'action', label: 'Action', type: 'select', options: ['setup', 'step', 'pause', 'continue', 'modify', 'reset', 'status', 'get_state', 'analyze'] },
      { id: 'sessionId', label: 'Session ID', type: 'text', placeholder: 'quantum-session-1' },
      { id: 'numBranches', label: 'Number of Branches (for setup)', type: 'number', placeholder: '3' },
      { id: 'personas', label: 'Personas (comma-separated, for setup/reset)', type: 'text', placeholder: 'Optimist, Skeptic, Pragmatist' },
      { id: 'gates', label: 'Gates JSON array (for modify)', type: 'textarea', placeholder: '[{"qubit":0,"column":0,"gate":"H"},{"qubit":0,"column":1,"gate":"RY","param":1.2}]' },
      { id: 'query', label: 'Question (for analyze)', type: 'textarea', placeholder: 'What should we conclude?' },
      { id: 'temperature', label: 'Compression temperature 0-1 (for analyze)', type: 'number', placeholder: '0.7' },
    ]
  },
  {
    id: 'local_llm_patch', label: 'local_llm_patch', icon: '🩹',
    tag: 'Local Code Patching',
    fields: [
      { id: 'filePath', label: 'File Path', type: 'text', placeholder: 'src/server.ts' },
      { id: 'instruction', label: 'Patch Instruction', type: 'textarea', placeholder: 'Add a new request-id header middleware' },
      { id: 'workspace_root', label: 'Workspace Root (optional)', type: 'text', placeholder: 'C:/path/to/project' },
      { id: 'sessionId', label: 'Session ID (optional)', type: 'text', placeholder: 'patch-session-1' },
    ]
  },
  {
    id: 'coding_agents', label: 'coding_agents', icon: '🤖',
    tag: 'Autonomous Multi-File Coding',
    fields: [
      { id: 'goal', label: 'Refactoring / Coding Goal', type: 'textarea', placeholder: 'Add rate limiting to express endpoints', showFor: ['', 'plan', 'execute', 'resume'] },
      { id: 'workspaceRoot', label: 'Workspace Root (optional)', type: 'text', placeholder: 'C:/path/to/workspace' },
      { id: 'dryRun', label: 'Dry Run Mode (simulate only)', type: 'toggle', default: true, showFor: ['', 'execute', 'resume'] },
      { id: 'topKFiles', label: 'Candidate Files Count (RAG)', type: 'number', placeholder: '5', showFor: ['', 'plan', 'execute'] },
      { id: 'sessionId', label: 'Session ID (optional)', type: 'text', placeholder: 'coding-session-1' },
      { id: 'action', label: 'Action', type: 'select', options: ['', 'plan', 'execute', 'resume', 'status', 'abort'] },
      { id: 'pauseOnTaskPlan', label: 'Pause On Task Plan', type: 'toggle', showFor: ['', 'execute'] },
      { id: 'verifyCommand', label: 'Verify Command (rolls back on regression)', type: 'text', placeholder: 'npx vitest run tests/a.test.ts', showFor: ['', 'execute', 'resume'] },
      { id: 'feedback', label: 'Feedback / Repair Brief (retry)', type: 'textarea', placeholder: 'paste result.verification.repairBrief from the previous attempt', showFor: ['', 'execute', 'resume'] },
      { id: 'verifyReport', label: 'Verify Report JSON (your own test run)', type: 'textarea', placeholder: '{"exitCode":1,"output":"..."}', showFor: ['', 'execute', 'resume'] },
      { id: 'targetFiles', label: 'Target Files (comma-separated)', type: 'text', placeholder: 'src/foo.ts, src/bar.ts', showFor: ['', 'plan', 'execute', 'resume'] },
      { id: 'verifyLspDiagnostics', label: 'Verify LSP Diagnostics', type: 'toggle', default: true, showFor: ['', 'execute'] },
      { id: 'astEditOps', label: 'AST Edit Ops JSON (optional)', type: 'textarea', placeholder: '[{"pat":"old($$A)","out":"new($$A)"}]', showFor: ['', 'execute', 'resume'] },
      { id: 'resolve', label: 'Resolve JSON (optional)', type: 'textarea', placeholder: '{"action":"apply"}', showFor: ['', 'execute', 'resume'] },
      { id: 'lspAction', label: 'LSP Action JSON (optional)', type: 'textarea', placeholder: '{"action":"diagnostics"}', showFor: ['', 'execute'] },
    ]
  },
  {
    id: 'get_token_stats', label: 'get_token_stats', icon: '📊',
    tag: 'Monitoring',
    fields: []
  },
  {
    id: 'validate_provider', label: 'validate_provider', icon: '🛡',
    tag: 'Health Check',
    fields: [
      { id: 'providerId', label: 'Provider ID', type: 'text', placeholder: 'groq' },
    ]
  },
  {
    id: 'agent_harness', label: 'agent_harness', icon: '⚡',
    tag: 'Multi-Agent Harness',
    fields: [
      { id: 'action', label: 'Action', type: 'select', options: ['deploy', 'resume', 'rerun', 'reorchestrate', 'status', 'approvals', 'approve', 'reject', 'trace', 'tasks', 'abort'] },
      { id: 'goal', label: 'Goal', type: 'textarea', placeholder: 'Audit authentication flow and harden session tokens', showFor: ['deploy'] },
      { id: 'runId', label: 'Run ID', type: 'text', placeholder: 'Run UUID (leave blank for a new deploy)' },
      { id: 'harness', label: 'Harness Template', type: 'text', placeholder: 'research-analysis', showFor: ['deploy'] },
      { id: 'role', label: 'Role Name', type: 'text', placeholder: 'security-reviewer', showFor: ['rerun','reorchestrate'] },
      { id: 'followupContext', label: 'Followup Steering Context', type: 'textarea', placeholder: 'Focus strictly on JWT cookie scoping', showFor: ['rerun','reorchestrate'] },
      { id: 'approvalId', label: 'Approval ID', type: 'text', placeholder: 'appr-123', showFor: ['approve','reject'] },
      { id: 'note', label: 'Note (optional)', type: 'text', placeholder: 'why', showFor: ['approve','reject'] },
      { id: 'workspace_root', label: 'Workspace Root (optional)', type: 'text', placeholder: 'C:/path/to/project' },
      { id: 'maxTokens', label: 'Max Tokens (optional)', type: 'number', placeholder: '60000', showFor: ['deploy'] },
      { id: 'maxWallMinutes', label: 'Raise wall-clock cap (minutes)', type: 'number', placeholder: '120', showFor: ['resume'] },
      { id: 'limit', label: 'Events to return', type: 'number', placeholder: '200', showFor: ['trace'] }
    ]
  },
  {
    id: 'movie_tool', label: 'movie_tool', icon: '🎬',
    tag: 'Vibe Movie Engine',
    fields: [
      { id: 'action', label: 'Action', type: 'select', options: ['init_project', 'get_timeline', 'propose_slots', 'add_artifact', 'approve_artifact', 'reroll_artifact', 'generate_assets', 'generate_story', 'update_artifact_bounds', 'apply_effect', 'undo_effect', 'compile_timeline'] },
      { id: 'projectId', label: 'Project ID', type: 'text', placeholder: 'proj_cyberpunk_01' },
      { id: 'premise', label: 'Premise / Prompt', type: 'textarea', placeholder: 'Cyberpunk rainy alleyway with neon signs', showFor: ['init_project', 'propose_slots', 'generate_story'] },
      { id: 'prompt', label: 'Prompt (generate_assets / generate_story)', type: 'textarea', placeholder: 'Neon rain on an empty street, slow dolly in', showFor: ['generate_assets', 'generate_story'] },
      { id: 'track', label: 'Track Lane', type: 'select', options: ['video', 'vfx', 'bgm', 'bgm_drums', 'bgm_bass', 'bgm_melody', 'vocal', 'song', 'script', 'dialogue'], showFor: ['generate_assets', 'add_artifact', 'propose_slots', 'apply_effect'] },
      { id: 'start_ms', label: 'Start Time (ms)', type: 'number', placeholder: '0', showFor: ['add_artifact', 'update_artifact_bounds'] },
      { id: 'end_ms', label: 'End Time (ms)', type: 'number', placeholder: '5000', showFor: ['add_artifact', 'update_artifact_bounds'] },
      { id: 'label', label: 'Artifact Label', type: 'text', placeholder: 'Opening Cut', showFor: ['add_artifact'] },
      { id: 'artifact_path', label: 'File Path / URL', type: 'text', placeholder: 'projects/default/video.mp4', showFor: ['add_artifact', 'generate_assets'] },
      { id: 'artifactId', label: 'Artifact ID (for approve/reroll/effects)', type: 'text', placeholder: 'art_123', showFor: ['reroll_artifact', 'approve_artifact', 'apply_effect', 'undo_effect', 'update_artifact_bounds'] }
    ]
  }
];

let activeTool = TOOLS[0];
let availableModels = [];

const toolList      = document.getElementById('tool-list');
const pgForm        = document.getElementById('pg-form');
const pgToolTitle   = document.getElementById('pg-tool-title');
const pgResponseBody = document.getElementById('pg-response-body');

// Build tool list sidebar
toolList.innerHTML = TOOLS.map((t, i) => `
  <div class="tool-item${i === 0 ? ' active' : ''}" data-tool="${t.id}">
    <span class="tool-item-icon">${t.icon}</span>
    <div>
      <div class="tool-item-name">${t.label}</div>
      <div class="tool-item-tag">${t.tag}</div>
    </div>
  </div>
`).join('');

toolList.querySelectorAll('.tool-item').forEach(item => {
  item.addEventListener('click', () => {
    toolList.querySelectorAll('.tool-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    activeTool = TOOLS.find(t => t.id === item.dataset.tool);
    renderToolForm(activeTool);
  });
});

async function ensureModels() {
  if (availableModels.length) return;
  try {
    const r = await fetch('/api/models');
    if (!r.ok) return;
    const d = await r.json();
    availableModels = d.models || [];
  } catch {}
}

const TOOL_WHEN_TO_USE = {
  use_free_llm: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Your primary AI Swiss Army Knife for asking questions, writing code, research, and running multi-step background tasks without paying for tokens.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "run"</code> (Default) — Start a direct chat turn or multi-step agentic plan (set <code>agentic: true</code>).</li>
      <li><code>action: "status"</code> — Check the progress of a long-running background task.</li>
      <li><code>action: "continue"</code> — Resume after human-in-the-loop terminal action (pass <code>resume_input: "continue <ID> <result>"</code>).</li>
      <li><code>action: "abort"</code> — Cancel an active execution.</li>
    </ul>`,

  vision_tool: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Vision Language Model (VLM) inspector for reading images, comparing UI screenshots, and parsing flowchart diagrams.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "analyze_ui"</code> — Extract clickable buttons, text inputs, and pixel coordinates from UI screenshots.</li>
      <li><code>action: "extract_diagram"</code> — Convert architectural diagrams and flowcharts into readable structured text.</li>
      <li><code>action: "compare_diff"</code> — Compare two screenshots to detect visual regression differences (requires <code>compare_image_path</code>).</li>
      <li><code>action: "inspect_image"</code> — General OCR and image Q&A using free vision models.</li>
    </ul>`,

  coding_agents: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Autonomous multi-file software engineer based on the OMP (oh-my-pi) pattern. Searches your codebase, writes hash-anchored patches, performs AST rewrites, verifies compiler diagnostics, and commits or rolls back changes.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "plan"</code> — Decomposes the goal into tasks.md and pauses; <code>"resume"</code> executes the next pending task.</li>
      <li><code>action: "execute"</code> (default) — Executes full refactoring pipeline (Vector RAG grep &rarr; Hashline diffs &rarr; Polyglot LSP checks).</li>
      <li><code>action: "status"</code> / <code>"abort"</code> — Poll or cancel a background run started by a prior dryRun:false call.</li>
      <li><code>resolve: {action: "apply", checkpointId?}</code> — Confirms and saves patched files to disk.</li>
      <li><code>resolve: {action: "rollback", checkpointId?}</code> — Instantly restores previous state using Content-Addressable Storage (CAS) snapshots.</li>
    </ul>`,

  local_llm_patch: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>100% offline code patcher that runs on your machine via local Ollama. Zero network requests, 0 API cost.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "apply_patch"</code> — Generate and apply targeted unified diff to a single file.</li>
      <li><code>action: "revert_patch"</code> — Restore the original file from the automatic backup snapshot.</li>
      <li><code>action: "audit_ast"</code> — Check syntax trees for compilation errors before applying.</li>
    </ul>`,

  browser_tool: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Headless Playwright web browser for scraping dynamic sites, clicking buttons, extracting tables, and capturing network calls.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "navigate"</code> & <code>"snapshot"</code> — Load URL and return the clean accessibility tree (low token cost).</li>
      <li><code>action: "click"</code>, <code>"scroll"</code>, <code>"wait"</code> — Interact with dynamic single-page applications (SPAs).</li>
      <li><code>action: "network"</code> & <code>"api_replay"</code> — Intercept private backend JSON APIs and replay them directly without browser overhead.</li>
      <li><code>action: "deep_scrape"</code> & <code>"extract"</code> — Extract structured tables into clean JSON/CSV with anti-bot stealth.</li>
    </ul>`,

  cyber_tool: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Security coaching assistant, passive OSINT reconnaissance engine, and decision-graph tracker for authorized CTF challenges and educational penetration testing.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "osint"</code> — Passive DNS & infrastructure reconnaissance (A, AAAA, MX, TXT, NS), search dork generation, and automatic Markdown report creation in the cyber wiki. Supports <code>autoSearch: true</code> to run recon dorks in the background — poll results with <code>action: "osint_status"</code> (same sessionId/target).</li>
      <li><code>action: "lookup"</code> / <code>"get_tool"</code> — Query CLI flags and syntax for security tools (nmap, sqlmap, gobuster, etc.).</li>
      <li><code>action: "coach"</code> — Receive strategic next test steps based on target recon findings.</li>
      <li><code>action: "save_graph"</code> & <code>"load_graph"</code> — Create or visualize hypothesis nodes on the persistent engagement graph.</li>
      <li><code>action: "tool_memory"</code> — Read or persist tactical execution notes.</li>
    </ul>
    <div style="margin-top:6px;font-size:0.72rem;color:var(--accent-red,#ff5555);">
      🛡️ <b>Security Boundary:</b> Requests to cloud metadata (<code>169.254.169.254</code>) and private subnets are blocked by default to prevent SSRF.
    </div>`,

  quantum_tool: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Multi-branch reasoning tool that explores diverging hypotheses using quantum-inspired gates and state collapse synthesis. Includes a strict drift guard to prevent decoherence.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "setup"</code> — Initialize circuit with a preset (<code>"adversarial_debate"</code>, <code>"superposition_exploration"</code>, etc.).</li>
      <li><code>action: "step"</code> — Execute gate columns (Hadamard reset, Pauli-X flip, RY rotation, CNOT entanglement).</li>
      <li><code>action: "analyze"</code> — Collapse the quantum state and generate synthesized LLM conclusions.</li>
    </ul>`,

  execute_skill: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Runs specialized agent workflows loaded with strict SKILL.md rules, examples, and domain guardrails.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "run"</code> — Provide <code>skill_name</code> (e.g. <code>"vibe-code-auditor"</code>, <code>"tdd-workflow"</code>) and your user prompt.</li>
    </ul>`,

  load_skill_prompt: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Search and load ready-to-use system prompts from the local repository or bundled Hermes catalog without running the LLM.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>type: "load"</code> / <code>"search"</code> / <code>"list"</code> — Load a specific skill, search by keyword, or list bundled skills.</li>
      <li><code>source: "agentic-awesome"</code> / <code>"hermes"</code> — Which skill catalog to use; agentic-awesome downloads run in the background — poll with <code>pollAction: "status"</code> (same sessionId).</li>
    </ul>`,

  manage_memory: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Manage persistent long-term memory, project architectural decision records (ADRs), and workspace wiki documentation.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>action: "search"</code> / <code>"list"</code> / <code>"stats"</code> / <code>"clear"</code> — Workspace key-value memory.</li>
      <li><code>action: "wiki_search"</code> / <code>"wiki_write"</code> / <code>"wiki_list"</code> / <code>"wiki_read"</code> — Maintain technical wiki guides.</li>
      <li><code>action: "node_add"</code> / <code>"node_link"</code> / <code>"node_list"</code> / <code>"node_get"</code> / <code>"graph_query"</code> — DAG memory node/edge graph with Ebbinghaus decay.</li>
    </ul>`,

  index_workspace: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Proactively scans and embeds all files in your project into the local vector database for fast semantic search.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>workspace_root</code> — Target directory path to index.</li>
      <li><code>force: true</code> — Force re-indexing all files, bypassing timestamp caches.</li>
    </ul>`,

  store_workspace_skill: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Save custom reusable AI skills, and optionally generate scripts for them via an internal LLM, into the workspace's skill directory.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li>Provide <code>name</code>, <code>description</code>, <code>what</code>, and <code>workspace_root</code> (required) to write SKILL.md.</li>
      <li><code>script_instructions</code> (JSON map filename→instruction) triggers background script generation — poll with <code>pollAction: "status"</code> (same sessionId); <code>pollAction: "abort"</code> cancels an in-flight run.</li>
    </ul>`,

  validate_provider: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Diagnose LLM provider connectivity, check API keys, and test latency.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li><code>provider</code> — Select provider (e.g. <code>"gemini"</code>, <code>"groq"</code>, <code>"openrouter"</code>, <code>"ollama"</code>, <code>"cohere"</code>).</li>
    </ul>`,

  get_token_stats: `
    <div style="font-weight:700;color:var(--accent-cyan);margin-bottom:4px;">🌟 Beginner Overview:</div>
    <div>Inspect your real-time rate limit meters, remaining requests, and lifetime tokens across all providers.</div>
    <div style="margin-top:8px;font-weight:700;color:var(--accent-purple);">🛠️ Subtools & Actions (What to trigger):</div>
    <ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem;">
      <li>No parameters required — returns live memory counters synchronized with disk storage.</li>
    </ul>`
};

async function showToolDocsModal(tool) {
  const modal = document.getElementById('tool-docs-modal');
  const title = document.getElementById('modal-tool-title');
  const icon = document.getElementById('modal-tool-icon');
  const tag = document.getElementById('modal-tool-tag');
  const whenToUse = document.getElementById('modal-when-to-use');
  const body = document.getElementById('modal-tool-body');
  const closeBtn = document.getElementById('modal-close-btn');

  if (!modal) return;

  title.textContent = tool.label;
  icon.textContent = tool.icon || '📖';
  tag.textContent = tool.tag || 'Tool Reference';
  whenToUse.innerHTML = TOOL_WHEN_TO_USE[tool.id] || `<strong>When to use:</strong> Specialized automation tool for ${tool.label}.`;
  body.innerHTML = '<div class="conv-empty"><span class="spinner"></span> Loading documentation…</div>';

  modal.style.display = 'flex';

  const closeModal = () => {
    modal.style.display = 'none';
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') closeModal();
  };

  closeBtn.onclick = closeModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };
  document.addEventListener('keydown', onKey);

  try {
    const r = await fetch(`/api/tool-docs/${tool.id}`);
    const d = await r.json();
    const md = d.markdown || `# ${tool.label}\n\nNo detailed documentation found for \`${tool.id}\`.`;
    body.innerHTML = await renderMarkdown(md);
  } catch (err) {
    body.innerHTML = `<div style="color:var(--accent-red);padding:12px;">Failed to load documentation: ${esc(err.message)}</div>`;
  }
}

function renderToolForm(tool) {
  pgToolTitle.innerHTML = `${tool.label} <button id="tool-info-btn" title="View tool docs & usage guide" style="background:none;border:none;cursor:pointer;font-size:0.95rem;color:var(--accent-cyan);margin-left:8px;transition:transform 0.15s ease;" onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'">ⓘ</button>`;
  const infoBtn = document.getElementById('tool-info-btn');
  if (infoBtn) {
    infoBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showToolDocsModal(tool);
    };
  }
  pgForm.innerHTML = '';

  if (!tool.fields.length) {
    pgForm.innerHTML = '<p style="color:var(--text-muted);font-size:.8rem;">No parameters required — just click Run Tool.</p>';
    return;
  }

  tool.fields.forEach(f => {
    const wrap = document.createElement('div');
    wrap.id = `field-wrap-${f.id}`;

    const lbl = document.createElement('label');
    lbl.className = 'field-label';
    lbl.setAttribute('for', `pg-field-${f.id}`);
    lbl.textContent = f.label;
    wrap.appendChild(lbl);

    if (f.type === 'toggle') {
      lbl.className = '';
      const row = document.createElement('div');
      row.className = 'toggle-row';

      const tog = document.createElement('label');
      tog.className = 'toggle';
      const inp = document.createElement('input');
      inp.type = 'checkbox'; inp.id = `pg-field-${f.id}`;
      const slider = document.createElement('span');
      slider.className = 'toggle-slider';
      tog.appendChild(inp); tog.appendChild(slider);

      const hint = document.createElement('span');
      hint.style.cssText = 'font-size:.8rem;color:var(--text-secondary);';
      hint.textContent = f.hint || f.label;

      row.appendChild(tog); row.appendChild(hint);
      wrap.innerHTML = '';
      wrap.appendChild(row);

    } else if (f.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.id = `pg-field-${f.id}`;
      ta.placeholder = f.placeholder || '';
      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          pgRunBtn.click();
        }
      });
      wrap.appendChild(ta);

    } else if (f.type === 'select') {
      const sel = document.createElement('select');
      sel.id = `pg-field-${f.id}`;
      (f.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        sel.appendChild(o);
      });
      wrap.appendChild(sel);

    } else if (f.type === 'model-picker') {
      // ── Combobox with live filtering ──────────────────────────
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative;';

      const inp = document.createElement('input');
      inp.type = 'text';
      inp.id = `pg-field-${f.id}`;
      inp.placeholder = '— auto-route or type to filter —';
      inp.autocomplete = 'off';
      inp.setAttribute('aria-autocomplete', 'list');
      inp.setAttribute('role', 'combobox');
      wrapper.appendChild(inp);

      const dropdown = document.createElement('div');
      dropdown.style.cssText = 'position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:9999;background:#1a1a2e;border:1px solid var(--glass-border);border-radius:var(--radius-sm);max-height:220px;overflow-y:auto;display:none;box-shadow:0 8px 32px rgba(0,0,0,.6);';
      wrapper.appendChild(dropdown);

      // Store actual modelId separately from display value
      inp._modelId = '';

      const buildOptions = (filter = '') => {
        dropdown.innerHTML = '';
        const q = filter.toLowerCase();
        const items = availableModels.filter(m =>
          !q || m.modelName.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q)
        );
        if (!items.length) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:8px 12px;color:var(--text-muted);font-size:.78rem;';
          empty.textContent = filter ? `Use "${filter}" as custom model ID` : 'No models loaded';
          dropdown.appendChild(empty);
          return;
        }
        items.forEach(m => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:7px 12px;cursor:pointer;font-size:.8rem;transition:background .15s;';
          item.innerHTML = `<span style="color:var(--text-primary);">${esc(m.modelName)}</span> <span style="color:var(--text-muted);font-size:.72rem;">[${esc(m.providerName)}]</span>`;
          item.addEventListener('mouseenter', () => item.style.background = 'rgba(255,255,255,.07)');
          item.addEventListener('mouseleave', () => item.style.background = '');
          item.addEventListener('mousedown', e => {
            e.preventDefault();
            inp.value = `${m.modelName} [${m.providerName}]`;
            inp._modelId = m.modelId;
            dropdown.style.display = 'none';
          });
          dropdown.appendChild(item);
        });
      };

      inp.addEventListener('focus', async () => {
        await ensureModels();
        buildOptions(inp.value);
        dropdown.style.display = 'block';
      });
      inp.addEventListener('input', () => {
        inp._modelId = ''; // reset on manual type
        buildOptions(inp.value);
        dropdown.style.display = 'block';
      });
      inp.addEventListener('keydown', e => {
        const items = dropdown.querySelectorAll('div');
        const active = dropdown.querySelector('.combo-active');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = active ? active.nextElementSibling : items[0];
          if (next) { active?.classList.remove('combo-active'); next.classList.add('combo-active'); next.style.background = 'rgba(255,255,255,.12)'; next.scrollIntoView({ block: 'nearest' }); }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = active?.previousElementSibling;
          if (prev) { active.classList.remove('combo-active'); active.style.background = ''; prev.classList.add('combo-active'); prev.style.background = 'rgba(255,255,255,.12)'; prev.scrollIntoView({ block: 'nearest' }); }
        } else if (e.key === 'Enter' && active) {
          e.preventDefault(); active.dispatchEvent(new MouseEvent('mousedown'));
        } else if (e.key === 'Escape') {
          dropdown.style.display = 'none';
        }
      });
      document.addEventListener('click', e => { if (!wrapper.contains(e.target)) dropdown.style.display = 'none'; }, true);

      wrap.appendChild(wrapper);

    } else if (f.type === 'number') {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.id = `pg-field-${f.id}`;
      inp.placeholder = f.placeholder || ''; inp.min = 1; inp.max = 100;
      wrap.appendChild(inp);

    } else {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.id = `pg-field-${f.id}`;
      inp.placeholder = f.placeholder || '';
      wrap.appendChild(inp);
    }

    pgForm.appendChild(wrap);
  });

  // Show only the inputs that apply to the chosen action (fields without showFor are always shown).
  const actionId = tool.actionField || 'action';
  const applyVisibility = () => {
    const actionEl = document.getElementById(`pg-field-${actionId}`);
    const action = actionEl ? actionEl.value : '';
    tool.fields.forEach(f => {
      const w = document.getElementById(`field-wrap-${f.id}`);
      if (w) w.style.display = fieldVisibleFor(f, action) ? '' : 'none';
    });
  };
  const chosen = document.getElementById(`pg-field-${actionId}`);
  if (chosen) chosen.addEventListener('change', applyVisibility);
  applyVisibility();
}

function collectParams(tool) {
  const params = {};
  const ws = pgWorkspace.value.trim();
  if (ws) params.workspace_root = ws;

  const actionEl = document.getElementById(`pg-field-${tool.actionField || 'action'}`);
  const currentAction = actionEl ? actionEl.value : '';

  tool.fields.forEach(f => {
    const el = document.getElementById(`pg-field-${f.id}`);
    if (!el) return;
    // an input that does not apply to the chosen action is not sent (it may hold a stale value)
    if (!fieldVisibleFor(f, currentAction)) return;

    if (f.type === 'toggle')       params[f.id] = el.checked;
    else if (f.type === 'number' && f.id === 'temperature') params[f.id] = el.value ? parseFloat(el.value) : undefined;
    else if (f.type === 'number')  params[f.id] = el.value ? parseInt(el.value, 10) : undefined;
    else if (f.type === 'model-picker') {
      const inp = document.getElementById(`pg-field-${f.id}`);
      // Use the stored modelId if set (picked from dropdown), else use raw typed value
      params[f.id] = (inp?._modelId) || inp?.value.trim() || undefined;
    } else if (f.type === 'textarea' && f.id === 'what') {
      params[f.id] = el.value.split('\n').map(l => l.trim()).filter(Boolean);
    } else if (f.id === 'keywords') {
      params[f.id] = el.value ? el.value.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    } else if (f.id === 'files') {
      params[f.id] = el.value ? el.value.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    } else if (f.id === 'params' || f.id === 'graphNode' || f.id === 'gates' || f.id === 'script_instructions' || f.id === 'metadata') {
      const raw = el.value.trim();
      if (raw) {
        try { params[f.id] = JSON.parse(raw); } catch { params[f.id] = raw; }
      }
    } else if (f.id === 'personas') {
      params[f.id] = el.value ? el.value.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    } else {
      const v = el.value.trim();
      if (v) params[f.id] = v;
    }
  });

  return params;
}
