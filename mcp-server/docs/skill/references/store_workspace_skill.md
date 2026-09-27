# `store_workspace_skill`

**Purpose:** Create or register a custom helper skill, debugging utility, or reference script under the workspace customizations root.

**Required params:** `name`, `description`, `what`
**Key optional params:** `workspace_root`, `why`, `files`, `script_instructions`, `sessionId`, `pollAction`

### Invocation (no scripts — synchronous)
```json
{
  "name": "db-migration-helper",
  "description": "Database migration verification utility and rollback script wrapper.",
  "what": [
    "Added verify-migrations.sh script to validate DB schemas post-migration.",
    "Integrated schema diff checks before executing prisma migrate deploy."
  ],
  "why": "Prevent schema drift during rapid deployment cycles.",
  "files": ["scripts/verify-migrations.sh"],
  "workspace_root": "/abs/path/to/project"
}
```
Without `script_instructions`, the call is synchronous and writes only `SKILL.md`.

### Invocation with `script_instructions` — background generation

`script_instructions` (a map of filename → instruction) triggers one internal LLM call per script. Since that can chain several sequential LLM calls, generation runs **in the background**: the call returns immediately with `status:"running"`, and you poll with `pollAction:"status"`.

```jsonc
// kick off
{
  "name": "db-migration-helper",
  "description": "...",
  "what": ["..."],
  "workspace_root": "/abs/path/to/project",
  "script_instructions": {
    "verify_py": "Read a Prisma schema and diff it against the live DB schema, printing any drift."
  },
  "sessionId": "skill-gen-1"
}
// → { success: true, status: "running", sessionId: "skill-gen-1", message: "Started generating 1 script(s)..." }

// poll (same sessionId)
{ "name": "db-migration-helper", "description": "...", "what": ["..."], "workspace_root": "...", "sessionId": "skill-gen-1", "pollAction": "status" }
// → { success: true, status: "running", message: "Generating scripts: 0/1 (last: n/a)" }
// ... eventually ...
// → { success: true, message: "Successfully stored skill '...' with 1 generated scripts in ...", path: "...", scripts: ["verify.py"] }

// optional: cancel after the current script
{ "name": "db-migration-helper", "description": "...", "what": ["..."], "workspace_root": "...", "sessionId": "skill-gen-1", "pollAction": "abort" }
```
If `sessionId` is omitted it defaults to the derived skill slug (from `name`).
