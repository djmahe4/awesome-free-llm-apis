import { ContextGatherer } from '../../src/middleware/agentic/context-gatherer.js';
import { WorkspaceWalker } from '../../src/middleware/agentic/workspace-walker.js';
import path from 'path';

async function main() {
    const workspaceRoot = "c:\\Users\\mahes\\OneDrive\\Desktop\\Python-Projects\\Study-AI-Agent";
    const query = "Explain the implementation of `core/gemini_processor.py` and `SimpleGeminiCache` in this project.";
    
    console.log(`Searching for context in: ${workspaceRoot}`);
    console.log(`Query: ${query}\n`);

    // @ts-ignore - reaching into private static to help debug
    const originalScore = (WorkspaceWalker as any).calculateScore;
    // @ts-ignore
    (WorkspaceWalker as any).calculateScore = (...args: any[]) => {
        const score = originalScore.apply(WorkspaceWalker, args);
        return score;
    };
    
    // Mock logging for WorkspaceWalker
    const originalFind = (WorkspaceWalker as any).findRelevantFiles;
    (WorkspaceWalker as any).findRelevantFiles = async (root: string, keywords: string[], limit: number, override: boolean) => {
        console.log(`Keywords for WorkspaceWalker: ${JSON.stringify(keywords)}`);
        const results = await originalFind.apply(WorkspaceWalker, [root, keywords, limit, override]);
        console.log(`\nFound ${results.length} candidate files.`);
        console.log('Top candidates:', results.slice(0, 10));
        return results;
    };

    const results = await ContextGatherer.gatherContext({
        query,
        workspaceRoot,
        limit: 5
    });
    
    console.log('\n--- RESULTS ---');
    if (results.length === 0) {
        console.log('No results found.');
    } else {
        results.forEach((res, i) => {
            console.log(`[${i}] ${res}`);
        });
    }
}

main().catch(console.error);
