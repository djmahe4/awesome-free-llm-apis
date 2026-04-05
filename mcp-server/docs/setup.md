# Setup Guide

This guide covers the necessary steps to set up the MCP server and its provider dependencies.

## Prerequisites

- **Node.js** (v18 or higher)
- **Python 3** (v3.9 or higher)
- **npm** (comes with Node.js)

## Installation

### 1. Node.js Dependencies & Cross-Platform Sync

Install the core server dependencies:

```bash
cd mcp-server
npm install
```

> **Note:** This project uses `quickjs-emscripten`, which requires platform-specific dependencies (like `@emnapi/core` and `@emnapi/runtime`) to be present in the `package-lock.json` for CI/CD runners (like Linux). To ensure these are always included in the lock file regardless of your development OS (Windows/macOS), they are tracked in `devDependencies`. If you see `npm ci` failures in CI, please run `npm install` locally to refresh the lock file.

### 2. Python Environment (for Gemini)

The Google Gemini provider uses the official `google-genai` Python SDK via a bridge. You need to set up a virtual environment:

```bash
cd mcp-server

# Create the virtual environment
python -m venv venv

# Activate it:
#   Linux / macOS ......  source venv/bin/activate
#   Windows (PowerShell)  .\venv\Scripts\Activate.ps1
#   Windows (cmd) .......  venv\Scripts\activate.bat

pip install -U google-genai python-dotenv
```
### 3. Sandbox Requirements (for `code_mode`)

The `code_mode` tool provides isolated script execution. Some runtimes require manual setup:

#### Python Sandbox
Mandatory for `language: "python"`. It is highly recommended to use a virtual environment.
```bash
# Within your active venv:
pip install RestrictedPython
```

#### Go Sandbox
Requires a pre-built binary for JS execution via `goja`.
```bash
cd scripts/go-sandbox-runner
go build -o sandbox-runner .
```

#### Rust Sandbox
Requires a pre-built binary for JS execution via `boa_engine`.
```bash
cd scripts/rust-sandbox-runner
cargo build --release
```

> [!NOTE] 
> The Node.js executor automatically detects these binaries if they are built in their respective directories. Python execution requires `python3` to be available on your system path with `RestrictedPython` installed in the environment used to run the server.

## Configuration

### Environment Variables

Create a `.env` file in the `mcp-server` directory (you can use `.env.example` as a template):

```bash
# Linux / macOS
cp .env.example .env

# Windows (PowerShell)
Copy-Item .env.example .env
```

Fill in your API keys for the providers you wish to use.

### API Keys

- **GEMINI_API_KEY**: Required for the Google Gemini provider.
- **CO_API_KEY**: Required for the Cohere provider (V2 SDK).
- **SILICONFLOW_API_KEY**: Required for SiliconFlow.
- (See `.env.example` for all supported providers).

### Feature Flags

- **ENABLE_AGENTIC_MIDDLEWARE**: Set to `true` to enable the agentic middleware globally for all requests. 
- **AGENT_PROMPT_PATH**: Path to the directory containing `prompt.json` and `README.md` (default: `../external/agent-prompt`).
    > [!IMPORTANT]
    > **Session IDs**: When this flag is enabled, every request **must** include a `sessionId` (either in the context or the request body). Requests without a `sessionId` will bypass the middleware to ensure data safety.

## Running the Server

Start the MCP server in development mode:

```bash
cd mcp-server
npm run dev
```

Then visit `http://localhost:3000` to view the visual dashboard for provider health and token tracking.

## MCP Client Configuration

To use this server with an MCP-compatible LLM client (like Claude Desktop), add the following to your configuration file:

### Option A: Running with `dist` (After `npm run build`)

```json
{
  "mcpServers": {
    "free-llm-apis": {
      "command": "node",
      "args": [
        "--env-file=</path/to/awesome-free-llm-apis>/mcp-server/.env",
        "</path/to/awesome-free-llm-apis>/mcp-server/dist/server.js"
      ]
    }
  }
}
```

### Option B: Running with `tsx` (Development)

```json
{
  "mcpServers": {
    "free-llm-apis": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "--env-file=</path/to/awesome-free-llm-apis>/mcp-server/.env",
        "</path/to/awesome-free-llm-apis>/mcp-server/src/server.ts"
      ]
    }
  }
}
```

### Option C: Remote Connection (Streamable HTTP)

If the server is running with the `--sse` flag, any MCP client can connect via the unified HTTP endpoint:

**URL**: `http://localhost:3000/mcp`

This is the preferred method for connecting browser-based clients or remote instances.

### Option D: Running with `npx` (Streamlined)

If you have the repository cloned locally, you can run the server directly using `npx`:

```json
{
  "mcpServers": {
    "free-llm-apis": {
      "command": "npx",
      "args": [
        "-y",
        "/path/to/awesome-free-llm-apis/mcp-server"
      ],
      "env": {
        "GEMINI_API_KEY": "your_key",
        "CO_API_KEY": "your_key"
      }
    }
  }
}
```

*Note: This method is ideal for quick testing as it uses the `bin` configuration defined in `package.json`.*

## Installing the AI Agent Skill

This repository includes a specialized skill for AI coding agents (like Claude Code / Antigravity) to properly use the `free-llm-apis` tools, handle fallback routing, and manage persistent memory.

To install the skill so your AI agent can use it:

```bash
# Linux / macOS
mkdir -p ~/.gemini/antigravity/skills/free-llms
cp -r mcp-server/docs/skill/* ~/.gemini/antigravity/skills/free-llms/
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gemini\antigravity\skills\free-llms\"
Copy-Item -Recurse mcp-server\docs\skill\* "$env:USERPROFILE\.gemini\antigravity\skills\free-llms\"
```

Once copied, your agent will automatically detect the `@free-llms` skill and its associated reference documents for calling the `@mcp:free-llm-apis` tools. Just call the skill in prompts like:

```
@free-llms Hey help me orchestrate a workflow to extract the top 10 most starred repositories from GitHub and save them to a CSV file.
```

## Running Smoke Tests

```bash
cd mcp-server
npm run smoke-test
```

## Orchestration Pipeline

The server uses a pipeline for model selection and token management. For a deep dive into how routing, caching, and failover work, see the [Architecture & Workflow Guide](guide.md).

### Performance Features
- **Token Interpolation**: Uses `js-tiktoken` for local token counting.
- **Header Synchronization**: Automatically adjusts quotas based on `x-ratelimit-*` response headers.
- **Tiered Fallbacks**: Dynamically switches models based on task type (Coding, Chat, etc.).
