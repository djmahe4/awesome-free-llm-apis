# Skill Execution & Sandboxed Code Logic

The server provides a structured skill execution framework via the `execute_skill` tool and executes untrusted code safely using an internal QuickJS sandbox.

---

## 🛠️ Writing Custom Skills

Skills are structured directories placed under `.free-llm-mcp/skills/` (project-specific) or `C:\Users\<Username>\.gemini\config\skills\` (global).

### 📁 Skill Directory Structure
Each skill must have a `SKILL.md` file and optional supporting files:
```
.free-llm-mcp/skills/my-custom-skill/
├── SKILL.md                  # Main instructions and frontmatter
├── references/               # Technical references & docs
│   └── API.md
├── resources/                # Assets & templates
└── examples/                 # Code examples
```

### 📄 SKILL.md Format
The `SKILL.md` file uses YAML frontmatter and standard markdown:
```markdown
---
name: my-custom-skill
description: "Brief description of what this skill does."
---

# My Custom Skill Guide

Explain the core steps of the skill here. Reference any files in your skill directory:
- Refer to the API in [API.md](references/API.md).
```

When calling `execute_skill` with `"skill": "my-custom-skill"`, the engine will automatically parse these file references, load their contents, and inject them into the system prompt.

---

## ⚡ The `execute_skill` Tool

Execute a prompt grounded in a specific skill's instructions.

**Example Request:**
```json
{
  "skill": "my-custom-skill",
  "input": "Write a script to fetch data.",
  "workspace_root": "c:/Users/mahes/project"
}
```

**Workflow**:
1. **Security Gate**: Sanitizes the skill name to prevent path traversal (`..` is blocked).
2. **Skill Resolution**: Searches the local `.free-llm-mcp/skills/` and global config directories.
3. **Reference Parsing**: Extracts all relative file paths mentioned in `SKILL.md` (e.g. `references/`, `resources/`, `examples/`).
4. **Context Injection**: Reads and compiles the contents of `SKILL.md` and all resolved reference files.
5. **LLM Execution**: Invokes `use_free_llm` with the compiled skill instructions injected as a system prompt.

---

## 🛡️ Internal QuickJS Sandbox

While the user-facing `code_mode` tool is deprecated, the `AgenticMiddleware` internally utilizes a secure QuickJS sandbox to validate code, parse logs, or run algorithmic transformations during subtask execution.

### Sandbox Constraints
- **Isolation**: No access to `fs`, `net`, `os`, or `child_process`. It is a pure JavaScript execution context.
- **Timeout**: Hard limit of `5000ms` to prevent infinite loops.
- **Data Injection**: Inputs are injected as a global `DATA` string variable.
- **Output Capture**: Only output printed via the global `print()` function is captured and returned.

### Example Internal Sandbox Logic
```javascript
const data = JSON.parse(DATA);
const results = data.items.filter(item => item.score > 0.8);
print(JSON.stringify(results));
```
