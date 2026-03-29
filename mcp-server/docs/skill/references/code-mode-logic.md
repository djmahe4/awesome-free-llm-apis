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

## 🛡️ Sandbox Limits
- **Timeout:** 5000ms.
- **Access:** No `fs`, `net`, or `os` modules.
- **Output:** Only `print()` captured via `stdout` is returned.

## 💡 Best Practices
- Pre-process large data in Python before passing to `code_mode` if complexity is O(n^2).
- Return minimal JSON to keep the `compressionRatio` efficient.
