import { useFreeLLM } from '../../src/tools/use-free-llm.js';
import { saveFixture } from './fixture-helper.js';

export async function runDocFeedbackLoopTest(workspaceRoot: string, model: string): Promise<{ success: boolean; decomposed: boolean }> {
    console.log('\n[Case G] Running Document Context Feedback Loop via use_free_llm...');

    try {
        const result = await useFreeLLM({
            model,
            messages: [
                { role: 'system', content: 'You are a Release Manager and Compliance Auditor.' },
                { role: 'user', content: 'read docs/release-checklists.md and verify if packages/api/src/server.ts complies with rule #1 (No hardcoded database credentials).' }
            ],
            workspace_root: workspaceRoot,
            sessionId: 'smoke-session-doc-feedback',
            agentic: true
        });

        await saveFixture('case-g', result);

        const response = result?.choices?.[0]?.message?.content || '';
        const decomposed = response.includes("I've broken your request into");
        console.log(`[+] Case G LLM Response Snippet:\n---\n${response.substring(0, 500)}...\n---`);

        const mentionsNonCompliance = /non-compliant|violate|fails|hardcoded|password|redacted/i.test(response);
        console.log(`    - Identified non-compliance for hardcoded secrets: ${mentionsNonCompliance ? 'YES' : 'NO'}`);

        return { success: true, decomposed };
    } catch (err: any) {
        console.error(`[-] Case G Failed: ${err.message}`);
        return { success: false, decomposed: false };
    }
}
