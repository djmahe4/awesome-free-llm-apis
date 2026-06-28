import { executeSkill } from '../../src/tools/execute-skill.js';
import { saveFixture } from './fixture-helper.js';
import path from 'node:path';

export async function runMultiAgentTest(workspaceRoot: string, model: string): Promise<{ success: boolean; decomposed: boolean }> {
    console.log('\n[Case C] Running Multi-Agent Design Review & Synthesis via execute_skill...');

    const serverFile = path.join(workspaceRoot, 'packages/api/src/server.ts');

    console.log('    - Spawning Parallel Reviews...');
    const [securityResult, performanceResult] = await Promise.all([
        executeSkill({
            skill: 'performance-testing-review-multi-agent-review',
            input: `Role: Security Auditor. Review the target file for credentials, injection, and database vulnerabilities: ${serverFile}`,
            model,
            workspace_root: workspaceRoot,
            sessionId: 'smoke-session-security-auditor'
        }),
        executeSkill({
            skill: 'performance-testing-review-multi-agent-review',
            input: `Role: Performance Analyst. Review the target file for resource leaks, missing timeouts, and loop bottlenecks: ${serverFile}`,
            model,
            workspace_root: workspaceRoot,
            sessionId: 'smoke-session-performance-analyst'
        })
    ]);

    await saveFixture('case-c-security', securityResult);
    await saveFixture('case-c-performance', performanceResult);

    if (!securityResult.success || !performanceResult.success) {
        console.error(`[-] Case C Failed in Phase 1:`);
        if (!securityResult.success) console.error(`    - Security Auditor error: ${securityResult.error}`);
        if (!performanceResult.success) console.error(`    - Performance Analyst error: ${performanceResult.error}`);
        return { success: false, decomposed: false };
    }

    const securityReport = securityResult.response || '';
    const performanceReport = performanceResult.response || '';

    console.log('      [+] Security Auditor completed.');
    console.log('      [+] Performance Analyst completed.');

    console.log('    - Spawning Sequential Synthesis (Architecture Reviewer)...');
    const synthesisResult = await executeSkill({
        skill: 'multi-agent-brainstorming',
        input: `Role: Primary Designer & Architecture Reviewer. Please synthesize the following two reports and produce a prioritized, consolidated decision log for the monorepo:

=== SECURITY AUDIT REPORT ===
${securityReport}

=== PERFORMANCE ANALYST REPORT ===
${performanceReport}`,
        model,
        workspace_root: workspaceRoot,
        sessionId: 'smoke-session-architecture-reviewer'
    });

    await saveFixture('case-c-synthesis', synthesisResult);

    if (!synthesisResult.success) {
        console.error(`[-] Case C Failed in Phase 2: ${synthesisResult.error}`);
        return { success: false, decomposed: false };
    }

    const finalReport = synthesisResult.response || '';
    const decomposed = finalReport.includes("I've broken your request into");
    console.log(`[+] Case C Synthesized Decision Log:\n---\n${finalReport.substring(0, 500)}...\n---`);
    console.log('✅ Case C Passed: Multi-agent review and synthesis executed successfully.');
    return { success: true, decomposed };
}
