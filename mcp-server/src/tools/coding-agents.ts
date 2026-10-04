/**
 * coding-agents.ts — OMP-style multi-file coding agent (v1.1.0)
 *
 * Pipeline (5 stages):
 *   1. Enumerate  — WorkspaceScanner lists all code files
 *   2. Locate     — VectorStore TF-IDF RAG picks topK relevant files
 *   3. Anchor     — SHA-256 content snapshot ([PATH#TAG] format)
 *   4. Edit       — AST structural rewrites + LLM generation (localLlmPatch)
 *   5. Verify     — OMP-style multi-language LSP dispatcher:
 *                   TS/JS → ts-morph getPreEmitDiagnostics (real pre-emit)
 *                   Python → python3 -c "import ast; ast.parse(...)" subprocess
 *                   Go    → go vet -json subprocess
 *                   Rust  → rustc --error-format json subprocess
 *
 * Research basis:
 *   - ts-morph: Context7 /dsherret/ts-morph — useInMemoryFileSystem, getPreEmitDiagnostics,
 *               DiagnosticCategory, getLineNumber, getMessageText, removeSourceFile
 *   - OMP: ast_edit uses ast-grep (structural AST rewrite, not regex);
 *          lsp action=diagnostics dispatches to real language servers
 *   - Multi-lang: Node.js child_process.spawnSync; go vet -json; rustc --error-format json;
 *                 python3 -c "import ast, sys; ast.parse(sys.stdin.read())"
 */

// The implementation was split out of this monolith into ./coding-agents/:
//   types          — shared interfaces + markdown formatting
//   rewrite        — ast-grep / regex structural rewrites
//   diff           — unified diff generation + workspace write guard
//   diagnostics    — multi-language validators (ts-morph / python / go / rust)
//   lsp-actions    — OMP-style LSP dispatcher
//   tasks          — goal decomposition + tasks.md (de)serialization
//   patch-gen      — search/replace patch generation (local + cloud LLM)
//   session-wiring — session ids, alias table, result cache, file wiring
//   pipeline       — CodingAgentsHandler entrypoint + 5-stage pipeline
//
// This facade re-exports the public API so existing importers
// ('../tools/coding-agents.js') keep working unchanged.

export * from './coding-agents/types.js';
export * from './coding-agents/rewrite.js';
export * from './coding-agents/diff.js';
export * from './coding-agents/diagnostics.js';
export * from './coding-agents/lsp-actions.js';
export * from './coding-agents/tasks.js';
export * from './coding-agents/patch-gen.js';
export * from './coding-agents/session-wiring.js';
export * from './coding-agents/pipeline.js';
