# Code Mode Execution — `free-llm-apis`

The `code_mode` tool enables sandboxed JavaScript execution against a `DATA` string variable.

## 🧪 Implementation Patterns

### 1. Data Processing
Inject JSON strings into `DATA` and use `JSON.parse()`:
```javascript
const list = JSON.parse(DATA);
const result = list.filter(item => item.active);
print(JSON.stringify(result));
```

### 2. Algorithmic Transformation
Use for tasks poorly suited for LLMs (e.g., precise sorting, statistical reductions):
- **Sorting:** Use `Array.prototype.sort()` for O(n log n) efficiency.
- **Reductions:** Use `Array.prototype.reduce()` for single-pass statistics.

### 3. Agentic Prompt Compression [NEW]
Compress large research findings before storing in memory or returning to the user:
```javascript
const data = JSON.parse(DATA);
const summary = data.map(item => ({
  id: item.id,
  summary: item.text.substring(0, 100) + '...',
  tags: [...new Set(item.keywords.split(','))]
}));
print(JSON.stringify(summary));
```

### 4. Semantic Deduplication [NEW]
Remove overlapping findings between iterative subagent calls:
```javascript
const sessions = JSON.parse(DATA); // Array of previous session results
const uniqueFindings = {};
sessions.forEach(session => {
  session.findings.forEach(f => {
    if (!uniqueFindings[f.id]) uniqueFindings[f.id] = f;
  });
});
print(JSON.stringify(Object.values(uniqueFindings)));
```

### 🎯 Keyword Steering [NEW]
The Intelligent Router uses keyword-based task classification to optimize prompt routing. When building logic, include relevant keywords in the task description or output to signal the router:
- **`api`**: Triggers enhanced header extraction and rate-limit tracking.
- **`memory`**: Prioritizes `manage_memory` search and usage logs.
- **`sql` / `json`**: Optimizes the parser for structured data extraction.
- **`system`**: Forces high-precision model selection for architectural tasks.

---

## 🛡️ Sandbox Limits
- **Timeout**: 5000ms.
- **Access**: No `fs`, `net`, or `os` modules.
- **Output**: Only `print()` captured via `stdout` is returned.

## 💡 Best Practices
- **Token Optimization**: Use `code_mode` to flatten deeply nested JSON before it reaches the LLM context.
- **Deduplication**: Always deduplicate repetitive research hits to keep the `compressionRatio` low.
- **JSON Safety**: Wrap `print()` output in `JSON.stringify()` to ensure correct parsing.

---

## Agentic Use Case: "The Chain of Logic"
When a task requires multiple mathematical or logical steps (e.g., calculating cumulative ROI across 100 scenarios), do **not** let the LLM do the math. 
1. **Generate**: Use `use_free_llm` to produce the raw data components.
2. **Execute**: Use `code_mode` to perform the precise logic.
3. **Store**: Use `manage_memory` to persist the final validated result.
