import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mcpDir = path.resolve(__dirname, '..');
const partialsDir = path.join(mcpDir, 'dashboard', 'partials');
const targetPath = path.join(mcpDir, 'dashboard', 'index.html');

const partials = fs
  .readdirSync(partialsDir)
  .filter((f) => f.endsWith('.html'))
  .sort();

if (partials.length === 0) {
  console.error(`✗ No partials found in ${partialsDir}`);
  process.exit(1);
}

const assembled = partials
  .map((f) => fs.readFileSync(path.join(partialsDir, f), 'utf-8'))
  .join('');

const existing = fs.readFileSync(targetPath, 'utf-8');
// line endings depend on core.autocrlf on the machine; only the content decides whether the page is stale
const lf = (t: string) => t.replace(/\r\n/g, '\n');
const inSync = lf(assembled) === lf(existing);

if (process.argv.includes('--check')) {
  if (!inSync) {
    console.error('✗ dashboard/index.html is out of sync with dashboard/partials/ (run: npm run assemble:index)');
    process.exit(1);
  }
  console.log(`✓ dashboard/index.html matches assembled partials (${partials.length} files).`);
} else if (inSync) {
  console.log(`✓ dashboard/index.html already up to date (${partials.length} partials).`);
} else {
  fs.writeFileSync(targetPath, assembled);
  console.log(`✓ Rebuilt dashboard/index.html from ${partials.length} partials.`);
}
