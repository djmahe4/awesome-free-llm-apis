# Changelog

## v1.1.0 — Multi-Language Code Mode & Agent-First Refactor

**Released:** 2026-04-02

### 🚀 Highlights
- `code_mode` now supports **four sandbox runtimes**: JavaScript (QuickJS), Python (RestrictedPython), Go (goja), Rust (boa_engine)
- All six public tool descriptions **deeply enriched** with user stories, schemas, failure states, and concrete examples
- **Research validation logging** added to `AgenticMiddleware` — explicit audit trail for every detected external-knowledge request
- **New `mcp-server/README.md`** — Mermaid architecture diagram, full tool table, client configs, extension points
- All documentation synced: `guide.md`, `SKILL.md`, `usages.md`, `mcp-development.md`

---

### ✨ New Features

#### `code_mode` — Multi-Language Sandbox Support
- Added `language` parameter to `code_mode` tool: `"javascript"` | `"python"` | `"go"` | `"rust"`
- **JavaScript** (default): QuickJS via `quickjs-emscripten` — fully in-process, no subprocess overhead
- **Python**: New `scripts/python-sandbox-runner.py` using [RestrictedPython](https://restrictedpython.readthedocs.io/)
  - Blocks filesystem (`os`, `pathlib`, `io`, `shutil`, …), network (`socket`, `http`, `urllib`, …), and process (`subprocess`, `multiprocessing`, …) modules
  - Falls back to manual builtins restriction if RestrictedPython is not installed
  - `DATA` injected via `SANDBOX_DATA` environment variable
- **Go**: New `scripts/go-sandbox-runner/` — pure-Go ECMAScript engine via [goja](https://github.com/dop251/goja)
  - Executes JavaScript scripts in a Go subprocess
  - Timeout enforced via goroutine interrupt; `DATA`, `print()`, `console.log/error` all available
  - Build: `cd scripts/go-sandbox-runner && go build -o sandbox-runner .`
- **Rust**: New `scripts/rust-sandbox-runner/` — pure-Rust ECMAScript engine via [boa_engine](https://github.com/boa-dev/boa)
  - Executes JavaScript scripts in a Rust subprocess
  - Thread-local stdout/stderr capture; `DATA`, `print()`, `console.log/error` all available
  - Build: `cd scripts/rust-sandbox-runner && cargo build --release`

**Sandbox contract (all languages):**
```
INPUT:  code via stdin | DATA via SANDBOX_DATA env var
OUTPUT: print() / console.log() → stdout only
BLOCKS: filesystem, network, process/OS calls
```

#### Research Validation Logging in AgenticMiddleware
- `detectResearchIntent(content)` — regex-based detection of external-knowledge requests in user messages
- `logResearchValidation(sessionId, content, step)` — logs `[RESEARCH-VALIDATION]` entries with timestamp, session, and query preview
- Pre-execution log: fires when research intent is detected before the LLM call
- Post-execution log: fires after response to confirm grounding
- `verifySelf()` failures now also logged with `[VERIFY]` level warning

#### New `mcp-server/README.md`
- **Mermaid architecture diagram** of the full pipeline (Cache → AgenticMiddleware → Router → LLMExecutor)
- **Six-tool reference table** with required params and sample invocations
- **Middleware dataflow** prose explanation with best practices for agent/Copilot authors
- **"Add a provider in <20 lines"** walkthrough
- **Client configs** for Claude Desktop, Cursor, and Windsurf
- **Extension points** table: ReAct, Plan-and-Execute, Lite Mode, Cached-only strategies

---

### 🔧 Improvements

#### Tool Descriptions (`src/mcp/index.ts`)
All six tool descriptions have been rewritten to be self-documenting for agents:
- **User stories** — clear statement of when and why to use each tool
- **Input/output schemas** — explicit field-by-field documentation
- **Failure states** — what errors mean and how to recover
- **Concrete examples** — inline invocation examples in the description

#### Updated Benchmarks (`benchmarks/code-mode.bench.ts`)
Five realistic compression scenarios added:
1. **Chat Completions** — extract first message from 50-choice response (~95% savings)
2. **Model List** — extract names + availability from 62 models (~90% savings)
3. **Token Stats** — extract name + usage from 15 providers (~85% savings)
4. **Embeddings** — compute summary stats from 1536-dim vector (~99% savings)
5. **Search Results** — extract top-5 titles/URLs from 20 results (~92% savings)

Run: `npx vitest bench benchmarks/code-mode.bench.ts`

---

### 📚 Documentation Updates

| File | Changes |
|------|---------|
| `README.md` *(new)* | Full architecture overview, Mermaid diagram, tool table, client configs |
| `docs/guide.md` | Updated §4 (MCP Tools) with multi-language code_mode table and agent rules |
| `docs/mcp-development.md` | Expanded sandbox section: all 4 languages, Python allowlist, extension guide |
| `docs/skill/SKILL.md` | Updated `code_mode` reference with language table and `compressionRatio` note |
| `docs/skill/references/usages.md` | TC-05 rewritten with JS/Python examples and parameter table; TC-06 expanded with all four `manage_memory` actions; tool overview table updated |

---

### 🗂️ New Files

```
mcp-server/
├── README.md                                     ← new: agent-focused README
├── scripts/
│   ├── python-sandbox-runner.py                  ← new: RestrictedPython runner
│   ├── go-sandbox-runner/
│   │   ├── main.go                               ← new: goja-based JS sandbox
│   │   ├── go.mod                                ← new
│   │   └── go.sum                                ← new
│   └── rust-sandbox-runner/
│       ├── src/main.rs                           ← new: boa_engine JS sandbox
│       └── Cargo.toml                            ← new
```

---

### ⚠️ Breaking Changes
- None. The `language` parameter defaults to `"javascript"`, preserving full backward compatibility.
- Existing `code_mode` calls without `language` continue to work exactly as before.

---

### 🔨 Build Requirements for New Sandboxes

| Language | Requirement | Install |
|----------|------------|---------|
| `javascript` | none (bundled) | — |
| `python` | Python 3.x on PATH | `pip install RestrictedPython` |
| `go` | Go 1.21+, pre-built binary | `cd scripts/go-sandbox-runner && go build -o sandbox-runner .` |
| `rust` | Rust + Cargo, pre-built binary | `cd scripts/rust-sandbox-runner && cargo build --release` |

---



### 🔧 Critical Bug Fixes
- **Fixed multiple next() calls breaking fallback architecture**
  - Resolved issue where router called `next()` multiple times in fallback loop
  - Previously caused `"next() called multiple times"` error on second fallback attempt
  - Router now uses `LLMExecutor` utility to try providers without violating middleware contract
  - Calls `next()` only once after successful provider selection
- **Fixed token replenishment logic**
  - `hasEnoughTokens()` now checks if rate limit reset time has elapsed
  - Prevents indefinite blocking when provider tokens reach zero
  - Automatically clears tracking state when tokens refresh
- **Improved type safety**
  - Header parameter now uses `Record<string, string | string[] | undefined>` instead of `any`
  - Better IDE support and runtime safety for header access

### ✨ Router Enhancements
- **Comprehensive model coverage**: Now utilizes all 79 models across 15 providers (previously 39 models, 10 providers)
- **Free-first routing**: Prioritizes FREE models (OpenRouter `:free`, GitHub Models, Cloudflare)
- **Provider utilization**: 100% of available providers now utilized (was 67%)
- **Real-world tested**: Routing order optimized based on actual API response times and reliability
- **Cloudflare prioritized**: Moved Cloudflare models to first position (100% success rate, 1307ms avg)
- **Added flush() method**: Router now exposes `flush()` to clear token tracking state

### 🏗️ Architecture Changes
- **Added `LLMExecutor` utility class** (`src/utils/LLMExecutor.ts`)
  - Extracts token management and LLM execution logic
  - Enables multiple provider attempts without calling `next()` multiple times
  - Maintains token tracking and drift correction with proper refresh handling
- **Simplified pipeline**: Removed TokenManager and LLMExecution from pipeline (now handled by Router internally)
- **Pipeline order**: `ResponseCache → Agentic → Router` (previously had 5 middlewares)
- **Removed dead code**: Cleaned up unused `sharedTokenManager`, `LLMExecutionMiddleware` file, imports, and tests
- **Fixed token stats**: `get-token-stats.ts` now reads from router's actual token state

### 🧪 Testing Improvements
- Added comprehensive router fallback tests (`tests/router-fallback.test.ts`)
- Created routing efficiency evaluation script (`scripts/evaluate-routing.ts`)
- Tests verify single `next()` call, fallback cascade, and provider coverage
- All tests pass after PR review fixes

### 🗑️ Removed Invalid Models
- Removed `nvidia/nemotron-nano-9b-v2:free` (timeouts)
- Removed `nvidia/nemotron-3-super:free` (404)
- Removed `nvidia/nemotron-3-nano-30b-a3b:free` (404)
- Removed `minimax/minimax-m2.5:free` (guardrails)
- Added correct model: `nvidia/nemotron-mini-4b-instruct:free`

### 📊 Performance Metrics (Real-World Testing)
- Success rate: 75% → Expected 95%+ after fixes
- Free model usage: 83% of successful requests
- Average response time: 1942ms
- Cloudflare: 100% success, 1307ms avg
- OpenRouter: 60% success, 13304ms avg (due to timeouts on removed models)

## TODOs

- refer https://github.com/copilot/share/08311092-4b20-8c00-a053-e402444e6817
- reversion to 1.0.3
- Validate dependencies during server start for code mode
  - python	RestrictedPython	Python	python3 on PATH; pip install RestrictedPython
  - go	goja (pure-Go ECMAScript)	JavaScript	Pre-built binary: cd scripts/go-sandbox-runner && go build -o sandbox-runner .
  - rust	boa_engine (pure-Rust ECMAScript)	JavaScript	Pre-built binary: cd scripts/rust-sandbox-runner && cargo build --release

## v1.0.0

- Added Agentic Middleware using external system prompt (`src/middleware/agentic/agentic-middleware.ts`)
- Introduced prompt loader reading from `external/agent-prompt/` with hardcoded fallback (`src/middleware/agentic/prompts.ts`)
- Added basic task decomposition, momentum queues (`now/next/blocked/improve`), and verification loop
- File-first state: `projects/{sessionId}/plan.md`, `tasks.md`, `knowledge.md`
- Feature-flagged via `ENABLE_AGENTIC_MIDDLEWARE` env var (transparent bypass when disabled)
- Updated README with Agent System Prompts & Architectures section and agentic middleware reference
- Updated `docs/guide.md` and `docs/skill/SKILL.md` with Agentic Middleware v2 documentation
