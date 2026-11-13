import { beforeEach } from 'vitest';
import path from 'node:path';

const AVST_ROOT = 'C:/Users/mahes/OneDrive/Desktop/Python-Projects/awesome-free-llm-apis';

/**
 * Provides the workspace root as context source for testing context extraction pipelines.
 * Clears the ContextGatherer LRU cache between tests to prevent cross-test key collisions.
 */
export function useAvstWorkspace() {
    beforeEach(async () => {
        try {
            const mod = await import('../../src/pipeline/middlewares/context-gatherer.js');
            mod.__test_clearCache?.();
        } catch {}
    });

    return { wsRoot: AVST_ROOT };
}
