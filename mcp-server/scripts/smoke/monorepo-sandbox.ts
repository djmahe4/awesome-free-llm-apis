import fs from 'fs-extra';
import path from 'node:path';

export class MonorepoSandbox {
    public workspaceRoot: string;
    
    constructor() {
        const timestamp = Date.now();
        this.workspaceRoot = path.resolve(process.cwd(), `scratch/smoke_monorepo_${timestamp}`);
    }

    async setup(): Promise<void> {
        await fs.ensureDir(this.workspaceRoot);

        // 1. Create directory structure
        const apiSrcDir = path.join(this.workspaceRoot, 'packages/api/src');
        const webSrcDir = path.join(this.workspaceRoot, 'packages/web/src');
        const sharedSrcDir = path.join(this.workspaceRoot, 'packages/shared/src');
        const docsDir = path.join(this.workspaceRoot, 'docs');

        await fs.ensureDir(apiSrcDir);
        await fs.ensureDir(webSrcDir);
        await fs.ensureDir(sharedSrcDir);
        await fs.ensureDir(docsDir);

        // 2. Seed packages/api/src/server.ts (technical debt & security flaws)
        const serverCode = `
import express from 'express';
import pg from 'pg';
import fetch from 'node-fetch';

const app = express();
const dbClient = new pg.Client({ connectionString: process.env.DATABASE_URL });

// Hardcoded credential
const DB_PASSWORD = "super_secret_db_password_12345"; 

app.get('/user/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        // Direct SQL string concatenation (SQL Injection)
        const query = "SELECT * FROM users WHERE id = '" + userId + "'";
        const result = await dbClient.query(query);
        res.json(result.rows);
    } catch (e) {
        // Bare catch block with silent failure
    }
});

app.get('/external-status', async (req, res) => {
    try {
        // HTTP request without timeout
        const response = await fetch('https://api.external.service/status');
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'External service failed' });
    }
});

// Infinite recursion loop
function recursiveCalculate(n: number): number {
    return recursiveCalculate(n - 1) + 1;
}

app.get('/recurse', (req, res) => {
    res.json({ result: recursiveCalculate(10) });
});

app.listen(3000);
`.trim();

        await fs.writeFile(path.join(apiSrcDir, 'server.ts'), serverCode);

        // 3. Seed packages/shared/src/utils.ts
        const utilsCode = `
export function formatResponse(data: any) {
    return {
        success: true,
        data,
        timestamp: Date.now()
    };
}
`.trim();
        await fs.writeFile(path.join(sharedSrcDir, 'utils.ts'), utilsCode);

        // 4. Seed docs/release-checklists.md
        const docCode = `
# Release Checklist

All deployments to staging/production must adhere to these rules:
1. No hardcoded database credentials.
2. All SQL queries must use parameterized inputs (no string concatenation).
3. All external HTTP requests must specify a timeout.
`.trim();
        await fs.writeFile(path.join(docsDir, 'release-checklists.md'), docCode);

        // 5. Seed root package.json
        const rootPackageJson = {
            name: "smoke-test-monorepo",
            version: "1.0.0",
            private: true,
            workspaces: [
                "packages/*"
            ]
        };
        await fs.writeJson(path.join(this.workspaceRoot, 'package.json'), rootPackageJson, { spaces: 2 });

        // 6. Seed root tsconfig.json
        const tsConfig = {
            compilerOptions: {
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                esModuleInterop: true,
                strict: true,
                skipLibCheck: true
            }
        };
        await fs.writeJson(path.join(this.workspaceRoot, 'tsconfig.json'), tsConfig, { spaces: 2 });

        // 7. Seed README.md
        await fs.writeFile(path.join(this.workspaceRoot, 'README.md'), '# Smoke Test Monorepo\nThis is a mock workspace sandbox.');
    }

    async cleanup(): Promise<void> {
        if (await fs.pathExists(this.workspaceRoot)) {
            await fs.remove(this.workspaceRoot);
        }
    }
}
