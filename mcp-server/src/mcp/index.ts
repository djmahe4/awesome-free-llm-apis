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
import { getTokenStats } from '../tools/get-token-stats.js';
import { validateProvider } from '../tools/validate-provider.js';

export async function createMCPServer(): Promise<Server> {
  const server = new Server(
    { name: 'free-llm-apis', version: '1.0.1' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'use_free_llm',
        description: 'Call any free LLM API. Automatically routes to the right provider.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            model: { type: 'string', description: 'Model ID to use' },
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
              description: 'Messages array',
            },
            temperature: { type: 'number', description: 'Sampling temperature (default 0.7)' },
            max_tokens: { type: 'number', description: 'Max tokens to generate (default 1024)' },
            top_p: { type: 'number', description: 'Top-p sampling' },
            stream: { type: 'boolean', description: 'Stream response (default false)' },
            provider: { type: 'string', description: 'Override provider ID' },
            fallback: { type: 'boolean', description: 'Enable fallback (default true)' },
            workspace_root: { type: 'string', description: 'Root directory of the workspace to scan for context' },
            agentic: { type: 'boolean', description: 'Enable agentic mode (reasoning and task decomposition)' },
            sessionId: { type: 'string', description: 'Mandatory unique identifier for agentic sessions (e.g., UUID or project name)' },
          },
          required: ['model', 'messages'],
        },
      },
      {
        name: 'list_available_free_models',
        description: 'List all available free LLM models and their providers',
        inputSchema: {
          type: 'object' as const,
          properties: {
            provider: { type: 'string', description: 'Filter by provider ID' },
            available_only: { type: 'boolean', description: 'Only show providers with API keys configured' },
          },
        },
      },
      {
        name: 'get_token_stats',
        description: 'Get real-time token tracking statistics and remaining limits for all loaded API providers.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'validate_provider',
        description: 'Run a professional health check and credential validation for a specific LLM provider.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            providerId: { type: 'string', description: 'Provider ID to validate (e.g., groq, gemini)' },
          },
          required: ['providerId'],
        },
      },
      {
        name: 'code_mode',
        description:
          'Execute JavaScript code in a sandboxed environment against data. The DATA variable contains the input data as a string. Use print() to output results.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            code: { type: 'string', description: 'JavaScript code to execute. DATA variable contains input data.' },
            data: { type: 'string', description: 'Input data available as DATA variable' },
            command: { type: 'string', description: 'Description of what the code should do' },
            timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 5000)' },
          },
          required: ['code'],
        },
      },
      {
        name: 'manage_memory',
        description: 'Manage persistent memory for a specific workspace.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: { type: 'string', enum: ['search', 'list', 'stats', 'clear'], description: 'Memory operation' },
            workspace_root: { type: 'string', description: 'Space-aware root directory' },
            query: { type: 'string', description: 'Search term for memory retrieval' },
            limit: { type: 'number', description: 'Max results to return' },
          },
          required: ['action'],
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
