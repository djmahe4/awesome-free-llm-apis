/**
 * Local context injection audit script.
 * Run with: npx tsx scripts/evaluation/test-json-pinning.ts
 * No build required.
 */
import { ContextGatherer } from '../../src/middleware/agentic/context-gatherer.js';

const WORKSPACE  = 'c:\\Users\\mahes\\OneDrive\\Desktop\\Python-Projects\\nday-research-ai-cve';
const QUERY      = 'In "daily-nday-pipeline.import.json", does the Split in Batches node (typeVersion: 3) have a splitBy parameter?';
const KEYWORDS   = ['daily-nday-pipeline.import.json', 'splitInBatches', 'typeVersion'];

async function main() {
    console.log('=== Context Injection Audit ===');
    console.log(`Workspace : ${WORKSPACE}`);
    console.log(`Keywords  : ${KEYWORDS.join(', ')}\n`);

    const results = await ContextGatherer.gatherContext({
        workspaceRoot: WORKSPACE,
        query: QUERY,
        keywords: KEYWORDS,
        limit: 5,
    });

    if (results.length === 0) {
        console.error('⚠️  NO CONTEXT INJECTED — file was not found or scored too low.');
        process.exit(1);
    }

    console.log(`✅  ${results.length} snippet(s) injected:\n`);
    results.forEach(r => console.log(r));
}

main().catch(err => { console.error(err); process.exit(1); });
