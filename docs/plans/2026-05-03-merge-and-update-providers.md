# Merge Upstream and Update Providers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge latest changes from the parent repository and update the MCP server with the newest free LLM providers and models identified via search and upstream diffs.

**Architecture:** 
1. Merge `upstream/main` to sync the `README.md` and any core changes.
2. Implement new provider classes in `src/providers/` for OVHcloud and any others.
3. Update existing provider model lists in `src/providers/*.ts`.
4. Verify updates with provider smoke tests.

**Tech Stack:** TypeScript, Git, Vitest

**Context7 mcp can be used for dev help**

---

### Task 1: Merge Upstream Changes
**Files:**
- Modify: `README.md`
- Modify: `mcp-server/CHANGELOG.md`

**Step 1: Merge upstream/main**
Run: `git merge upstream/main --no-edit`
Expected: Successful merge (handle conflicts if any).

**Step 2: Commit merge if manual intervention was needed**
Run: `git commit -m "chore: merge upstream/main"` (only if conflict happened)

---

### Task 2: Implement OVHcloud Provider
**Files:**
- Create: `mcp-server/src/providers/ovh.ts`
- Modify: `mcp-server/src/providers/registry.ts`

**Step 1: Create ovh.ts**
```typescript
import { BaseProvider } from './base.js';
import { ModelInfo } from './types.js';

export class OVHProvider extends BaseProvider {
  readonly id = 'ovh';
  readonly name = 'OVHcloud';
  readonly baseUrl = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';

  getModels(): ModelInfo[] {
    return [
      { id: 'Meta-Llama-3_3-70B-Instruct', name: 'Llama 3.3 70B', contextWindow: 131072, maxOutput: 4096, pricing: { type: 'free' } },
      { id: 'DeepSeek-R1-Distill-Llama-70B', name: 'DeepSeek R1 70B', contextWindow: 131072, maxOutput: 32768, pricing: { type: 'free' } },
      { id: 'Qwen3-32B', name: 'Qwen 3 32B', contextWindow: 131072, maxOutput: 32768, pricing: { type: 'free' } },
    ];
  }
}
```

**Step 2: Register OVH in registry.ts**
Add `new OVHProvider()` to the `providers` array.

---

### Task 3: Update Existing Provider Models
**Files:**
- Modify: `mcp-server/src/providers/gemini.ts`
- Modify: `mcp-server/src/providers/groq.ts`
- Modify: `mcp-server/src/providers/openrouter.ts`
- Modify: `mcp-server/src/providers/siliconflow.ts`
- Modify: `mcp-server/src/providers/zhipu.ts`

**Step 1: Update Gemini Models**
Add `gemini-2.5-flash` and `gemini-2.5-flash-lite`.

**Step 2: Update Groq Models**
Add `llama-4-scout`, `llama-4-maverick`.

**Step 3: Update OpenRouter Models**
Add `qwen/qwen3-coder-480b-a35b:free`, `qwen/qwen3.6-plus:free`.

**Step 4: Update SiliconFlow Models**
Add `Qwen/Qwen3-8B`, `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`.

---

### Task 5: Implement Kilo Code Provider
**Files:**
- Create: `mcp-server/src/providers/kilocode.ts`
- Modify: `mcp-server/src/providers/registry.ts`

**Step 1: Create kilocode.ts**
```typescript
import { BaseProvider } from './base.js';
import { ModelInfo } from './types.js';

export class KiloCodeProvider extends BaseProvider {
  readonly id = 'kilocode';
  readonly name = 'Kilo Code';
  readonly baseUrl = 'https://api.kilo.ai/v1';

  getModels(): ModelInfo[] {
    return [
      { id: 'kilo-auto/free', name: 'Kilo Auto Free', contextWindow: 128000, maxOutput: 4096, pricing: { type: 'free' } },
      { id: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5 Free', contextWindow: 196000, maxOutput: 8192, pricing: { type: 'free' } },
    ];
  }
}
```

---

### Task 6: Implement SambaNova Provider
**Files:**
- Create: `mcp-server/src/providers/sambanova.ts`
- Modify: `mcp-server/src/providers/registry.ts`

**Step 1: Create sambanova.ts**
```typescript
import { BaseProvider } from './base.js';
import { ModelInfo } from './types.js';

export class SambaNovaProvider extends BaseProvider {
  readonly id = 'sambanova';
  readonly name = 'SambaNova';
  readonly baseUrl = 'https://api.sambanova.ai/v1';

  getModels(): ModelInfo[] {
    return [
      { id: 'llama-3.3-70b-instruct', name: 'Llama 3.3 70B', contextWindow: 131072, maxOutput: 4096, pricing: { type: 'free' } },
      { id: 'qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', contextWindow: 131072, maxOutput: 4096, pricing: { type: 'free' } },
    ];
  }
}
```

---

### Task 7: Verification
**Files:**
- Test: `mcp-server/tests/provider-registry.test.ts`

**Step 1: Run registry tests**
Run: `npm test tests/provider-registry.test.ts`
Expected: PASS

**Step 2: Commit final updates**
Run: `git add . ; git commit -m "feat: update providers and models for v1.0.6-pre"`
