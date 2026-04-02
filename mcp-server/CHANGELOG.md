# Changelog

## v1.0.1 - Router Optimization & Fallback Fix

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

## v1.0.0

- Added Agentic Middleware using external system prompt (`src/middleware/agentic/agentic-middleware.ts`)
- Introduced prompt loader reading from `external/agent-prompt/` with hardcoded fallback (`src/middleware/agentic/prompts.ts`)
- Added basic task decomposition, momentum queues (`now/next/blocked/improve`), and verification loop
- File-first state: `projects/{sessionId}/plan.md`, `tasks.md`, `knowledge.md`
- Feature-flagged via `ENABLE_AGENTIC_MIDDLEWARE` env var (transparent bypass when disabled)
- Updated README with Agent System Prompts & Architectures section and agentic middleware reference
- Updated `docs/guide.md` and `docs/skill/SKILL.md` with Agentic Middleware v2 documentation
