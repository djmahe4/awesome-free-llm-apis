import { ProviderRegistry } from '../../src/providers/registry.js';
import { MonorepoSandbox } from './monorepo-sandbox.js';
import { runVibeAuditorTest } from './test-vibe-auditor.js';
import { runVisionLayoutTest } from './test-vision-layout.js';
import { runMultiAgentTest } from './test-multi-agent.js';
import { runAnalyzeProjectTest } from './test-analyze-project.js';
import { runAmbiguityResolutionTest } from './test-ambiguity-resolution.js';
import { runCodeFeedbackLoopTest } from './test-code-feedback-loop.js';
import { runDocFeedbackLoopTest } from './test-doc-feedback-loop.js';
import { runPauseResumeTest } from './test-pause-resume.js';

interface TestCaseResult {
    success: boolean;
    decomposed: boolean;
}

async function main() {
    console.log('====================================================');
    console.log('       REAL-API PIPELINE SMOKE TEST SUITE          ');
    console.log('====================================================');

    // 1. Identify active providers
    const registry = ProviderRegistry.getInstance();
    const providers = registry.getAllProviders();
    const availableProviders = providers.filter(p => p.isAvailable());

    console.log(`\nAvailable providers found: ${availableProviders.map(p => p.id).join(', ')}`);
    
    if (availableProviders.length === 0) {
        console.error('[-] Error: No active providers available. Please check API keys in mcp-server/.env.');
        process.exit(1);
    }

    // Prefer gemini for vision/general, otherwise use first available
    const preferredProvider = availableProviders.find(p => p.id === 'gemini') || availableProviders[0];
    const model = preferredProvider.id === 'gemini' 
        ? (preferredProvider.models.find(m => m.id === 'gemini-3.1-flash-lite')?.id || preferredProvider.models[0].id)
        : preferredProvider.models[0].id;

    console.log(`\nUsing Provider: ${preferredProvider.name} (${preferredProvider.id})`);
    console.log(`Using Model: ${model}`);

    // 2. Initialize Monorepo Sandbox
    const sandbox = new MonorepoSandbox();
    console.log(`\nSetting up mock monorepo sandbox at: ${sandbox.workspaceRoot}`);
    
    await sandbox.setup();
    console.log('[+] Sandbox initialized successfully.');

    const results: Record<string, TestCaseResult> = {
        'Case A (Vibe Code Auditor)': { success: false, decomposed: false },
        'Case B (Vision Layout Analysis)': { success: false, decomposed: false },
        'Case C (Multi-Agent Review)': { success: false, decomposed: false },
        'Case D (Forensic Session Review)': { success: false, decomposed: false },
        'Case E (Ambiguity Clarification)': { success: false, decomposed: false },
        'Case F (Code Context Feedback Loop)': { success: false, decomposed: false },
        'Case G (Doc Context Feedback Loop)': { success: false, decomposed: false },
        'Case H (HITL Pause & Resume)': { success: false, decomposed: false }
    };

    const startTime = Date.now();

    try {
        // Execute Case A
        results['Case A (Vibe Code Auditor)'] = await runVibeAuditorTest(sandbox.workspaceRoot, model);

        // Execute Case B (if provider supports vision or gemini is used)
        if (preferredProvider.id === 'gemini') {
            results['Case B (Vision Layout Analysis)'] = await runVisionLayoutTest(sandbox.workspaceRoot, model);
        } else {
            console.log('\n[Case B] Skipping vision test (only supported natively on Gemini).');
            results['Case B (Vision Layout Analysis)'] = { success: true, decomposed: false };
        }

        // Execute Case C
        results['Case C (Multi-Agent Review)'] = await runMultiAgentTest(sandbox.workspaceRoot, model);

        // Execute Case D
        results['Case D (Forensic Session Review)'] = await runAnalyzeProjectTest(sandbox.workspaceRoot, model);

        // Execute Case E
        results['Case E (Ambiguity Clarification)'] = await runAmbiguityResolutionTest(sandbox.workspaceRoot, model);

        // Execute Case F
        results['Case F (Code Context Feedback Loop)'] = await runCodeFeedbackLoopTest(sandbox.workspaceRoot, model);

        // Execute Case G
        results['Case G (Doc Context Feedback Loop)'] = await runDocFeedbackLoopTest(sandbox.workspaceRoot, model);

        // Execute Case H
        results['Case H (HITL Pause & Resume)'] = await runPauseResumeTest(sandbox.workspaceRoot, model);

    } catch (err: any) {
        console.error(`\n[-] Unhandled exception during smoke tests: ${err.message}`);
    } finally {
        console.log(`\nCleaning up monorepo sandbox...`);
        await sandbox.cleanup();
        console.log('[+] Sandbox cleanup completed.');
    }

    // 3. Print Summary Dashboard
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n========================================================================');
    console.log(`                       SMOKE TEST SUITE SUMMARY                         `);
    console.log(`                       Total Time: ${elapsed}s                          `);
    console.log('========================================================================');
    console.log(' ' + 'Scenario Name'.padEnd(38) + ' | ' + 'Status'.padEnd(8) + ' | ' + 'Subtasks Split');
    console.log('------------------------------------------------------------------------');
    
    let allPassed = true;
    for (const [testName, result] of Object.entries(results)) {
        const statusText = result.success ? 'PASSED' : 'FAILED';
        const splitText = result.decomposed ? 'YES (Decomposed)' : 'NO (Monolithic)';
        const statusIcon = result.success ? '✅' : '❌';
        
        console.log(`${statusIcon} ${testName.padEnd(35)} | ${statusText.padEnd(8)} | ${splitText}`);
        if (!result.success) allPassed = false;
    }
    console.log('========================================================================\n');

    if (!allPassed) {
        console.error('[-] Error: One or more critical smoke test cases failed.');
        process.exit(1);
    } else {
        console.log('[+] All smoke tests executed successfully.');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal runner error:', err);
    process.exit(1);
});
