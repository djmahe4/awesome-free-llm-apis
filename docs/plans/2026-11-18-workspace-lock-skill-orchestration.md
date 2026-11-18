# Workspace Lock & Skill Orchestration Implementation Plan

> **For Claude / Antigravity:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a non-blocking workspace lock mechanism on workspace initialization that gates full memory operations until a new `manage_memory` subtool (`resolve_workspace_lock`) analyzes baseline documentation schematics (public vs dev SDLC audience), preloads `skill-writer` across workspace folders, and orchestrates skill/doc drift checks using deterministic semantic rule matching with graceful local-model checking and cloud-fallback reminders.

**Architecture:**
- Add `WorkspaceLockManager` in `mcp-server/src/memory/workspace-lock.ts` with file-backed persistence (`.free-llm-mcp/workspace.lock`) and preloading of `skill-writer` into workspace skill directories.
- Integrate workspace lock creation into `initWorkspace()` in `mcp-server/src/tools/init-workspace.ts`.
- Expand `mcp-server/src/memory/mermaid-classifier.ts` with `classifyDocAudience()` (Public vs Dev) and `generateDocSchematic()` that operates deterministically without requiring an LLM.
- Add `action: 'resolve_workspace_lock'` to `manage_memory` in `mcp-server/src/tools/manage-memory.ts` and `mcp-server/src/mcp/index.ts`.
- Support **dual-mode skill & doc evaluation**:
  1. *Deterministic Semantic Matcher*: Structural rule matching against `skill-writer` specification (frontmatter, triggers, sections, output contracts) and Mermaid templates when local models are absent or busy (`LocalModelLock` engaged).
  2. *Opt-in LLM Remediation*: When the user requests LLM-assisted generation/remediation, check local model availability. If absent or busy, remind the user to re-invoke with `allowCloudFallback: true` rather than forcing execution or blocking.
- Format all middleware alerts into compact (<300 char) markdown pills.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest, Mermaid Classifier, LocalModelLock, MCP Protocol.

---

### Task 1: Document Audience Classifier & Semantic Schematic Generator

**Files:**
- Modify: `mcp-server/src/memory/mermaid-classifier.ts`
- Test: `mcp-server/tests/doc-audience-classifier.test.ts`

**Step 1: Write the failing test**
Create `mcp-server/tests/doc-audience-classifier.test.ts` verifying:
1. `classifyDocAudience('README.md', 'getting started and user flow')` returns `'public'` with recommended diagrams `['flowchart', 'journey', 'C4Context']`.
2. `classifyDocAudience('mcp-development.md', 'ipc protocols and state machine')` returns `'dev'` with recommended diagrams `['sequenceDiagram', 'classDiagram', 'stateDiagram-v2']`.
3. `generateDocSchematic(filePath, content)` produces a compact schematic object with audience, detected diagrams, missing diagrams, and a 1-line summary without calling any LLM.

**Step 2: Run test to verify it fails**
Run: `npm test tests/doc-audience-classifier.test.ts` (in `mcp-server/`)
Expected: FAIL with functions not defined.

**Step 3: Implement minimal code**
In `mcp-server/src/memory/mermaid-classifier.ts`:
- Export `classifyDocAudience(filePath: string, content: string): { audience: 'public' | 'dev'; recommendedDiagrams: string[]; rationale: string }`
- Export `generateDocSchematic(filePath: string, content: string): DocSchematic`

**Step 4: Run test to verify it passes**
Run: `npm test tests/doc-audience-classifier.test.ts` (in `mcp-server/`)
Expected: PASS

**Step 5: Commit**
```bash
git add mcp-server/src/memory/mermaid-classifier.ts mcp-server/tests/doc-audience-classifier.test.ts
git commit -m "feat(memory): add doc audience classification and schematic generator"
```

---

### Task 2: WorkspaceLockManager & Preloading `skill-writer`

**Files:**
- Create: `mcp-server/src/memory/workspace-lock.ts`
- Test: `mcp-server/tests/workspace-lock.test.ts`

