import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function saveFixture(caseName: string, data: any): Promise<void> {
    if (process.env.RECORD_FIXTURES === 'false') return;
    
    try {
        const fixturesDir = path.join(__dirname, 'fixtures');
        await fs.mkdir(fixturesDir, { recursive: true });
        
        const fixturePath = path.join(fixturesDir, `${caseName}.json`);
        await fs.writeFile(fixturePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Fixture] Saved recorded output to: scripts/smoke/fixtures/${caseName}.json`);
    } catch (err: any) {
        console.error(`[Fixture] Failed to save fixture for ${caseName}: ${err.message}`);
    }
}
