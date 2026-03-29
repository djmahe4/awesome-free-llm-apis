import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMCPServer } from './mcp/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import helmet from 'helmet';
import crypto from 'crypto';
import { getTokenStats } from './tools/get-token-stats.js';
import { listAvailableFreeModels } from './tools/list-models.js';
import { validateProvider } from './tools/validate-provider.js';
import { flushSystem } from './tools/use-free-llm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  if (process.env.PORT || process.argv.includes('--sse')) {
    const app = express();
    const port = process.env.PORT || 3000;

    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          "img-src": ["'self'", "data:", "https:*"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));
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

    const sessionMap = new Map<string, { server: any, transport: StreamableHTTPServerTransport }>();

    const handleMcpRequest = async (req: express.Request, res: express.Response) => {
      const sessionId = (req.headers['mcp-session-id'] as string) || (req.query.sessionId as string);

      if (sessionId && sessionMap.has(sessionId)) {
        const { transport } = sessionMap.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // For new sessions (GET or POST initialize)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      const sessionServer = await createMCPServer();
      await sessionServer.connect(transport);

      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessionMap.set(transport.sessionId, { server: sessionServer, transport });

        // Cleanup on close
        transport.onclose = () => {
          if (transport.sessionId) {
            sessionMap.delete(transport.sessionId);
          }
        };
      }
    };

    app.all('/mcp', handleMcpRequest);

    // Backwards compatibility aliases
    app.get('/sse', handleMcpRequest);
    app.post('/messages', handleMcpRequest);

    // Serve dashboard static files
    const dashboardPath = path.join(__dirname, '../dashboard');
    app.use(express.static(dashboardPath));

    const serverInstance = app.listen(port, () => {
      console.error(`MCP Dashboard & SSE Server running on http://localhost:${port}`);
      console.error(`Unified endpoint: http://localhost:${port}/mcp`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.error('Shutting down server...');

      // Flush persistence
      try {
        flushSystem();
        console.error('Persistence flushed');
      } catch (err) {
        console.error('Failed to flush persistence:', err);
      }

      serverInstance.close(() => {
        console.error('Server closed');
        process.exit(0);
      });

      // Force exit after 5s
      setTimeout(() => process.exit(1), 5000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } else {
    const server = await createMCPServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP server running on stdio');
  }
}

main().catch(console.error);
