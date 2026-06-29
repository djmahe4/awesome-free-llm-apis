import { ProviderRegistry } from '../../src/providers/registry.js';
import { MonorepoSandbox } from './monorepo-sandbox.js';
import { runPauseResumeTest } from './test-pause-resume.js';

async function main() {
    console.log('====================================================');
    console.log('       ISOLATED CASE H SMOKE TEST RUN              ');
    console.log('====================================================');

    const registry = ProviderRegistry.getInstance();
    const providers = registry.getAllProviders();
    const availableProviders = providers.filter(p => p.isAvailable());

    if (availableProviders.length === 0) {
        console.error('[-] Error: No active providers available.');
        process.exit(1);
    }

    const preferredProvider = availableProviders.find(p => p.id === 'gemini') || availableProviders[0];
    const model = preferredProvider.id === 'gemini' 
        ? (preferredProvider.models.find(m => m.id === 'gemini-3.1-flash-lite')?.id || preferredProvider.models[0].id)
        : preferredProvider.models[0].id;

    console.log(`Using Model: ${model}`);

    const sandbox = new MonorepoSandbox();
    await sandbox.setup();

    try {
        const result = await runPauseResumeTest(sandbox.workspaceRoot, model);
        console.log(`\nIsolated Case H Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    } catch (err: any) {
        console.error(`Error: ${err.message}`);
    } finally {
        await sandbox.cleanup();
    }
}

main().catch(console.error);
