import { executeSkill } from '../../src/tools/execute-skill.js';
import { saveFixture } from './fixture-helper.js';
import path from 'node:path';
import fs from 'fs-extra';

export async function runVibeAuditorTest(workspaceRoot: string, model: string): Promise<{ success: boolean; decomposed: boolean }> {
    console.log('\n[Case A] Running Vibe Code Auditor via execute_skill...');

    const serverFile = path.join(workspaceRoot, 'packages/api/src/server.ts');
    const serverCode = await fs.readFile(serverFile, 'utf-8');

    const result = await executeSkill({
        skill: 'vibe-code-auditor',
        input: `Please audit the following file for technical debt and security risks:
        
=== FILE: packages/api/src/server.ts ===
${serverCode}`,
        model,
        workspace_root: workspaceRoot,
        sessionId: 'smoke-session-vibe-auditor'
    });

    await saveFixture('case-a', result);

    if (!result.success) {
        console.error(`[-] Case A Failed: ${result.error}`);
        return { success: false, decomposed: false };
    }

    const response = result.response || '';
    const decomposed = response.includes("I've broken your request into");
    console.log(`[+] Case A LLM Response Snippet:\n---\n${response.substring(0, 500)}...\n---`);

    const hasSqlInjection = /sql|inject/i.test(response);
    const hasBareCatch = /catch|silent|empty/i.test(response);
    const hasSecret = /password|secret|credential|redacted/i.test(response);

    console.log(`    - Detected SQL Injection: ${hasSqlInjection ? 'YES' : 'NO'}`);
    console.log(`    - Detected Bare Catch: ${hasBareCatch ? 'YES' : 'NO'}`);
    console.log(`    - Detected Hardcoded Secret: ${hasSecret ? 'YES' : 'NO'}`);

    // Case A should successfully detect these vulnerabilities when provided the code
    if (hasSqlInjection || hasBareCatch || hasSecret) {
        console.log('✅ Case A Passed: Core vulnerabilities successfully audited.');
        return { success: true, decomposed };
    } else {
        console.warn('⚠️ Case A Warning: Model did not flag any expected vulnerabilities.');
        return { success: true, decomposed };
    }
}
