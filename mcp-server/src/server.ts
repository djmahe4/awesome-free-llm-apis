#!/usr/bin/env node

/**
 * --- MCP Stdout Shield (Nuclear Hardening) ---
 * Any stray stdout will corrupt the JSON-RPC stream used by MCP.
 * We intercept all direct writes to stdout and redirect none-JSON content to stderr.
 */
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (chunk: any, encoding: any, callback: any) => {
  const str = typeof chunk === 'string' ? chunk : chunk.toString();
  // Valid JSON-RPC packets always start with '{'
  if (str.trim().startsWith('{')) {
    return originalStdoutWrite(chunk, encoding, callback);
  }
  // Redirect everything else (logs, ReferenceErrors, etc.) to stderr
  return process.stderr.write(chunk, encoding, callback);
};

// --- Global Safety Handlers (Immediate Preamble) ---
process.on('uncaughtException', (err) => {
  console.error(`[CRITICAL] Uncaught Exception: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[CRITICAL] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

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
import { execSync } from 'child_process';
import fs, { promises as fsp } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Validate system dependencies for code execution sandboxes
 */
async function validateSandboxDependencies() {
  console.error('[Startup] Validating sandbox dependencies...');

  // 1. Python Validation
  let pythonPath = 'python3';
  const projectRoot = path.resolve(__dirname, '../../');
  const venvPaths = [
    path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3'),
    path.join(projectRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3')
  ];

  for (const vp of venvPaths) {
    if (fs.existsSync(vp)) {
      pythonPath = vp;
      break;
    }
  }

  try {
    execSync(`${pythonPath} --version`, { stdio: 'ignore' });
    try {
      execSync(`${pythonPath} -c "import RestrictedPython"`, { stdio: 'ignore' });
      console.error(`  [✓] Python: ${pythonPath} and RestrictedPython available`);
    } catch {
      console.error(`  [!] Python: ${pythonPath} found but RestrictedPython missing. Run: ${pythonPath} -m pip install RestrictedPython`);
    }
  } catch {
    console.error('  [!] Python: python3 not found on PATH or in venv');
  }

  // 2. Go Validation
  const goRunnerPath = path.join(__dirname, '../../scripts/go-sandbox-runner/sandbox-runner');
  if (fs.existsSync(goRunnerPath)) {
    console.error('  [✓] Go: Pre-built sandbox-runner available');
  } else {
    try {
      execSync('go version', { stdio: 'ignore' });
      console.error('  [i] Go: Building sandbox-runner...');
      const goDir = path.join(__dirname, '../../scripts/go-sandbox-runner');
      execSync('go build -o sandbox-runner .', { cwd: goDir, stdio: 'ignore' });
      console.error('  [✓] Go: sandbox-runner built successfully');
    } catch {
      console.error('  [!] Go: sandbox-runner missing and go compiler not found');
    }
  }

  // 3. Rust Validation
  const rustRunnerPath = path.join(__dirname, '../../scripts/rust-sandbox-runner/target/release/sandbox-runner');
  if (fs.existsSync(rustRunnerPath)) {
    console.error('  [✓] Rust: Pre-built sandbox-runner available');
  } else {
    try {
      execSync('cargo --version', { stdio: 'ignore' });
      console.error('  [i] Rust: Building sandbox-runner...');
      const rustDir = path.join(__dirname, '../../scripts/rust-sandbox-runner');
      execSync('cargo build --release', { cwd: rustDir, stdio: 'ignore' });
      console.error('  [✓] Rust: sandbox-runner built successfully');
    } catch {
      console.error('  [!] Rust: sandbox-runner missing and cargo not found');
    }
  }
}

async function main() {
  try {
    await validateSandboxDependencies();
    const isSse = process.argv.includes('--sse');
    if (isSse) {
      const app = express();
      const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

      app.use(helmet({
        contentSecurityPolicy: {
          directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", "https://cdn.jsdelivr.net"],
            "style-src": ["'self'", "https://cdn.jsdelivr.net"],
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

      // Simple in-memory rate limiter for filesystem-backed routes (dashboard-only, local server)
      const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
      const RATE_LIMIT_WINDOW_MS = 60_000; // 1-minute window
      const RATE_LIMIT_MAX = 120;           // 2 requests/second burst over a minute

      function checkRateLimit(req: express.Request, res: express.Response): boolean {
        const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
          ?? req.socket.remoteAddress
          ?? 'unknown';
        const now = Date.now();
        let entry = rateLimitMap.get(ip);
        if (!entry || now >= entry.resetAt) {
          entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
          rateLimitMap.set(ip, entry);
        }
        entry.count++;
        if (entry.count > RATE_LIMIT_MAX) {
          res.status(429).json({ error: 'Too many requests' });
          return false;
        }
        return true;
      }

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

      // List all active agentic sessions (directories under data/projects/)
      app.get('/api/sessions', async (req, res) => {
        if (!checkRateLimit(req, res)) return;
        try {
          const projectsBase = path.join(process.cwd(), 'data', 'projects');
          if (!fs.existsSync(projectsBase)) {
            res.json({ sessions: [] });
            return;
          }
          const entries = await fsp.readdir(projectsBase);
          const sessions: string[] = [];
          
          for (const d of entries) {
            const full = path.resolve(projectsBase, d);
            // Guard: entry must be a *direct* child of projectsBase
            if (path.dirname(full) === projectsBase) {
              const stat = await fsp.stat(full);
              if (stat.isDirectory()) {
                sessions.push(d);
              }
            }
          }
          res.json({ sessions });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
      });

      // Return knowledge.md content and momentum queues for a given session
      app.get('/api/memory/:sessionId', async (req, res) => {
        if (!checkRateLimit(req, res)) return;
        try {
          const { sessionId } = req.params;
          // Step 1: Reject IDs with dots-only sequences or characters outside word/hyphen/dot
          if (!/^(?!\.\.?$)[\w\-\.]{1,128}$/.test(sessionId)) {
            res.status(400).json({ error: 'Invalid sessionId' });
            return;
          }
          // Step 2: Resolve and verify the resulting path is a direct child of data/projects/
          const projectsBase = path.join(process.cwd(), 'data', 'projects');
          const projectDir = path.resolve(projectsBase, sessionId);
          if (path.dirname(projectDir) !== projectsBase) {
            res.status(400).json({ error: 'Invalid sessionId' });
            return;
          }
          const knowledgePath = path.join(projectDir, 'knowledge.md');
          const queuesPath = path.join(projectDir, 'queues.json');

          let knowledge = 'No memory yet – session not started.';
          try {
            knowledge = await fsp.readFile(knowledgePath, 'utf-8');
          } catch {
            // file missing is expected if session hasn't written yet
          }

          let queues: Record<string, string[]> = {
            nowQueue: [], nextQueue: [], blockedQueue: [], improveQueue: []
          };
          try {
            const qData = await fsp.readFile(queuesPath, 'utf-8');
            queues = JSON.parse(qData);
          } catch (parseErr) {
            // expected if file missing
          }

          res.json({ sessionId, knowledge, queues });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
      });

      const sessionMap = new Map<string, { server: any, transport: StreamableHTTPServerTransport }>();

      const handleMcpRequest = async (req: express.Request, res: express.Response) => {
        // Support for dashboard status heartbeat
        if (req.method === 'GET' && req.query.heartbeat === 'true') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
          res.write('event: heartbeat\ndata: {"status":"online"}\n\n');
          const interval = setInterval(() => {
            res.write(': heartbeat\n\n'); // SSE comment to keep alive
          }, 15000);
          req.on('close', () => clearInterval(interval));
          return;
        }

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
  } catch (err: any) {
    console.error(`[FATAL] Startup failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
