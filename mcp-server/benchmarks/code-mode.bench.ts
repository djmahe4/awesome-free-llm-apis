/**
 * Agentic Pipeline & Code Mode Benchmarks (with Persistence)
 * ==========================================================
 * Measures the compression efficiency and qualitative "intelligence" of the entire agentic pipeline.
 * Results are printed to console AND persisted to `mcp-server/benchmarks/logs/latest_run.md`.
 *
 * Scenarios:
 * 1. Prompt Injection (getIntelligentSystemPrompt via agent-prompt/README.md)
 * 2. Token Compression & Summarization (ContextManager sliding-window)
 * 3. Short/Long Term Memory boundaries
 * 4. Sandbox Code Extraction (code_mode JavaScript parsing)
 *
 * Run:  cd mcp-server && npx vitest bench benchmarks/code-mode.bench.ts
 */

import { bench, describe, beforeEach, afterAll } from 'vitest';
import { getIntelligentSystemPrompt, resetPromptCache } from '../src/middleware/agentic/prompts.js';
import { ContextManager } from '../src/utils/ContextManager.js';
import { executeInSandbox } from '../src/sandbox/executor.js';
import type { Message } from '../src/providers/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getEncoding } from 'js-tiktoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const enc = getEncoding("cl100k_base");
const countTokens = (text: string) => enc.encode(text).length;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const stats: any[] = [];
let logContent = `# Agentic Benchmark Qualitative Log\n\nGenerated on: ${new Date().toISOString()}\n\n---\n\n`;

describe('Agentic Intelligence & Compression Pipelines', () => {

  beforeEach(async () => {
    // Enforce 10s delay to respect provider rate limits (RPM/TPM)
    console.log('\n[Rate Limit Guard] Waiting 10 seconds...');
    await delay(10000);
  });

  afterAll(() => {
    // Prepare console report
    console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║        Agentic Context Compression & Memory Pipeline Results        ║');
    console.log('╠══════════════════════════╦══════════╦══════════╦════════╦═══════════╣');
    console.log('║ Scenario                 ║ In (Tok) ║ Out(Tok) ║ Ratio  ║ Savings   ║');
    console.log('╠══════════════════════════╬══════════╬══════════╬════════╬═══════════╣');

    logContent += `## Quantitative Summary\n\n| Scenario | In (Tok) | Out (Tok) | Ratio | Savings |\n| :--- | :--- | :--- | :--- | :--- |\n`;

    for (const s of stats) {
      const raw = s.inTokens.toString().padStart(8);
      const out = s.outTokens.toString().padStart(8);
      const ratio = (s.outTokens / s.inTokens);
      const savings = ((1 - ratio) * 100).toFixed(0) + '%';
      const ratioStr = ratio.toFixed(3).padStart(6);
      const name = s.name.padEnd(24);
      console.log(`║ ${name} ║ ${raw} ║ ${out} ║ ${ratioStr} ║ ${savings.padStart(9)} ║`);

      logContent += `| ${s.name} | ${s.inTokens} | ${s.outTokens} | ${ratio.toFixed(3)} | ${savings} |\n`;
    }

    console.log('╚══════════════════════════╩══════════╩══════════╩════════╩═══════════╝\n');

    // Persist to log file
    const logDir = path.resolve(__dirname, '../benchmarks/logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const logPath = path.join(logDir, 'latest_run.md');
    fs.writeFileSync(logPath, logContent, 'utf-8');
    console.log(`[Persistence] Qualitative log written to: ${logPath}`);
  });

  bench('1. Intelligent Prompt Injection (README.md routing)', async () => {
    resetPromptCache();
    const rawReadmePath = path.resolve(__dirname, '../../external/agent-prompt/README.md');
    let rawReadmeContent = 'Fallback README content';
    if (fs.existsSync(rawReadmePath)) {
      rawReadmeContent = fs.readFileSync(rawReadmePath, 'utf-8');
    }

    const query = "Andru.ia Consultant: I need to research reference links for architecture evolution and system core components.";
    const optimizedPrompt = await getIntelligentSystemPrompt(query);

    logContent += `\n---\n\n## Scenario 1: Prompt Injection\n\n### Input Query\n> ${query}\n\n### Full Input Source (Preview)\n\`\`\`markdown\n${rawReadmeContent.substring(0, 1000)}...\n\`\`\`\n\n### Optimized Output Output\n\`\`\`markdown\n${optimizedPrompt}\n\`\`\`\n`;

    stats.push({
      name: 'Prompt Injection',
      inTokens: countTokens(rawReadmeContent),
      outTokens: countTokens(optimizedPrompt)
    });
  }, { iterations: 1 });

  bench('2. Memory Compression (ContextManager Sliding Window)', async () => {
    const contextManager = new ContextManager();
    const messages: Message[] = Array.from({ length: 150 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `[Message ${i}] The system architecture uses a layered approach. Component ${i} handles part of the workload. We must ensure memory safety and token efficiency in all agentic nodes.`
    }));

    const inTokens = contextManager.countTokens(messages);

    // Mock summarizer that simulates LLM reduction
    const mockSummarizer = async (text: string) => {
      return `SUMMARY OF ${countTokens(text)} TOKENS: The conversation discussed iterative system architecture, the importance of layered component design, and consistent requirements for memory safety and token-aware efficiency across all agentic nodes.`;
    };

    const result = await contextManager.slidingWindow(messages, 400, mockSummarizer);

    logContent += `\n---\n\n## Scenario 2: Memory Compression\n\n### Original Content (Preview)\n${messages.slice(0, 5).map(m => `- [${m.role}] ${m.content}`).join('\n')}\n...\n\n### Compressed State Output\n${result.messages.map(m => `- [${m.role}] ${m.content}`).join('\n')}\n`;

    stats.push({
      name: 'Memory Sliding Window',
      inTokens: inTokens,
      outTokens: result.compressedTokens
    });
  }, { iterations: 1 });

  bench('3. Sandbox Extraction (code_mode)', async () => {
    const responseData = JSON.stringify({
      output: `Here is the optimized coding logic for the pipeline:\n\n\`\`\`typescript\nexport const optimize = (data: any[]) => data.filter(d => d.active).map(d => ({ ...d, score: d.value * 1.5 }));\n\`\`\`\n\nAnd here is the deployment script:\n\n\`\`\`bash\nnpm run build && docker build -t server .\n\`\`\`\n\nPlease ignore the remaining fluff and verbose explanations.`
    });

    const inTokens = countTokens(responseData);

    const script = `
            var data = JSON.parse(DATA);
            var blocks = [];
            var regex = /\`\`\`[a-z]*\\n([\\s\\S]*?)\\n\`\`\`/g;
            var match;
            while ((match = regex.exec(data.output)) !== null) {
                blocks.push(match[1]);
            }
            print("EXTRACTED CODE BLOCKS:\\n" + blocks.join('\\n--- CODE BLOCK ---\\n'));
        `;

    const result = await executeInSandbox(script, { data: responseData, timeoutMs: 5000, language: 'javascript' });

    logContent += `\n---\n\n## Scenario 3: Sandbox Extraction (code_mode)\n\n### Raw LLM Response (Input)\n\`\`\`json\n${responseData}\n\`\`\`\n\n### Extracted Output (Sandbox Results)\n\`\`\`text\n${result.stdout}\n\`\`\`\n`;

    stats.push({
      name: 'Sandbox code_mode',
      inTokens: inTokens,
      outTokens: countTokens(result.stdout)
    });
  }, { iterations: 1 });

});
