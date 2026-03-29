import { ProviderRegistry } from '../src/providers/registry.js';

async function runSmokeTest() {
    const registry = ProviderRegistry.getInstance();
    const providers = registry.getAllProviders();

    // In a real environment, you'd want to check p.isAvailable()
    // but for this test, we might want to see which ones are missing keys too.
    const availableProviders = providers.filter(p => p.isAvailable());

    console.log(`\n=== MCP Provider Smoke Test ===`);
    console.log(`Found ${providers.length} total providers.`);
    console.log(`Available providers: ${availableProviders.length > 0 ? availableProviders.map(p => p.id).join(', ') : 'NONE (set API keys in .env)'}`);

    if (availableProviders.length === 0) {
        console.log('\nTip: Create a .env file in the mcp-server directory with your API keys.');
        process.exit(0);
    }

    for (const provider of availableProviders) {
        const model = provider.models[0];
        if (!model) {
            console.log(`\n[-] Provider: ${provider.name} - No models defined.`);
            continue;
        }

        console.log(`\n[>] Testing Provider: ${provider.name} (${provider.id})`);
        console.log(`    Model: ${model.id}`);

        try {
            // Simulate/Execute chat call with minimal tokens
            const start = Date.now();
            const response = await provider.chat({
                model: model.id,
                messages: [{ role: 'user', content: 'Say "OK"' }],
                max_tokens: 1
            });
            const duration = Date.now() - start;

            console.log(`    Status: SUCCESS (${duration}ms)`);
            // console.log(`    Sample: ${JSON.stringify(response.choices?.[0]?.message?.content || 'no content')}`);
        } catch (error: any) {
            console.error(`    Status: FAILED`);
            console.error(`    Error: ${error.message}`);
        }
    }

    console.log(`\n=== Test Completed ===\n`);
}

runSmokeTest().catch(error => {
    console.error('Fatal error during smoke test:', error);
    process.exit(1);
});
