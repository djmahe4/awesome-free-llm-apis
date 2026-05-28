import { WorkspaceWalker } from '../../src/middleware/agentic/workspace-walker.js';

const WORKSPACE  = 'c:\\Users\\mahes\\OneDrive\\Desktop\\Python-Projects\\nday-research-ai-cve';
const KEYWORDS   = ['daily-nday-pipeline.import.json', 'splitInBatches', 'typeVersion'];

async function main() {
    console.log('=== WorkspaceWalker Candidate Audit ===');
    const candidates = await WorkspaceWalker.findRelevantFiles(WORKSPACE, KEYWORDS, 10, false, false);
    
    if (candidates.length === 0) {
        console.error('⚠️  No candidates found.');
    } else {
        console.log(`✅  ${candidates.length} candidates found:\n`);
        candidates.forEach(c => console.log(c));
    }
}

main().catch(err => { console.error(err); process.exit(1); });
