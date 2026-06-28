import { useFreeLLM } from '../../src/tools/use-free-llm.js';
import { saveFixture } from './fixture-helper.js';

export async function runAmbiguityResolutionTest(workspaceRoot: string, model: string): Promise<{ success: boolean; decomposed: boolean }> {
    console.log('\n[Case E] Running Confused User / Ambiguous Query Resolution via use_free_llm...');

    const systemPrompt = `You are a Customer Support Specialist and Technical Troubleshooting Assistant. 
When a user asks for a code modification or bug fix but fails to provide essential details (such as the database type, error message, exact files, or connection strings), your goal is to politely decline to guess and instead ask 3-4 highly specific clarifying questions.`;

    try {
        const result = await useFreeLLM({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: 'fix the database connection error in packages/api' }
            ],
            workspace_root: workspaceRoot,
            sessionId: 'smoke-session-ambiguity',
            agentic: false
        });

        await saveFixture('case-e', result);

        const response = result?.choices?.[0]?.message?.content || '';
        const decomposed = response.includes("I've broken your request into");
        console.log(`[+] Case E LLM Response Snippet:\n---\n${response.substring(0, 500)}...\n---`);

        const hasQuestions = response.includes('?') || /question|clarify|details|provide/i.test(response);
        console.log(`    - Formulated clarifying questions: ${hasQuestions ? 'YES' : 'NO'}`);

        return { success: true, decomposed };
    } catch (err: any) {
        console.error(`[-] Case E Failed: ${err.message}`);
        return { success: false, decomposed: false };
    }
}
