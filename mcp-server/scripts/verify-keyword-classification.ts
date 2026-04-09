
import { IntelligentRouterMiddleware } from '../src/pipeline/middlewares/IntelligentRouterMiddleware.js';
import { TaskType } from '../src/pipeline/middleware.js';

// Access private methods for testing via casting or by making them public/protected if needed
// For this smoke test, we can use a small hack or just verify via the public execute method if possible.
// Since autoClassify is private, we'll use a type-safe bypass for the test.

const router = new IntelligentRouterMiddleware() as any;

async function runTests() {
    console.error('--- Verification: Keyword-Based Task Classification ---');

    const testCases = [
        {
            name: 'Single Coding Keyword',
            messages: [{ role: 'user', content: 'hello' }],
            keywords: ['typescript'],
            expected: TaskType.Coding
        },
        {
            name: 'Majority Search Keywords',
            messages: [{ role: 'user', content: 'implement this' }], // regex would say coding
            keywords: ['search', 'find', 'code'], // 2 for search, 1 for code
            expected: TaskType.SemanticSearch
        },
        {
            name: 'Keyword Tie (Fallback to Regex)',
            messages: [{ role: 'user', content: 'summarize this' }],
            keywords: ['code', 'summarize'], // Tie
            expected: TaskType.Summarization // Fallback to regex 'summarize'
        },
        {
            name: 'No Keywords (Regular Regex)',
            messages: [{ role: 'user', content: 'extract fields' }],
            keywords: [],
            expected: TaskType.EntityExtraction
        },
        {
            name: 'Unrecognized Keywords (Fallback to Regex)',
            messages: [{ role: 'user', content: 'summarize' }],
            keywords: ['random', 'tags'],
            expected: TaskType.Summarization
        }
    ];

    let allPassed = true;
    for (const tc of testCases) {
        const result = router.autoClassify(tc.messages, tc.keywords);
        const passed = result === tc.expected;
        console.error(`${passed ? '✅' : '❌'} ${tc.name}: Result=${result}, Expected=${tc.expected}`);
        if (!passed) allPassed = false;
    }

    if (allPassed) {
        console.error('\nSUCCESS: Keyword classification logic verified.');
    } else {
        console.error('\nFAILURE: Some test cases failed.');
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
