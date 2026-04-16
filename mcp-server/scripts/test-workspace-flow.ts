import path from 'node:path';
import fs from 'fs-extra';
import { StructuralMarkdownMiddleware } from '../src/middleware/agentic/structural-middleware.js';
import { PipelineContext } from '../src/pipeline/middleware.js';

/**
 * TEST WORKSPACE FLOW
 * 
 * This script demonstrates how the MCP server handles agentic requests in a workspace environment.
 * It shows that the server does NOT apply changes directly, but rather provides the LLM with
 * the full file context and mandates a specific response format for the orchestrator to apply.
 */

async function main() {
    console.log('\n🚀 --- Workspace Flow Verification ---\n');

    const sessionId = 'demo-test-workspace';
    const projectDir = path.join(process.cwd(), 'data', 'projects', sessionId);
    const knowledgePath = path.join(projectDir, 'knowledge.md');

    // 1. Setup Mock Workspace Environment
    console.log(`Setting up mock workspace: ${projectDir}`);
    await fs.ensureDir(projectDir);

    const mockCode = `
# PROJECT FILES

## file: main.py
\`\`\`python
def main():
    print("Hello, World!")

if __name__ == "__main__":
    main()
\`\`\`

## file: utils.py
\`\`\`python
def helper():
    return True
\`\`\`
`.trim();

    await fs.writeFile(knowledgePath, mockCode);
    console.log('✅ Mock memory seeded in knowledge.md\n');

    // 2. Prepare Pipeline Context
    const middleware = new StructuralMarkdownMiddleware();
    const context: PipelineContext = {
        request: {
            messages: [
                { role: 'user', content: 'Add a new function called "greet" to main.py that takes a name and prints it.' }
            ],
            agentic: true
        },
        sessionId: sessionId,
        workspaceRoot: process.cwd()
    };

    // 3. Execute Middleware
    console.log('Executing StructuralMarkdownMiddleware...');
    await middleware.execute(context, async () => {
        console.log('✅ Middleware execution complete.\n');
    });

    // 4. Inspect Result
    const userMsg = context.request.messages[0];
    console.log('--- FINAL USER MESSAGE TO LLM ---');
    console.log('---------------------------------');
    console.log(userMsg.content);
    console.log('---------------------------------');

    console.log('\n💡 OBSERVATIONS:');
    console.log('1. The LLM now sees the FULL memory of the workspace (main.py and utils.py).');
    console.log('2. The LLM is given strict instructions on the RESPONSE FORMAT.');
    console.log('3. The MCP server DOES NOT update files on disk. It remains a stateless tool.');
    console.log('4. The Agent (e.g. Antigravity) receives the markdown and is responsible for applying the changes.');

    // 5. Cleanup (optional)
    // await fs.remove(projectDir);
}

main().catch(err => {
    console.error('FAIL:', err);
    process.exit(1);
});
