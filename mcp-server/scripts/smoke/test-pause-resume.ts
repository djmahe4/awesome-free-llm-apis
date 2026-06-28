import { useFreeLLM } from '../../src/tools/use-free-llm.js';
import { saveFixture } from './fixture-helper.js';

export async function runPauseResumeTest(workspaceRoot: string, model: string): Promise<{ success: boolean; decomposed: boolean }> {
    console.log('\n[Case H] Running HITL Pause & Resume Test via use_free_llm...');

    const sessionId = `smoke-session-pause-resume-${Date.now()}`;

    try {
        // 1. Trigger the pause by asking for a terminal run
        const pauseResult = await useFreeLLM({
            model,
            messages: [
                { role: 'system', content: 'You are a system administrator.' },
                { role: 'user', content: 'Please run the build script `npm run build` in the workspace.' }
            ],
            workspace_root: workspaceRoot,
            sessionId,
            agentic: true
        });

        await saveFixture('case-h-pause', pauseResult);

        const pauseResponse = pauseResult?.choices?.[0]?.message?.content || '';
        console.log(`[+] Case H Pause Response Snippet:\n---\n${pauseResponse.substring(0, 400)}...\n---`);

        // Extract the promptId using regex matching: continue [A-Z0-9]{6}
        const match = pauseResponse.match(/continue\s+([A-Z0-9]{6})/i);
        if (!match) {
            console.error('[-] Case H Failed: Could not find promptId in pause response.');
            return { success: false, decomposed: true };
        }

        const promptId = match[1];
        console.log(`[+] Case H Extracted Prompt ID: ${promptId}`);

        // 2. Resume the pipeline using the continue command
        console.log(`[+] Case H Resuming pipeline with: "continue ${promptId} build completed successfully with 0 errors"`);
        const resumeResult = await useFreeLLM({
            model,
            messages: [
                { role: 'system', content: 'You are a system administrator.' },
                { role: 'user', content: `continue ${promptId} build completed successfully with 0 errors` }
            ],
            workspace_root: workspaceRoot,
            sessionId,
            agentic: true
        });

        await saveFixture('case-h-resume', resumeResult);

        const resumeResponse = resumeResult?.choices?.[0]?.message?.content || '';
        console.log(`[+] Case H Resume Response Snippet:\n---\n${resumeResponse.substring(0, 400)}...\n---`);

        const success = resumeResponse.toLowerCase().includes('success') || resumeResponse.toLowerCase().includes('complete') || resumeResponse.toLowerCase().includes('build');
        console.log(`    - Pipeline resumed and completed: ${success ? 'YES' : 'NO'}`);

        return { success, decomposed: true };
    } catch (err: any) {
        console.error(`[-] Case H Failed: ${err.message}`);
        return { success: false, decomposed: false };
    }
}
