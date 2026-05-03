/**
 * @file test-workspace-walker.ts
 * @description Tests the recursive workspace walker's ability to discover and index project files.
 * Usage: tsx scripts/verification/test-workspace-walker.ts
 */
import { WorkspaceWalker } from '../../src/middleware/agentic/workspace-walker.js';
import path from 'path';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testWalker() {
    console.log('Testing WorkspaceWalker...');
    
    const rootPath = path.resolve(__dirname, '..');
    const keywords = ['agentic', 'middleware', 'prompt', 'constants'];
    
    console.log(`Scanning: ${rootPath}`);
    console.log(`Keywords: ${keywords.join(', ')}`);
    
    const start = Date.now();
    const files = await WorkspaceWalker.findRelevantFiles(rootPath, keywords, 10);
    const duration = Date.now() - start;
    
    console.log(`\nFound ${files.length} candidate files in ${duration}ms:`);
    files.forEach((f, i) => {
        console.log(`${i + 1}. ${path.relative(rootPath, f)}`);
    });
    
    // Validations
    if (files.length === 0) {
        console.error('FAILED: No files found!');
        process.exit(1);
    }
    
    const topFile = path.basename(files[0]).toLowerCase();
    if (topFile.includes('agentic') || topFile.includes('middleware') || topFile.includes('constants')) {
        console.log('\nSUCCESS: Top ranked file matches keywords.');
    } else {
        console.warn('\nWARNING: Top ranked file does not contain primary keywords.');
    }
}

testWalker().catch(console.error);
