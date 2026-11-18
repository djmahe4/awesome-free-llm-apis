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

## Documentation Maintenance & Code-to-Docs Alignment

To ensure continuous maintainability and prevent documentation drift across active development:

1. **Code-to-Docs Schema Map (`.free-llm-mcp/docs-schema.yaml`)**:
   - Every core tool and subsystem module must map to a dedicated reference doc under `mcp-server/docs/skill/references/`.
   - Never remove or orphan existing mappings. All additions to `src/tools/` or `src/memory/` must register their matching documentation.

2. **Architectural Visualization Guarantee**:
   - Subsystem, workflow, and protocol documentation must include syntactically valid Mermaid diagrams.
   - Use explicit diagram orientations (`flowchart TD`, `sequenceDiagram`, `stateDiagram-v2`). Never use bare `flowchart` without orientation, and never append trailing semicolons.

3. **Skill Navigation Layer & Token Footprint**:
   - `SKILL.md` must serve strictly as a concise navigation layer (target budget ≤ 250 lines, ~1,200 tokens).
   - Use Progressive Disclosure navigation tables (`| Task / Tool | Reference Path | When to Read |`) pointing to `references/` instead of duplicating inline parameter schemas.
   - Guard against unstructured reference dumping at the bottom of markdown files.

4. **Required Contract Headings in Agent Skills**:
   - All agent skills must maintain mandatory sections: `## When to Use`, `## Limitations`, and `## Output format contract`.

5. **Non-Failing Workspace Lock Enforcement**:
   - When introducing unextracted workspace context, tools pause gracefully rather than throwing exceptions.
   - Confirm and clear locks via `manage_memory` with `action: 'resolve_workspace_lock'`.

6. **Pre-Commit Quality & Audit Checks**:
   - Execute `manage_memory` with `action: 'audit_documentation'` and `audit_file` with `hypothesize: true` to catch missing contracts and diagrams.

## Token Budget
- **Max context per session**: 32000 tokens
- **Surgical reading**: enabled

## Skip Patterns (files to never index)
- node_modules/, .git/, dist/, build/

## Safe Practices


### TypeScript / JavaScript Safe Practices
- **Linting & Formatting**: Follow ESLint with `@typescript-eslint`, Prettier, and `eslint-plugin-jsdoc`.
- **Comment Contracts**: Exported and public functions require written contracts (`@contract`, `@pre`, `@post`, `@throws`, `@returns`).
- **File Headers**: New source files must contain a top-level descriptive file header.
- **Hygiene**: No commented-out code; no unowned `TODO` or `FIXME` comments in production code.

### General Engineering Guidelines
- **Verification**: Run local pre-commit checks (`npm run verify:precommit` or relevant test suites) before committing.
- **Atomic Commits**: Commit changes with conventional commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`).
- **Graph & Contract Fidelity**: Avoid changing exported signatures without reviewing dependent nodes in `DiskSymbolDb`.
