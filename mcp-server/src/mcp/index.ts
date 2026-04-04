import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { useFreeLLM } from '../tools/use-free-llm.js';
import { listAvailableFreeModels } from '../tools/list-models.js';
import { runCodeMode } from '../tools/code-mode.js';
import { manageMemory } from '../tools/manage-memory.js';
import { storeMemory } from '../tools/store-memory.js';
import { getTokenStats } from '../tools/get-token-stats.js';
import { validateProvider } from '../tools/validate-provider.js';

export async function createMCPServer(): Promise<Server> {
  const server = new Server(
    { name: 'free-llm-apis', version: '1.0.3' },
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
          'Use `list_available_free_models` first to pick a model, or let the router choose.',
          '',
          'INPUTS:',
          '  model (required)      — Model ID, e.g. "llama-3.3-70b-versatile" or "gemini-2.0-flash".',
          '  messages (required)   — Array of {role, content}. Roles: "system" | "user" | "assistant".',
          '  provider (optional)   — Pin to a specific provider ID (e.g. "groq", "gemini"). Skips routing.',
          '  temperature           — 0.0–2.0. Default 0.7. Lower = deterministic.',
          '  max_tokens            — Max output tokens. Default 1024.',
          '  top_p                 — Nucleus sampling. Default 1.0.',
          '  stream                — Reserved; currently returns full response.',
          '  fallback              — Enable provider fallback cascade. Default true.',
          '  workspace_root        — Workspace path for cache-keying and session derivation.',
          '  agentic               — Enable agentic mode (task decomposition + system prompt injection).',
          '  sessionId             — Required for agentic mode. Partitions memory/logs per project.',
          '  google_search         — Enable Google search for Gemini models (default false).',
          '  top_p                 — Nucleus sampling. Default 1.0.',
          '',
          'OUTPUTS: { id, object, model, choices[{message:{role,content}, finish_reason}], usage }',
          '',
          'FAILURE STATES:',
          '  - "No providers available": all fallback models exhausted. Check `get_token_stats`.',
          '  - "Rate limited": provider quota exceeded. Use fallback:true or try another provider.',
          '  - "Invalid model": run `list_available_free_models` to see valid model IDs.',
          '',
          'EXAMPLE:',
          '  { model: "llama-3.3-70b-versatile", messages: [{role:"user", content:"Explain JWT"}] }',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            model: { type: 'string', description: 'Model ID to use (e.g. "llama-3.3-70b-versatile", "gemini-2.0-flash")' },
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
            temperature: { type: 'number', description: 'Sampling temperature 0.0–2.0 (default 0.7). Lower = more deterministic.' },
            max_tokens: { type: 'number', description: 'Maximum tokens to generate (default 1024)' },
            top_p: { type: 'number', description: 'Nucleus sampling probability (default 1.0)' },
            stream: { type: 'boolean', description: 'Reserved for future streaming support (default false)' },
            provider: { type: 'string', description: 'Pin to a specific provider ID, bypassing routing (e.g. "groq", "gemini")' },
            fallback: { type: 'boolean', description: 'Enable automatic fallback cascade when primary fails (default true)' },
            workspace_root: { type: 'string', description: 'Workspace root path for cache-keying and auto-sessionId derivation' },
            agentic: { type: 'boolean', description: 'Enable agentic mode: task decomposition and intelligent system prompt injection' },
            sessionId: { type: 'string', description: 'Unique session identifier required for agentic mode (e.g. UUID or project slug). Partitions state and logs per project.' },
            google_search: { type: 'boolean', description: 'Enable Google search for Gemini models (default false)' },
          },
          required: ['model', 'messages'],
        },
      },
      {
        name: 'list_available_free_models',
        description: [
          'Enumerate all registered LLM providers and models with rate-limit metadata.',
          '',
          'USER STORY: Discover which free models and providers are configured and available',
          'before sending a request. Use this to select the best model for a task or to check',
          'which providers have API keys set.',
          '',
          'WHEN TO USE: Before calling `use_free_llm` when you want to choose a specific model,',
          'or to audit which providers are active in the current environment.',
          '',
          'INPUTS:',
          '  provider (optional)      — Filter results to a single provider ID (e.g. "groq").',
          '  available_only (optional)— If true, only return models whose provider has an API key set.',
          '',
          'OUTPUTS: { models: [{providerId, modelId, modelName, rateLimits, available}], summary }',
          '  Each model entry includes rate limits (rpm, rpd, tpm) and availability flag.',
          '',
          'FAILURE STATES:',
          '  - Empty models array: no providers registered or all filtered out.',
          '  - available:false entries: provider is registered but API key is not set in environment.',
          '',
          'EXAMPLE:',
          '  { available_only: true }  → lists only models with configured API keys',
          '  { provider: "groq" }      → lists all Groq models with rate-limit metadata',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            provider: { type: 'string', description: 'Filter by provider ID (e.g. "groq", "gemini", "openrouter")' },
            available_only: { type: 'boolean', description: 'If true, only return models whose provider API key is configured' },
          },
        },
      },
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
          '                          Use `list_available_free_models` to get valid provider IDs.',
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
      {
        name: 'code_mode',
        description: [
          'Execute code in a sandboxed runtime against input data. Only stdout enters context.',
          '',
          'USER STORY: Process large API responses or datasets with a script without flooding',
          'the LLM context window. Write a filtering/transformation script; only its printed',
          'output (stdout) is returned — not the raw DATA payload.',
          '',
          'WHEN TO USE: When an API response is too large to pass directly to an LLM. Write a',
          'script to extract only the relevant fields, then pass the compressed output to',
          '`use_free_llm`. Also use for sandboxed computation, data transformation, or testing',
          'code snippets in isolation.',
          '',
          'INPUTS:',
          '  code (required)   — Script source. Use print() or console.log() to emit output.',
          '                      DATA global contains the input string (from `data` param).',
          '  language          — Sandbox runtime (default: "javascript"):',
          '                      "javascript" — QuickJS (quickjs-emscripten), in-process',
          '                      "python"     — RestrictedPython subprocess; requires python3 + pip install RestrictedPython',
          '                      "go"         — goja (pure-Go ECMAScript); requires pre-built binary',
          '                                     Build: cd scripts/go-sandbox-runner && go build -o sandbox-runner .',
          '                      "rust"       — boa_engine (pure-Rust ECMAScript); requires pre-built binary',
          '                                     Build: cd scripts/rust-sandbox-runner && cargo build --release',
          '  data              — Raw input string injected as DATA global variable.',
          '  command           — Human-readable description of what the script does (for logging).',
          '  timeout_ms        — Max execution time in milliseconds (default 5000).',
          '',
          'OUTPUTS: { stdout, stderr, success, error?, executionTimeMs, compressionRatio? }',
          '  compressionRatio = stdout.length / data.length (< 1 = context savings achieved).',
          '',
          'SANDBOX CONSTRAINTS (all languages):',
          '  - No filesystem access (read or write)',
          '  - No network access',
          '  - No process/OS calls',
          '  - Execution time limited by timeout_ms',
          '',
          'FAILURE STATES:',
          '  - success:false + error:"Execution timed out": increase timeout_ms or simplify script.',
          '  - success:false + error message: syntax or runtime error in script; check stderr.',
          '  - Empty stdout: script ran but called no print()/console.log().',
          '  - Binary not found (go/rust): build the runner first per instructions above.',
          '',
          'JAVASCRIPT EXAMPLE:',
          '  code: "const items = JSON.parse(DATA); print(items.map(i=>i.name).join(\\"\\\\n\\"))"',
          '  data: \'[{"name":"Alice"},{"name":"Bob"}]\'',
          '  → stdout: "Alice\\nBob"',
          '',
          'PYTHON EXAMPLE:',
          '  language: "python"',
          '  code: "import json; items=json.loads(DATA); print(len(items))"',
          '  data: \'[1,2,3]\'',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            code: { type: 'string', description: 'Script source code. Use print() or console.log() to emit output. DATA global contains the input data string.' },
            language: {
              type: 'string',
              enum: ['javascript', 'python', 'go', 'rust'],
              description: 'Sandbox runtime language (default: "javascript"). Each runs in an isolated, network-free, filesystem-free environment.',
            },
            data: { type: 'string', description: 'Input data injected as DATA global variable in the sandbox' },
            command: { type: 'string', description: 'Human-readable description of what the script does (used for logging and memory)' },
            timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 5000). Increase for heavy computations.' },
          },
          required: ['code'],
        },
      },
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
          '  - AFTER processing: check stats for token/compression savings.',
          '  - FOR CLEANUP: clear workspace memory when starting fresh.',
          '',
          'INPUTS:',
          '  action (required)        — One of: "search" | "list" | "stats" | "clear".',
          '  workspace_root (optional)— Absolute path to workspace root. Used to scope memory.',
          '  query (optional)         — Search term for "search" action (semantic/substring match).',
          '  limit (optional)         — Max results for "search" action (default 10).',
          '',
          'ACTION DETAILS:',
          '  search → Returns memory entries matching query for the workspace.',
          '           Input: { action:"search", workspace_root:"/src/app", query:"authentication" }',
          '  list   → Returns workspace identifier and hash for the given root.',
          '           Input: { action:"list", workspace_root:"/src/app" }',
          '  stats  → Returns aggregate compression stats (bytes saved, ratio) across all operations.',
          '           Input: { action:"stats" }',
          '  clear  → Marks workspace memory namespace for clearing.',
          '           Input: { action:"clear", workspace_root:"/src/app" }',
          '',
          'OUTPUTS:',
          '  search → Array of memory entries with metadata.',
          '  list   → { workspace, hash }',
          '  stats  → { totalOriginalBytes, totalCompressedBytes, overallRatio, operationCount }',
          '  clear  → { success:true, message }',
          '',
          'FAILURE STATES:',
          '  - "Unsupported action": only search/list/stats/clear are valid.',
          '  - Empty search results: no prior memory for this workspace or query has no matches.',
          '',
          'AGENT REMINDER: Always invoke manage_memory before wide-context actions to retrieve',
          'relevant prior work and avoid redundant processing.',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['search', 'list', 'stats', 'clear'],
              description: 'Memory operation: "search" (find entries), "list" (workspace info), "stats" (usage metrics), "clear" (reset workspace)',
            },
            workspace_root: { type: 'string', description: 'Absolute path to workspace root for scoping memory operations (e.g. "/home/user/my-project")' },
            query: { type: 'string', description: 'Search term for "search" action — used for semantic or substring retrieval of prior context' },
            limit: { type: 'number', description: 'Maximum number of results to return for "search" action (default 10)' },
          },
          required: ['action'],
        },
      },
      {
        name: 'store_memory',
        description: [
          'Store manual context or persistent thoughts in long-term memory.',
          '',
          'USER STORY: Save findings, summaries, or context details explicitly to the workspace',
          'memory so it can be recalled later via `manage_memory` search. This avoids context',
          'loss between agent sessions.',
          '',
          'WHEN TO USE: After concluding research, finding an architectural decision, or completing',
          'a subset of a large task when the data must persist for the next agent run.',
          '',
          'INPUTS:',
          '  key            — A short, descriptive identifier for this context.',
          '  content        — The details or summary to store.',
          '  workspace_root — Absolute path to workspace root for isolation.',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            key: { type: 'string', description: 'Short identifier for this context, e.g. "auth_strategy"' },
            content: { type: 'string', description: 'The text or JSON context to store' },
            workspace_root: { type: 'string', description: 'Absolute path to workspace root (e.g. "/home/user/my-project")' },
          },
          required: ['key', 'content'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'use_free_llm') {
        const input = args as unknown as Parameters<typeof useFreeLLM>[0];
        const result = await useFreeLLM(input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'list_available_free_models') {
        const input = args as Parameters<typeof listAvailableFreeModels>[0];
        const result = await listAvailableFreeModels(input ?? {});
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'code_mode') {
        const input = args as unknown as Parameters<typeof runCodeMode>[0];
        const result = await runCodeMode(input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'manage_memory') {
        const input = args as unknown as Parameters<typeof manageMemory>[0];
        const result = await manageMemory(input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'store_memory') {
        const input = args as unknown as Parameters<typeof storeMemory>[0];
        const result = await storeMemory(input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'get_token_stats') {
        const result = await getTokenStats();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'validate_provider') {
        const { providerId } = args as { providerId: string };
        const result = await validateProvider(providerId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  return server;
}
