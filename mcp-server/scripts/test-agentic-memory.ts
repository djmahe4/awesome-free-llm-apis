import { AgenticMiddleware } from '../src/middleware/agentic/agentic-middleware.js';
import path from 'node:path';

async function testGrepContext() {
    const middleware = new AgenticMiddleware();
    const workspaceRoot = process.cwd();

    // Test 1: Coding Task with Code Block
    const codingQuery = "How does ```IntelligentRouterMiddleware``` handle errors?";
    console.log('\n--- Test 1: Coding Task with Code Block ---');
    console.log('Query:', codingQuery);
    const codeResults = await middleware.gatherGrepContext(workspaceRoot, codingQuery);
    console.log('Matches:', codeResults.length);
    codeResults.slice(0, 3).forEach(r => console.log('  ', r));

    // Test 2: Theoretical Task (Documentation)
    const docQuery = "Give me a summary of the documentation regarding architecture.";
    console.log('\n--- Test 2: Theoretical Task (Documentation) ---');
    console.log('Query:', docQuery);
    const docResults = await middleware.gatherGrepContext(workspaceRoot, docQuery);
    console.log('Matches:', docResults.length);
    docResults.slice(0, 3).forEach(r => console.log('  ', r));

    if (codeResults.length > 0 || docResults.length > 0) {
        console.log('\nSUCCESS: Intelligent Grep Context gathered relevant matches.');
    } else {
        console.error('\nFAILURE: No matches gathered. (Check if rg is installed)');
        process.exit(1);
    }
}

testGrepContext().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
