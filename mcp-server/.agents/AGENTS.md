# Agent Configuration — mcp-server

> Auto-initialized by free-llm-mcp on 2026-10-02.
> Updated: 2026-11-14 with master review, vibe code audit, and atomic PR workflow.

## Project Context
- **Type**: node / monorepo
- **Primary Language**: typescript (Node.js / ES2022)
- **Description**: Multi-provider MCP server integrating free LLM APIs, multi-agent harness, reverse engineering tools, cyber coach, memory wiki, and AST coding agents.

## Memory Preferences
- **Wiki Location**: .free-llm-mcp/wiki/
- **ADR Location**: .free-llm-mcp/wiki/adr/
- **Persona**: coder
- **Master Workspace Skill**: `.free-llm-mcp/skills/kilo-review-vibe-audit/SKILL.md`

## Master Review, Vibe Code Audit & PR Workflow

For all active development, PR review cycles, and release maintenance:

1. **Kilo Code Bot Review Triaging & Wait Loop**:
   - Inspect PR review feedback via `gh pr view <pr-num> --comments`.
   - Wait for bot review feedback before concluding work; never blind-merge or bypass review findings.
   - Categorize issues by severity: `CRITICAL` (blocks merge), `WARNING` (functional/performance/compat issues), and `SUGGESTION` (design/naming/optimizations).

2. **Vibe Code Audit & Root-Cause Remediation**:
   - Rather than applying surface-level patches, identify and solve the underlying architectural root cause:
     - **File Locking Concurrency (`file-lock.ts`)**: Never steal lock leases based solely on timeout if the holder PID is still running (`!isPidAlive(holderPid)`). Only reap dead/orphaned locks.
     - **Heavy Scans & Latency Bottlenecks (`cyber-tool.ts`, `indexer.ts`)**: Fast-path through pre-computed serialized graphs (`.free-llm-mcp/repo_graph.json`) instead of synchronous full-workspace traversals during tool execution; deduplicate in-flight indexing promises.
     - **Sub-Millisecond Clock Drift in Math Tests (`retention.test.ts`)**: Pin reference timestamps (`now = Date.now()`) to eliminate clock-skew flakes in tight tolerance assertions.
     - **Long Running Operations (`reverse-tool.ts`)**: Supply periodic heartbeat progress notifications (`RunRegistry.progress`) and bounded timeouts.
     - **Monkey Patching / API Traps (`api-trap.ts`)**: Short-circuit overrides for non-trapped modules to prevent unintended runtime side-effects.

3. **Atomic PRs & Direct Branch Workflows**:
   - Keep iterative fixes on the target release branch (e.g. `v1.1.3`) using atomic conventional commits instead of fragmenting into detached sub-branches.
   - When large feature sets or fixes accumulate, structure them into logical, single-responsibility commits.

4. **Rigorous Pre-Commit & Verification**:
   - Always run targeted Vitest test suites on modified files:
     `npm --prefix mcp-server test -- <test-paths>`
   - Run the pre-commit verification pipeline (`npm run verify:precommit`).
   - Push to remotes using `BypassSandbox: true` to satisfy network requirements.

## Token Budget
- **Max context per session**: 32000 tokens
- **Surgical reading**: enabled

## Skip Patterns (files to never index)
- node_modules/, .git/, dist/, build/
