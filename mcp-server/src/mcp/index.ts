import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { useFreeLLM } from '../tools/use-free-llm.js';
import { listAvailableFreeModels } from '../tools/list-models.js';
import { runCodeMode } from '../tools/code-mode.js';

export async function createMCPServer(): Promise<Server> {
  const server = new Server(
    { name: 'free-llm-apis', version: '1.0.0' },
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
