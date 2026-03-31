# Changelog

## v2.0

- Added Agentic Middleware using external system prompt (`src/middleware/agentic/agentic-middleware.ts`)
- Introduced prompt loader reading from `external/agent-prompt/` with hardcoded fallback (`src/middleware/agentic/prompts.ts`)
- Added basic task decomposition, momentum queues (`now/next/blocked/improve`), and verification loop
- File-first state: `projects/{sessionId}/plan.md`, `tasks.md`, `knowledge.md`
- Feature-flagged via `ENABLE_AGENTIC_MIDDLEWARE` env var (transparent bypass when disabled)
- Updated README with Agent System Prompts & Architectures section and agentic middleware reference
- Updated `docs/guide.md` and `docs/skill/SKILL.md` with Agentic Middleware v2 documentation
