import { executeSkill } from '../../src/tools/execute-skill.js';
import { saveFixture } from './fixture-helper.js';
import path from 'node:path';
import fs from 'fs-extra';

export async function runAnalyzeProjectTest(workspaceRoot: string, model: string): Promise<{ success: boolean; decomposed: boolean }> {
    console.log('\n[Case D] Running Forensic Session Analysis via execute_skill...');

    const brainDir = path.join(workspaceRoot, 'mock_brain');
    await fs.ensureDir(brainDir);

    const taskMd = `
# Tasks
- [x] Setup sandbox utility
- [x] Implement Case A
- [/] Implement Case B
- [ ] Implement Case C
`.trim();
    await fs.writeFile(path.join(brainDir, 'task.md'), taskMd);
    await fs.writeFile(path.join(brainDir, 'task.md.resolved.0'), '# Tasks (Original Snapshot)');
    await fs.writeFile(path.join(brainDir, 'task.md.resolved.1'), '# Tasks (Modified snapshot showing rework)');

    await fs.writeFile(path.join(brainDir, 'implementation_plan.md'), '# Implementation Plan\n- Step 1: Create Monorepo');
    await fs.writeFile(path.join(brainDir, 'walkthrough.md'), '# Walkthrough\n- Completed backend tests.');

    const metadata = {
        total_tokens: 25000,
        prompt_tokens: 20000,
        completion_tokens: 5000,
        elapsed_ms: 120000,
        intent: 'DEBUGGING'
    };
    await fs.writeJson(path.join(brainDir, 'session_metadata.json'), metadata, { spaces: 2 });

    try {
        const result = await executeSkill({
            skill: 'analyze-project',
            input: `Please run /analyze-project on the session directory: ${brainDir}`,
            model,
            workspace_root: workspaceRoot,
            sessionId: 'smoke-session-analyze-project'
        });

        await saveFixture('case-d', result);

        if (!result.success) {
            console.error(`[-] Case D Failed: ${result.error}`);
            return { success: false, decomposed: false };
        }

        const response = result.response || '';
        const decomposed = response.includes("I've broken your request into");
        console.log(`[+] Case D LLM Response Snippet:\n---\n${response.substring(0, 500)}...\n---`);

        const hasRework = /rework|snapshot|resolved/i.test(response);
        console.log(`    - Detected Rework/Snapshots: ${hasRework ? 'YES' : 'NO'}`);

        console.log('✅ Case D Passed: Forensic session analysis completed successfully.');
        return { success: true, decomposed };
    } catch (err: any) {
        console.error(`[-] Case D Failed: ${err.message}`);
        return { success: false, decomposed: false };
    }
}
