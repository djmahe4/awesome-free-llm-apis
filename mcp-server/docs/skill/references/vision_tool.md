# `vision_tool`

**Purpose:** Analyze local images via a vision-capable model.

**Run params:** `image_path` (required for a new run)
**Key optional params:** `prompt`, `model`, `workspace_root`, `action`, `taskId`, `sessionId`

### Invocation
```json
{
  "image_path": "file:///c:/Users/mahes/project/assets/login_page.png",
  "prompt": "Analyze the UI layout of this login page.",
  "workspace_root": "/abs/path/to/project",
  "action": "run"
}
```

### Response and task controls
- Resolves the local path, converts the image to base64, and routes it to an available vision model (e.g., Gemini or Llama-3.2-Vision).
- A request that completes within 25 seconds returns `status: "completed"` with the analysis. Otherwise it returns `status: "running"`, a `taskId`, and progress. Poll with `{ "action": "status", "taskId": "..." }`.
- Use `{ "action": "continue", "taskId": "..." }` to retry a failed or timed-out task from its original inputs. Use `abort` to cancel a running task. Task state is in-memory and expires with the server process.
- Each run has a 60-second hard deadline shared by PDF rendering and provider fallback. The MCP call returns after at most 25 seconds with task status, while the tracked task can finish in the background. Failed responses include an error `code`, `message`, and `stage`; empty provider responses are not treated as success.
- For a PDF, use a `file:///.../document.pdf` URI; append `:<page>` to select a page. The result reports page number, total pages, whether text was extracted, whether a rendered page image was sent, and any warnings.
