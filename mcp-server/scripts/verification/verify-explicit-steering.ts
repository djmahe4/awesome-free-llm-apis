/**
 * @file verify-explicit-steering.ts
 * @description Validates that the section-scoring correctly surfaces relevant sections
 * from prompt.json based on query context and keyword steering.
 * Usage: npx tsx scripts/verification/verify-explicit-steering.ts
 */
import { getIntelligentSystemPrompt } from '../../src/pipeline/middlewares/prompts.js';

async function verifySteering() {
    console.log('--- Verification: Section Scoring & Prompt Steering ---\n');

    // 1. Fuzzy Fallback: query text should surface matching sections by title-word scoring
    console.log('[1/3] Fuzzy: "metrics and north star goals"');
    const fuzzyPrompt = await getIntelligentSystemPrompt({
        context: 'I want to know about metrics and north star goals'
    });
    const hasMetrics = fuzzyPrompt.includes('SUCCESS METRICS');
    const hasNorthStar = fuzzyPrompt.includes('NORTH STAR');
    console.log(`  - Has SUCCESS METRICS section: ${hasMetrics} (expected: true)`);
    console.log(`  - Has NORTH STAR section: ${hasNorthStar} (expected: true)`);
    console.log(`  - Char length: ${fuzzyPrompt.length}\n`);

    // 2. Strict Steering: only "metrics" keyword — should inject metrics but NOT north_star
    console.log('[2/3] Strict: keyword=["metrics"] only');
    const strictPrompt = await getIntelligentSystemPrompt({
        keywords: ['metrics']
    });
    const strictHasMetrics = strictPrompt.includes('SUCCESS METRICS') || strictPrompt.includes('MOMENTUM METRICS');
    const strictHasNorthStar = strictPrompt.includes('NORTH STAR');
    console.log(`  - Has metrics section: ${strictHasMetrics} (expected: true)`);
    console.log(`  - Has NORTH STAR (should be absent): ${strictHasNorthStar} (expected: false)`);
    console.log(`  - Char length: ${strictPrompt.length}\n`);

    // 3. Memory injection: memory block should appear at top
    console.log('[3/3] Memory context prepend');
    const memPrompt = await getIntelligentSystemPrompt({
        context: 'check reliability rules',
        memory: 'Previous session: implemented circuit breaker for provider failover.'
    });
    const hasMemory = memPrompt.includes('WORKSPACE MEMORY');
    const hasGrounding = memPrompt.includes('GROUNDING');
    console.log(`  - Has WORKSPACE MEMORY block: ${hasMemory} (expected: true)`);
    console.log(`  - Has GROUNDING block: ${hasGrounding} (expected: true)`);
    console.log(`  - Char length: ${memPrompt.length}\n`);

    // Summary
    const pass = hasMetrics && hasNorthStar && strictHasMetrics && !strictHasNorthStar && hasMemory && hasGrounding;
    if (pass) {
        console.log('✅ All steering checks PASSED. Prompt assembly is working correctly.');
    } else {
        console.error('❌ One or more checks FAILED. Review output above.');
        process.exit(1);
    }
}

verifySteering().catch(err => {
    console.error('❌ Verification crashed:', err.message);
    process.exit(1);
});
