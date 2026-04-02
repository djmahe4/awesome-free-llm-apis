/**
 * code_mode Compression Benchmark
 * =================================
 * Compares the context size (bytes) of raw API responses versus the compressed
 * output produced by code_mode scripts across realistic scenarios.
 *
 * The core insight: only print() / console.log() output enters the LLM context —
 * never the full raw DATA payload. This benchmark quantifies the savings.
 *
 * Run:  cd mcp-server && npx vitest bench benchmarks/code-mode.bench.ts
 *
 * Scenarios covered:
 *   1. Chat completions    — extract first message content
 *   2. Model list          — extract names + availability flags
 *   3. Token stats         — extract provider name + usage only
 *   4. Embeddings array    — compute summary stats instead of raw floats
 *   5. Search results      — extract titles + snippets only
 */

import { bench, describe } from 'vitest';
import { executeInSandbox } from '../src/sandbox/executor.js';

// ---------------------------------------------------------------------------
// Scenario 1 — Chat Completions Response (large multi-choice response)
// ---------------------------------------------------------------------------
const chatCompletionResponse = JSON.stringify({
  id: 'chatcmpl-abc123',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o',
  choices: Array.from({ length: 50 }, (_, i) => ({
    index: i,
    message: {
      role: 'assistant',
      content: `Response ${i}: ${'token '.repeat(80)}`.trim(),
    },
    finish_reason: 'stop',
  })),
  usage: { prompt_tokens: 500, completion_tokens: 4000, total_tokens: 4500 },
});

const chatExtractionCode = `
  var resp = JSON.parse(DATA);
  var first = resp.choices[0].message.content.slice(0, 200);
  print(JSON.stringify({ model: resp.model, preview: first, total_tokens: resp.usage.total_tokens }));
`;

// ---------------------------------------------------------------------------
// Scenario 2 — Model List (62+ models with full metadata)
// ---------------------------------------------------------------------------
const modelListResponse = JSON.stringify({
  models: Array.from({ length: 62 }, (_, i) => ({
    providerId: ['groq', 'gemini', 'cohere', 'openrouter', 'mistral'][i % 5],
    modelId: `model-${i}-instruct`,
    modelName: `Model ${i} Instruct (7B)`,
    available: i % 7 !== 0,
    rateLimits: { rpm: 30, rpd: 14400, tpm: 200000 },
    contextWindow: 131072,
    description: `A fine-tuned instruction-following model variant number ${i} optimized for chat.`,
    tags: ['free', 'instruction', 'chat'],
  })),
  summary: { total: 62, available: 55, unavailable: 7 },
});

const modelExtractionCode = `
  var data = JSON.parse(DATA);
  var available = data.models.filter(function(m) { return m.available; });
  var lines = available.map(function(m) { return m.providerId + '/' + m.modelId; });
  print(lines.join('\\n'));
  print('--- Total available: ' + available.length);
`;

// ---------------------------------------------------------------------------
// Scenario 3 — Token Stats (15 providers × full provider objects)
// ---------------------------------------------------------------------------
const tokenStatsResponse = JSON.stringify(
  Array.from({ length: 15 }, (_, i) => ({
    id: `provider-${i}`,
    name: `Provider ${i} (AI Services)`,
    isAvailable: i % 4 !== 0,
    rateLimits: { rpm: 30 + i * 2, rpd: 14400 + i * 100, tpm: 200000 },
    usage: { tokens: i * 1234, requests: i * 17 },
    config: {
      baseURL: `https://api.provider${i}.com/v1/`,
      apiKeyEnv: `PROVIDER_${i}_API_KEY`,
      timeout: 30000,
      retries: 3,
    },
    models: Array.from({ length: 4 }, (_, j) => ({
      id: `provider-${i}-model-${j}`,
      name: `Model ${j}`,
      contextWindow: 128000,
    })),
  }))
);

const tokenStatsExtractionCode = `
  var providers = JSON.parse(DATA);
  var active = providers.filter(function(p) { return p.isAvailable; });
  active.forEach(function(p) {
    print(p.name + ': ' + p.usage.tokens + ' tokens, ' + p.usage.requests + ' requests');
  });
`;

// ---------------------------------------------------------------------------
// Scenario 4 — Embeddings Array (1536-dim float vector)
// ---------------------------------------------------------------------------
const embeddingsResponse = JSON.stringify({
  object: 'list',
  data: [{
    object: 'embedding',
    embedding: Array.from({ length: 1536 }, () => Math.random() * 2 - 1),
    index: 0,
  }],
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: 12, total_tokens: 12 },
});

const embeddingsExtractionCode = `
  var resp = JSON.parse(DATA);
  var vec = resp.data[0].embedding;
  var sum = 0; var min = Infinity; var max = -Infinity;
  for (var i = 0; i < vec.length; i++) {
    sum += vec[i];
    if (vec[i] < min) min = vec[i];
    if (vec[i] > max) max = vec[i];
  }
  print(JSON.stringify({
    model: resp.model,
    dimensions: vec.length,
    mean: (sum / vec.length).toFixed(6),
    min: min.toFixed(6),
    max: max.toFixed(6)
  }));
`;