**Step 1: Write the failing test**
Create `mcp-server/tests/workspace-lock.test.ts` verifying:
1. `WorkspaceLockManager.acquireLock(workspaceRoot)` creates `.free-llm-mcp/workspace.lock` with `locked: true`.
2. `WorkspaceLockManager.isLocked(workspaceRoot)` returns `true` when file exists, `false` otherwise.
3. `WorkspaceLockManager.preloadSkillWriter(workspaceRoot)` ensures `skill-writer/SKILL.md` and reference files exist in `.free-llm-mcp/skills/skill-writer/`.
4. `WorkspaceLockManager.resolveLock(workspaceRoot, resolutionData)` marks `locked: false` and saves resolution schematics.

**Step 2: Run test to verify it fails**
Run: `npm test tests/workspace-lock.test.ts` (in `mcp-server/`)
Expected: FAIL with module not found.

**Step 3: Implement minimal code**
In `mcp-server/src/memory/workspace-lock.ts`:
- Implement `WorkspaceLockState` interface.
- Implement `WorkspaceLockManager` class with atomic file operations and `preloadSkillWriter()`.

**Step 4: Run test to verify it passes**
Run: `npm test tests/workspace-lock.test.ts` (in `mcp-server/`)
Expected: PASS

**Step 5: Commit**
```bash
git add mcp-server/src/memory/workspace-lock.ts mcp-server/tests/workspace-lock.test.ts
git commit -m "feat(memory): implement WorkspaceLockManager and skill-writer preloader"
```

---

### Task 3: Hook Workspace Lock & Preloading into `initWorkspace`

**Files:**
- Modify: `mcp-server/src/tools/init-workspace.ts`
- Test: `mcp-server/tests/init-workspace-lock.test.ts`

**Step 1: Write the failing test**
Create `mcp-server/tests/init-workspace-lock.test.ts` verifying that calling `initWorkspace(tempDir)` initializes `.agents/AGENTS.md` and also acquires the workspace lock and preloads `skill-writer`.

**Step 2: Run test to verify it fails**
Run: `npm test tests/init-workspace-lock.test.ts` (in `mcp-server/`)
Expected: FAIL (lock file not created during init).

**Step 3: Implement minimal code**
In `mcp-server/src/tools/init-workspace.ts`:
- Import `WorkspaceLockManager`.
- After creating `.agents/AGENTS.md`, call `await WorkspaceLockManager.getInstance().acquireLock(resolvedPath)` and `await WorkspaceLockManager.getInstance().preloadSkillWriter(resolvedPath)`.

**Step 4: Run test to verify it passes**
Run: `npm test tests/init-workspace-lock.test.ts` (in `mcp-server/`)
Expected: PASS

**Step 5: Commit**
```bash
git add mcp-server/src/tools/init-workspace.ts mcp-server/tests/init-workspace-lock.test.ts
git commit -m "feat(workspace): attach workspace lock and skill-writer preload to initWorkspace"
```

---

### Task 4: `manage_memory` Subtool: `resolve_workspace_lock` with Local Model Reminder

**Files:**
- Modify: `mcp-server/src/tools/manage-memory.ts`
- Modify: `mcp-server/src/mcp/index.ts`
- Modify: `mcp-server/dashboard/index.html` & `mcp-server/dashboard/js/04-playground-form.js`
- Test: `mcp-server/tests/resolve-workspace-lock.test.ts`

**Step 1: Write the failing test**
Create `mcp-server/tests/resolve-workspace-lock.test.ts` verifying:
1. Calling `manageMemory({ action: 'resolve_workspace_lock', workspace_root: dir })` inspects workspace docs.
2. Returns classified schematics (public vs dev) with diagram suggestions.
3. Suggests tailored skills to load (including preloaded `skill-writer`).
4. Checks local model availability and includes status (`localModelReady: boolean`, `localModelBusy: boolean`). If offline or busy, returns helpful advisory reminder note: `"Local model offline or busy. Re-run with allowCloudFallback: true to use cloud LLM."`
5. Successfully unlocks the workspace lock.

**Step 2: Run test to verify it fails**
Run: `npm test tests/resolve-workspace-lock.test.ts` (in `mcp-server/`)
Expected: FAIL with unhandled action `resolve_workspace_lock`.

