# `load_skill_prompt`

**Purpose:** Search, list, or fetch dynamic skill prompts from local skill manifests, the remote agentic-awesome index, or bundled Hermes skills.

**Required params:** `type` (`'search' | 'load' | 'list'`)
**Key optional params:** `name` (required for `'load'`), `keywords`, `source` (`'agentic-awesome' | 'hermes'`), `workspaceDir`, `sessionId`, `pollAction` (`'run' | 'status'`)

---

### Invocation Examples

#### 1. Search Skills by Keywords
```json
{
  "type": "search",
  "keywords": ["debug", "auth", "jwt"]
}
```

#### 2. Search Skills by Prompt Text (Auto-Keyword Extraction)
If `keywords` is omitted or empty, `load_skill_prompt` automatically derives keywords from the prompt string passed in `name` (`name.split(/\s+/)`):
```json
{
  "type": "search",
  "name": "refactor functional taskeither auth pipeline"
}
```

#### 3. Load Specific Skill System Prompt (bundled Hermes — synchronous)
```json
{
  "type": "load",
  "name": "ab-test-setup",
  "source": "hermes"
}
```
Bundled Hermes skills are on-disk and load synchronously — no polling needed.

#### 4. Load an agentic-awesome Skill (remote, background download)
A remote skill can have many files, downloaded sequentially over the network, so `type:"load"` with `source:"agentic-awesome"` (or the Hermes-not-found fallback) runs **in the background**:
```jsonc
// kick off
{ "type": "load", "name": "some-multi-file-skill", "source": "agentic-awesome", "sessionId": "load-1" }
// → { success: true, status: "running", sessionId: "load-1", message: "Started downloading skill '...' ..." }

// poll (same sessionId)
{ "type": "load", "name": "some-multi-file-skill", "sessionId": "load-1", "pollAction": "status" }
// → { success: true, status: "running", message: "Downloading skill files: 3/7 (last: scripts/setup.sh)" }
// ... eventually ...
// → { success: true, filePath: "...SKILL.md", skill: "...", description: "...", prompt: "..." }
```
If `sessionId` is omitted it defaults to `name`.

---

### 🛡️ Context Bloat Guard & Hermes Fallback

- **Empty Keywords Guard**: Passing explicit `keywords: []` returns `{ success: true, skills: [] }` with **0 tokens bloat**, preventing uncalibrated prompt expansion.
- **Bundled Hermes Fallback**: When searching local workspace or online skill indices returns no matches, `load_skill_prompt` automatically falls back to `searchHermesSkills(keywords)` across all 36 bundled Hermes skills (`external/hermes/`).
- **Adapter Note**: Loaded Hermes skills inject a 101-token environment override note instructing the model to use the server's native tools (`manage_memory`, `browser_tool`) instead of raw filesystem operations.