// ---------------------------------------------------------------------------
// Scenario 5 — Search Results (20 results with full HTML snippets)
// ---------------------------------------------------------------------------
const searchResultsResponse = JSON.stringify({
  query: 'free LLM APIs 2024',
  total: 20,
  results: Array.from({ length: 20 }, (_, i) => ({
    title: `Free LLM API Guide ${i + 1} — Best Practices`,
    url: `https://example.com/guide/${i + 1}`,
    snippet: `This comprehensive guide covers the best free LLM APIs available in 2024. ${'Learn how to use, integrate, and optimize free language models for your projects. '.repeat(5)}`.trim(),
    publishedAt: `2024-0${(i % 9) + 1}-15`,
    score: 0.95 - i * 0.02,
    metadata: { author: `Author ${i}`, tags: ['llm', 'api', 'free'], readTime: '5 min' },
  })),
});

const searchExtractionCode = `
  var resp = JSON.parse(DATA);
  resp.results.slice(0, 5).forEach(function(r, i) {
    print((i+1) + '. ' + r.title + ' (' + r.url + ')');
    print('   Score: ' + r.score.toFixed(2) + ' | ' + r.publishedAt);
  });
`;

// ---------------------------------------------------------------------------
// Helper: print size comparison (runs once before benchmarks)
// ---------------------------------------------------------------------------
async function printCompressionStats() {
  const scenarios = [
    { name: 'Chat Completions', data: chatCompletionResponse, code: chatExtractionCode },
    { name: 'Model List', data: modelListResponse, code: modelExtractionCode },
    { name: 'Token Stats', data: tokenStatsResponse, code: tokenStatsExtractionCode },
    { name: 'Embeddings (1536-dim)', data: embeddingsResponse, code: embeddingsExtractionCode },
    { name: 'Search Results', data: searchResultsResponse, code: searchExtractionCode },
  ];

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║          code_mode Context Compression — Before vs After            ║');
  console.log('╠══════════════════════════╦══════════╦══════════╦════════╦═══════════╣');
  console.log('║ Scenario                 ║ Raw (KB) ║ Out (KB) ║ Ratio  ║ Savings   ║');
  console.log('╠══════════════════════════╬══════════╬══════════╬════════╬═══════════╣');

  for (const s of scenarios) {
    const result = await executeInSandbox(s.code, s.data, 5000);
    const rawKb = (s.data.length / 1024).toFixed(1).padStart(8);
    const outKb = (result.stdout.length / 1024).toFixed(1).padStart(8);
    const ratio = result.stdout.length / s.data.length;
    const savings = ((1 - ratio) * 100).toFixed(0) + '%';
    const ratioStr = ratio.toFixed(3).padStart(6);
    const name = s.name.padEnd(24);
    console.log(`║ ${name} ║ ${rawKb} ║ ${outKb} ║ ${ratioStr} ║ ${savings.padStart(9)} ║`);
  }

  console.log('╚══════════════════════════╩══════════╩══════════╩════════╩═══════════╝\n');
}

// Run stats once at module load (vitest bench mode)
printCompressionStats().catch(console.error);

// ---------------------------------------------------------------------------
// Benchmark suites
// ---------------------------------------------------------------------------

describe('Scenario 1 — Chat Completions', () => {
  bench('raw response in context (no code_mode)', () => {
    // Simulates passing full response directly — just measure size
    const _size = chatCompletionResponse.length;
  });

  bench('code_mode: extract first message (JavaScript/QuickJS)', async () => {
    await executeInSandbox(chatExtractionCode, chatCompletionResponse, 5000, 'javascript');
  });
});

describe('Scenario 2 — Model List', () => {
  bench('raw response in context (no code_mode)', () => {
    const _size = modelListResponse.length;
  });

  bench('code_mode: extract names + availability (JavaScript/QuickJS)', async () => {
    await executeInSandbox(modelExtractionCode, modelListResponse, 5000, 'javascript');
  });
});

describe('Scenario 3 — Token Stats', () => {
  bench('raw response in context (no code_mode)', () => {
    const _size = tokenStatsResponse.length;
  });

  bench('code_mode: extract provider name + usage (JavaScript/QuickJS)', async () => {
    await executeInSandbox(tokenStatsExtractionCode, tokenStatsResponse, 5000, 'javascript');
  });
});

describe('Scenario 4 — Embeddings Array', () => {
  bench('raw response in context (no code_mode)', () => {
    const _size = embeddingsResponse.length;
  });

  bench('code_mode: compute summary stats (JavaScript/QuickJS)', async () => {
    await executeInSandbox(embeddingsExtractionCode, embeddingsResponse, 5000, 'javascript');
  });
});

describe('Scenario 5 — Search Results', () => {
  bench('raw response in context (no code_mode)', () => {
    const _size = searchResultsResponse.length;
  });

  bench('code_mode: extract top-5 titles + URLs (JavaScript/QuickJS)', async () => {
    await executeInSandbox(searchExtractionCode, searchResultsResponse, 5000, 'javascript');
  });
});