**Step 3: Implement minimal code**
In `mcp-server/src/tools/manage-memory.ts` and `mcp-server/src/mcp/index.ts`:
- Add `'resolve_workspace_lock'` to `ManageMemoryInput['action']` union and tool schema.
- Implement dispatch in `manageMemory` calling `WorkspaceLockManager` and `MemoryAuditor`.
- Check local model status via `LocalModelLock` and bridge probe.
- Update playground and quickstart parameter tables.

**Step 4: Run test to verify it passes**
Run: `npm test tests/resolve-workspace-lock.test.ts` (in `mcp-server/`)
Expected: PASS

**Step 5: Commit**
```bash
git add mcp-server/src/tools/manage-memory.ts mcp-server/src/mcp/index.ts mcp-server/dashboard/ mcp-server/tests/resolve-workspace-lock.test.ts
git commit -m "feat(memory): add resolve_workspace_lock subtool to manage_memory"
```

---

### Task 5: Deterministic `skill-writer` Semantic Rule Matcher & Opt-in `execute_skill` with Cloud Fallback

**Files:**
- Modify: `mcp-server/src/memory/memory-auditor.ts`
- Modify: `mcp-server/src/tools/execute-skill.ts`
- Test: `mcp-server/tests/skill-writer-semantic-matcher.test.ts`

**Step 1: Write the failing test**
Create `mcp-server/tests/skill-writer-semantic-matcher.test.ts` verifying:
1. Deterministic validation of a skill file against `skill-writer` specification (frontmatter, description trigger keywords, sections, output contract) without any LLM invocation.
2. Detection of skill drift when tool/API changes occur.
3. When opt-in remediation is requested:
   - If local model is unavailable or busy, returns deterministic proposal with reminder: `"Local model unavailable or busy. Call again with allowCloudFallback: true to run LLM synthesis."`
   - If local model is available or `allowCloudFallback: true` is passed, invokes `executeSkill` with `skill: 'skill-writer'` locally.
4. Returns compact markdown pill (`< 300` chars):
   `💡 **Memory Drift Alert**: 1 doc & 1 skill drifted. Run manage_memory...`

**Step 2: Run test to verify it fails**
Run: `npm test tests/skill-writer-semantic-matcher.test.ts` (in `mcp-server/`)
Expected: FAIL (method not defined).

**Step 3: Implement minimal code**
In `mcp-server/src/memory/memory-auditor.ts`:
- Implement `matchSkillWriterRules(skillContent: string, availableTools: string[])` for pure semantic/AST checking.
- Implement `applySkillDriftRemediation()` with local model probe, fallback reminder, and opt-in `executeSkill`.
- Implement `formatCompactDriftPill()`.

**Step 4: Run test to verify it passes**
Run: `npm test tests/skill-writer-semantic-matcher.test.ts` (in `mcp-server/`)
Expected: PASS

**Step 5: Commit**
```bash
git add mcp-server/src/memory/memory-auditor.ts mcp-server/src/tools/execute-skill.ts mcp-server/tests/skill-writer-semantic-matcher.test.ts
git commit -m "feat(memory): implement deterministic skill-writer semantic matcher and cloud fallback advisory"
```

---

### Task 6: End-to-End Verification & Precommit Suite

**Files:**
- Create: `mcp-server/scripts/smoke/smoke_workspace_lock.ts`
- Run: `npm run verify:precommit` with `SKIP_AUDIT=1`

**Step 1: Write smoke script**
Create standalone smoke script that:
1. Creates temporary workspace.
2. Inits workspace (verifies lock file and preloaded `skill-writer`).
3. Calls `manage_memory` with `resolve_workspace_lock`.
4. Verifies lock is resolved, schematics returned, and local model advisory displayed if offline.
5. Verifies precommit checks pass with `SKIP_AUDIT=1`.

**Step 2: Run smoke and precommit checks**
Run: `npx tsx scripts/smoke/smoke_workspace_lock.ts`
Run: `npm run verify:precommit`

**Step 3: Commit and push**
```bash
git add mcp-server/scripts/smoke/smoke_workspace_lock.ts
git commit -m "test(smoke): add end-to-end workspace lock and skill-writer smoke test"
```
