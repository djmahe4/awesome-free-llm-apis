import { getIntelligentSystemPrompt } from '../src/middleware/agentic/prompts';
import * as fs from 'fs';
import * as path from 'path';

async function verifySteering() {
    console.log('--- Verification: Explicit Keyword Steering ---');

    // 1. Test Fuzzy Fallback (No keywords)
    const fuzzyPrompt = await getIntelligentSystemPrompt("I want to know about metrics and north star goals");
    const hasMetrics = fuzzyPrompt.includes("SUCCESS METRICS");
    const hasNorthStar = fuzzyPrompt.includes("NORTH STAR");
    console.log(`Fuzzy Fallback - Has Metrics: ${hasMetrics}`);
    console.log(`Fuzzy Fallback - Has North Star: ${hasNorthStar}`);

    // 2. Test Strict Steering (Keywords provided)
    // We only want 'metrics' content.
    const strictPrompt = await getIntelligentSystemPrompt("Ignore this fuzzy text", ["metrics"]);
    const strictHasMetrics = strictPrompt.includes("SUCCESS METRICS");
    const strictHasNorthStar = strictPrompt.includes("NORTH STAR");
    
    console.log(`Strict Steering ["metrics"] - Has Metrics: ${strictHasMetrics} (Expected: true)`);
    console.log(`Strict Steering ["metrics"] - Has North Star: ${strictHasNorthStar} (Expected: false)`);

    if (strictHasMetrics && !strictHasNorthStar) {
        console.log('SUCCESS: Strict Steering successfully filtered documentation.');
    } else {
        console.log('FAILURE: Strict Steering did not filter correctly or fuzzy matching leaked.');
    }
}

verifySteering().catch(console.error);
