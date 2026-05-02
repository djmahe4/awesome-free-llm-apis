import { extractLocalSkill } from '../src/middleware/agentic/agentic-middleware.js';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';

async function test() {
    const tempDir = path.join(os.tmpdir(), `test-skills-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    console.log(`Testing in ${tempDir}`);
    
    const mockResponse = `
## Enhanced Docker Setup
This is a high-signal architectural decision.

**Decisions:**
- **Standardized image:** Use node:20-slim
- - [x] Implement healthcheck
- - ✅ Optimized layer caching

**Pattern:**
We should always use multi-stage builds.

\`\`\`bash scripts/setup-docker.sh
#!/bin/bash
docker build -t my-app .
\`\`\`

\`\`\`python scripts/validate.py
print("Validating build...")
\`\`\`
`;

    const sessionId = 'test-session-123';
    
    try {
        await extractLocalSkill(tempDir, sessionId, mockResponse);
        
        const skillPath = path.join(tempDir, '.free-llm-mcp', 'skills', 'enhanced-docker-setup');
        const skillMd = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');
        const script1 = await fs.readFile(path.join(skillPath, 'scripts', 'setup-docker.sh'), 'utf-8');
        const script2 = await fs.readFile(path.join(skillPath, 'scripts', 'validate.py'), 'utf-8');
        
        console.log('--- SKILL.md ---');
        console.log(skillMd);
        console.log('--- setup-docker.sh ---');
        console.log(script1);
        console.log('--- validate.py ---');
        console.log(script2);
        
        console.log('\nSUCCESS: Skill and scripts extracted correctly.');
    } catch (err) {
        console.error('FAILED:', err);
    } finally {
        // Clean up
        // await fs.rm(tempDir, { recursive: true });
    }
}

test();
