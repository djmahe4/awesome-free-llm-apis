import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMCPServer } from './mcp/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getTokenStats } from './tools/get-token-stats.js';
import { listAvailableFreeModels } from './tools/list-models.js';
import { validateProvider } from './tools/validate-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const server = await createMCPServer();

  if (process.env.PORT || process.argv.includes('--sse')) {
    const app = express();
    const port = process.env.PORT || 3000;

    app.use(cors());
    app.use(express.json());

    // API endpoints for dashboard
    app.get('/api/token-stats', async (req, res) => {
      try {
        const stats = await getTokenStats();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get('/api/list-models', async (req, res) => {
      try {
        const models = await listAvailableFreeModels({});
        res.json(models);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post('/api/validate-provider', async (req, res) => {
      try {
        const { providerId } = req.body;
        const result = await validateProvider(providerId);
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    let transport: SSEServerTransport;

    app.get('/sse', async (req, res) => {
      transport = new SSEServerTransport('/messages', res);
      await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(404).end();
      }
    });

    // Serve dashboard static files
    const dashboardPath = path.join(__dirname, '../dashboard');
    app.use(express.static(dashboardPath));

    app.listen(port, () => {
      console.error(`MCP Dashboard & SSE Server running on http://localhost:${port}`);
      console.error(`SSE endpoint: http://localhost:${port}/sse`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP server running on stdio');
  }
}

main().catch(console.error);
