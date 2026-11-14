# Rules and Guidelines for Gemini Sessions on this Repository

These rules apply to all Gemini / Antigravity sessions and subagents operating on this repository.

## Master Agent Configuration & Workflows

For project context, Kilo code bot review feedback loops, vibe code audits, root-cause resolution, and atomic commit/PR practices, see:
- @mcp-server/.agents/AGENTS.md

## Master Workflow Summary

1. **Kilo Code Bot Review Wait Loop**: Check PR review comments (`gh pr view <pr-num> --comments`) and resolve all `CRITICAL`, `WARNING`, and `SUGGESTION` findings before finalizing merges.
2. **Vibe Code Audits & Root-Cause Remediation**: Fix underlying architectural issues (e.g. check PID liveness before reaping file locks, pre-load pre-computed repo graph to avoid synchronous tree scans, pin timestamps in precision math tests).
3. **Atomic PRs & Branch Workflows**: Work directly on target branches (e.g. `v1.1.3`) using clean conventional commits rather than fragmented sub-branches.
4. **Verification**: Always run targeted Vitest tests and pre-commit checks (`npm run verify:precommit`) before pushing with `BypassSandbox: true`.
