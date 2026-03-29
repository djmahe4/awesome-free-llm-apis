# Setup Guide

This guide covers the necessary steps to set up the MCP server and its provider dependencies.

## Prerequisites

- **Node.js** (v18 or higher)
- **Python 3** (v3.9 or higher)
- **npm** (comes with Node.js)

## Installation

### 1. Node.js Dependencies

Install the core server dependencies:

```bash
cd mcp-server
npm install
```

### 2. Python Environment (for Gemini)

The Google Gemini provider uses the official `google-genai` Python SDK via a bridge. You need to set up a virtual environment:

```bash
cd mcp-server
python3 -m venv venv

# For Linux/macOS:
source venv/bin/activate
# For Windows:
# venv\Scripts\activate

pip install -U google-genai python-dotenv
```

## Configuration

### Environment Variables

Create a `.env` file in the `mcp-server` directory (you can use `.env.example` as a template):

```bash
cp .env.example .env
```

Fill in your API keys for the providers you wish to use.

### API Keys

- **GEMINI_API_KEY**: Required for the Google Gemini provider.
- **CO_API_KEY**: Required for the Cohere provider (V2 SDK).
- **SILICONFLOW_API_KEY**: Required for SiliconFlow.
- (See `.env.example` for all supported providers).

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
# From the root of the cloned repository
mkdir -p ~/.gemini/antigravity/skills/free-llm-apis
cp -r mcp-server/docs/skill/* ~/.gemini/antigravity/skills/free-llm-apis/
cp mcp-server/docs/usages.md ~/.gemini/antigravity/skills/free-llm-apis/usages.md
```

Once copied, your agent will automatically detect the `@mcp:free-llm-apis` skill and its associated reference documents.

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
