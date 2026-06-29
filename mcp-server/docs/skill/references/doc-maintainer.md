# Documentation Maintainer: Context-Aware Best Practices

To make the free-llm memory pipeline perform optimally, developers must maintain high-quality docstrings and clear module structures. The memory pipeline's vector indexer relies on a **Semantic Profile Generator** that parses codebase files to construct contextual embeddings.

Follow these best practices to ensure maximum context awareness and prevent retrieval degradation.

---

## 💡 How the Profiler Extracts Context

The indexing engine constructs a file's semantic representation using three primary pillars:
1. **Module Purpose**: Extracted from the first block comment or top-level docstring in the file.
2. **Exports**: Names and signatures of public classes, interfaces, structs, functions, or contract interfaces.
3. **Dependencies**: Extracted internal and external module imports.

If these elements are messy or missing, the embedding model receives a "0 context awareness" code snippet, leading to poor semantic search results.

---

## 📝 Writing Effective Docstrings (By Language)

Always place a clear description at the very top of each file explaining the file's architectural role and high-level responsibilities.

### 1. JavaScript / TypeScript / Solidity / Java / C++ (`/** ... */`)
Use standard JSDoc block comments at the top of the file:
```typescript
/**
 * Coordinates memory storage between ShortTermMemory and LongTermMemory.
 * Acts as the main orchestrator for caching and retrieval.
 */
```

### 2. Python (`""" ... """`)
Use triple-quoted docstrings at the beginning of the file:
```python
"""
Provides a CLI dashboard for tracking API latencies and token usage.
Supports live SSE updates.
"""
```

### 3. Rust / Dart / Go (`/// ...` or `// ...`)
Use consecutive triple-slash or double-slash comment lines at the beginning of the file:
```rust
/// Handles ast parsing workflows.
/// Implements standard AST node extraction.
```
```go
// Package router defines the model routing matrix.
// Fallback logic and validation rules are configured here.
```

---

## 🏗️ Structure and Export Best Practices

- **Explicit Exports**: Keep exports structured and clean. The profiler parses lines like `export class X`, `pub struct Y`, `public class Z`, or `contract W`. Avoid dynamically exporting objects at the bottom of the file in complex ways, as this reduces export visibility in the index.
- **Grouped Imports**: Maintain clean import statements at the top of the file so the profiler can accurately map incoming and outgoing dependency edges.
- **Short & Focused Files**: Try to keep single files under 1,000 lines. The profiler caps the raw code snippet sent to the embedder at 2,000 characters (following the semantic profile header). Breaking files into logical modules makes the vector memory database much more precise.

---

## 🔄 Re-indexing Workspace

When you modify file structures, docstrings, or public exports:
1. Run `index_workspace` (MCP tool) to force-update the semantic vector memory index.
2. The indexer will incrementally update only the changed files by generating their new semantic profiles, keeping indexing fast and low-latency.

---

*For usage rules, see the main [Usage Guide](../SKILL.md).*
