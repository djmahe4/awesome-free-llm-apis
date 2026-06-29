import { useFreeLLM } from '../../src/tools/use-free-llm.js';
import { saveFixture } from './fixture-helper.js';

export async function runCodeFeedbackLoopTest(workspaceRoot: string, model: string): Promise<{ success: boolean; decomposed: boolean }> {
    console.log('\n[Case F] Running Code Context Feedback Loop via use_free_llm...');

    try {
        const result = await useFreeLLM({
            model,
            messages: [
                { role: 'system', content: 'You are a Senior API Developer.' },
                { role: 'user', content: 'check the exports in packages/shared/src/utils.ts and tell me the name of the function exported.' }
            ],
            workspace_root: workspaceRoot,
            sessionId: 'smoke-session-code-feedback',
            agentic: true
        });

        await saveFixture('case-f', result);

        const response = result?.choices?.[0]?.message?.content || '';
        const decomposed = response.includes("I've broken your request into");
        console.log(`[+] Case F LLM Response Snippet:\n---\n${response.substring(0, 500)}...\n---`);

        const hasHelperName = response.includes('formatResponse');
        console.log(`    - Found "formatResponse" function name: ${hasHelperName ? 'YES' : 'NO'}`);

        return { success: true, decomposed };
    } catch (err: any) {
        console.error(`[-] Case F Failed: ${err.message}`);
        return { success: false, decomposed: false };
    }
}
