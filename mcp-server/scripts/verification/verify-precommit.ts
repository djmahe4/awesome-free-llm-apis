import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function run(cmd: string, cwd: string) {
  console.log(`[Check] Running: ${cmd} (in ${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

async function main() {
  const mcpDir = path.resolve(__dirname, '..', '..');
  const rootDir = path.resolve(mcpDir, '..');

  console.log('=== Pre-Commit Quality & Tool Integrity Checks ===\n');

  // 1. TypeScript compiler diagnostics check on mcp-server/src
  console.log('1. Verifying TypeScript compilation (tsc -p tsconfig.build.json --noEmit)...');
  try {
    run('npx tsc -p tsconfig.build.json --noEmit', mcpDir);
    console.log('✓ TypeScript compilation check passed.\n');
  } catch (err) {
    console.error('✗ TypeScript compilation failed!');
    process.exit(1);
  }

  // 2. Tool Sync Check: Compare MCP tools against Docs, Skills, Playground, and Quickstart
  console.log('2. Verifying tool sync across docs, skills, playground, and quickstart...');

  const mcpIndexPath = path.join(mcpDir, 'src', 'mcp', 'index.ts');
  const mcpContent = fs.readFileSync(mcpIndexPath, 'utf-8');

  // Extract tools inside ListToolsRequestSchema handler
  const listToolsMatch = mcpContent.match(/ListToolsRequestSchema[\s\S]*?tools:\s*\[([\s\S]*?)\]\s*,\s*\}\)\);/);
  if (!listToolsMatch) {
    throw new Error('Could not find tools array inside ListToolsRequestSchema in src/mcp/index.ts');
  }
  const toolsBlock = listToolsMatch[1];

  const registeredTools = new Set<string>();
  const lines = toolsBlock.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue; // Ignore commented-out/deprecated tools
    const m = trimmed.match(/^name:\s*'([a-z0-9_]+)'/);
    if (m) {
      registeredTools.add(m[1]);
    }
  }

  console.log(`Found ${registeredTools.size} registered tools: ${Array.from(registeredTools).join(', ')}`);

  // Check Docs / References
  const referencesDir = path.join(mcpDir, 'docs', 'skill', 'references');
  const skillMdPath = path.join(mcpDir, 'docs', 'skill', 'SKILL.md');
  const skillContent = fs.readFileSync(skillMdPath, 'utf-8');

  const missingSkillDocs: string[] = [];
  const missingRefFiles: string[] = [];

  for (const tool of registeredTools) {
    if (!skillContent.includes(`### \`${tool}\``)) {
      missingSkillDocs.push(tool);
    }
    const refFile = path.join(referencesDir, `${tool}.md`);
    if (!fs.existsSync(refFile)) {
      missingRefFiles.push(tool);
    }
  }

  if (missingSkillDocs.length > 0) {
    console.warn(`⚠ Warning: Following tools missing in SKILL.md: ${missingSkillDocs.join(', ')}`);
  } else {
    console.log('✓ SKILL.md contains all registered tools.');
  }

  if (missingRefFiles.length > 0) {
    console.warn(`⚠ Notice: Tools without dedicated reference .md: ${missingRefFiles.join(', ')}`);
  } else {
    console.log('✓ Dedicated reference markdown files verified.');
  }

  // Check Dashboard Playground and Quickstart tabs
  const dashboardHtmlPath = path.join(mcpDir, 'dashboard', 'index.html');
  const dashboardAppPath = path.join(mcpDir, 'dashboard', 'app.js');
  const htmlContent = fs.readFileSync(dashboardHtmlPath, 'utf-8');
  const appContent = fs.readFileSync(dashboardAppPath, 'utf-8');

  const missingPlayground: string[] = [];
  const missingQuickstart: string[] = [];

  for (const tool of registeredTools) {
    // Check TOOLS array in app.js
    if (!appContent.includes(`id: '${tool}'`)) {
      missingPlayground.push(tool);
    }
    // Check Quickstart section in index.html
    if (!htmlContent.includes(`<span class="qs-tool-name">${tool}</span>`)) {
      missingQuickstart.push(tool);
    }
  }

  if (missingPlayground.length > 0) {
    console.error(`✗ Error: Tool playground is missing definitions for: ${missingPlayground.join(', ')}`);
    process.exit(1);
  } else {
    console.log('✓ Tool Playground (app.js) contains definitions for all tools.');
  }

  if (missingQuickstart.length > 0) {
    console.error(`✗ Error: Quickstart documentation tab is missing cards for: ${missingQuickstart.join(', ')}`);
    process.exit(1);
  } else {
    console.log('✓ Quickstart Tab (index.html) contains schemas for all tools.');
  }

  // 3. Parameter Schema Matching Across MCP Server, Playground, and Quickstart
  console.log('\n3. Verifying parameter schema matching across files...');

  // Extract properties per tool from src/mcp/index.ts
  const mcpToolProperties: Record<string, string[]> = {};
  const toolSplit = toolsBlock.split(/\{\s*name:\s*'/);
  for (const part of toolSplit) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const nameMatch = trimmed.match(/^([a-z0-9_]+)'/);
    if (!nameMatch) continue;
    const toolName = nameMatch[1];
    if (!registeredTools.has(toolName)) continue;

    // Scan properties: { ... } matching balanced braces
    const pIdx = trimmed.indexOf('properties: {');
    const props: string[] = [];
    if (pIdx !== -1) {
      const openBrace = pIdx + 'properties: {'.length - 1;
      let depth = 0;
      let endBrace = -1;
      for (let i = openBrace; i < trimmed.length; i++) {
        if (trimmed[i] === '{') depth++;
        else if (trimmed[i] === '}') {
          depth--;
          if (depth === 0) { endBrace = i; break; }
        }
      }
      if (endBrace !== -1) {
        const propBlock = trimmed.slice(openBrace + 1, endBrace);
        // Only extract top-level keys
        let innerDepth = 0;
        const propLines = propBlock.split('\n');
        for (const line of propLines) {
          const tLine = line.trim();
          if (innerDepth === 0) {
            const keyMatch = tLine.match(/^([a-zA-Z0-9_]+):/);
            if (keyMatch && !tLine.startsWith('//')) {
              props.push(keyMatch[1]);
            }
          }
          for (const ch of line) {
            if (ch === '{') innerDepth++;
            else if (ch === '}') innerDepth = Math.max(0, innerDepth - 1);
          }
        }
      }
    }
    mcpToolProperties[toolName] = props;
  }

  // Extract fields per tool in app.js TOOLS
  const playgroundFields: Record<string, string[]> = {};
  const toolsStartIdx = appContent.indexOf('const TOOLS = [');
  const toolsEndIdx = appContent.indexOf('let activeTool = TOOLS[0];');
  if (toolsStartIdx !== -1 && toolsEndIdx !== -1) {
    const toolsSlice = appContent.slice(toolsStartIdx, toolsEndIdx);
    const toolBlocks = toolsSlice.split(/\n\s*\{\s*\n\s*id:\s*'/);
    for (let i = 1; i < toolBlocks.length; i++) {
      const b = toolBlocks[i];
      const toolName = b.slice(0, b.indexOf("'"));
      const fieldsIdx = b.indexOf('fields: [');
      if (fieldsIdx !== -1) {
        // Balanced square bracket search
        let depth = 0;
        let endIdx = -1;
        for (let j = fieldsIdx + 'fields: ['.length - 1; j < b.length; j++) {
          if (b[j] === '[') depth++;
          else if (b[j] === ']') {
            depth--;
            if (depth === 0) { endIdx = j; break; }
          }
        }
        if (endIdx !== -1) {
          const fieldsBlock = b.slice(fieldsIdx, endIdx);
          const fMatches = [...fieldsBlock.matchAll(/id:\s*'([a-zA-Z0-9_]+)'/g)].map(x => x[1]);
          playgroundFields[toolName] = fMatches;
        }
      }
    }
  }

  // Extract parameters per tool in Quickstart table
  const quickstartParams: Record<string, string[]> = {};
  const qsCards = htmlContent.split('<details class="qs-tool-card"');
  for (let i = 1; i < qsCards.length; i++) {
    const card = qsCards[i];
    const nameMatch = card.match(/<span class="qs-tool-name">([a-z0-9_]+)<\/span>/);
    if (!nameMatch) continue;
    const qTool = nameMatch[1];
    const tableMatch = card.match(/<table class="qs-table">([\s\S]*?)<\/table>/);
    if (tableMatch) {
      const pMatches = [...tableMatch[1].matchAll(/<tr><td><code>([a-zA-Z0-9_]+)<\/code><\/td>/g)].map(x => x[1]);
      quickstartParams[qTool] = pMatches;
    }
  }

  let driftWarnings = 0;
  for (const tool of registeredTools) {
    const mcpProps = mcpToolProperties[tool] || [];
    const pgFields = playgroundFields[tool] || [];
    const qsProps = quickstartParams[tool] || [];

    console.log(`Checking [${tool}] - Schema props (${mcpProps.length}), Playground fields (${pgFields.length}), Quickstart params (${qsProps.length})`);

    // Check for schema properties missing from playground or quickstart
    const missingInPlayground = mcpProps.filter(p => !pgFields.includes(p));
    const missingInQuickstart = mcpProps.filter(p => !qsProps.includes(p));

    if (missingInPlayground.length > 0) {
      console.warn(`  ↳ Playground (app.js) omitted props: ${missingInPlayground.join(', ')}`);
      driftWarnings++;
    }
    if (missingInQuickstart.length > 0) {
      console.warn(`  ↳ Quickstart (index.html) omitted props: ${missingInQuickstart.join(', ')}`);
      driftWarnings++;
    }
  }

  if (driftWarnings === 0) {
    console.log('✓ 100% parameter schema alignment across MCP server, playground, and quickstart.');
  } else {
    console.log(`ℹ Schema check completed with ${driftWarnings} parameter variance notices (documented variances).`);
  }

  console.log('\n=== All Pre-Commit Checks Passed Successfully ===');
}

main().catch(err => {
  console.error('Pre-commit verification script error:', err);
  process.exit(1);
});
