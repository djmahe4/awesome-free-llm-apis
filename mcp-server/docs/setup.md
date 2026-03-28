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
venv/bin/pip install -U google-genai python-dotenv
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

## Running Smoke Tests

To verify that your providers are correctly configured and reachable, run the smoke test:

```bash
cd mcp-server
npm run smoke-test
```
