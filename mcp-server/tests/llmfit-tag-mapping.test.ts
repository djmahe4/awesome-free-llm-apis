import { describe, it, expect } from 'vitest';
import { pickLlmfitMatch, ollamaTagKey } from '../src/services/llmfit.js';

const catalog = [
  { name: 'Qwen/Qwen2.5-Coder-7B-Instruct-GPTQ-Int4' },
  { name: 'Qwen/Qwen2.5-Coder-7B-Instruct' },
  { name: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
  { name: 'Qwen/Qwen2.5-VL-3B-Instruct' },
  { name: 'Qwen/Qwen2.5-VL-7B-Instruct' },
  { name: 'nomic-ai/nomic-embed-text-v1.5' },
  { name: 'BAAI/bge-m3' },
  { name: 'someorg/Qwythos-9B-Claude-Mythos-5-1M' },
];

describe('ollamaTagKey', () => {
  it('drops registry/org prefixes, the tag, GGUF and quant markers, and non-alphanumerics', () => {
    expect(ollamaTagKey('qwen2.5-coder:7b')).toBe('qwen25coder7b');
    expect(ollamaTagKey('qwen2.5vl:3b')).toBe('qwen25vl3b');
    expect(ollamaTagKey('nomic-embed-text:latest')).toBe('nomicembedtext');
    expect(ollamaTagKey('BGE-M3:latest')).toBe('bgem3');
    expect(ollamaTagKey('hf.co/empero-ai/Qwythos-9B-Claude-Mythos-5-1M-GGUF:Q4_K_M')).toBe('qwythos9bclaudemythos51m');
  });
});

describe('pickLlmfitMatch', () => {
  it('maps Ollama tags to the llmfit catalog entry, preferring the plain (non-quantized-variant) one', () => {
    expect(pickLlmfitMatch('qwen2.5-coder:7b', catalog)?.name).toBe('Qwen/Qwen2.5-Coder-7B-Instruct');
    expect(pickLlmfitMatch('qwen2.5vl:3b', catalog)?.name).toBe('Qwen/Qwen2.5-VL-3B-Instruct');
    expect(pickLlmfitMatch('nomic-embed-text:latest', catalog)?.name).toBe('nomic-ai/nomic-embed-text-v1.5');
    expect(pickLlmfitMatch('BGE-M3:latest', catalog)?.name).toBe('BAAI/bge-m3');
    expect(pickLlmfitMatch('hf.co/empero-ai/Qwythos-9B-Claude-Mythos-5-1M-GGUF:Q4_K_M', catalog)?.name).toBe('someorg/Qwythos-9B-Claude-Mythos-5-1M');
  });

  it('does not confuse sizes: 7b never matches the 32b entry, 3b never the 7b VL', () => {
    expect(pickLlmfitMatch('qwen2.5-coder:32b', catalog)?.name).toBe('Qwen/Qwen2.5-Coder-32B-Instruct');
    expect(pickLlmfitMatch('qwen2.5vl:7b', catalog)?.name).toBe('Qwen/Qwen2.5-VL-7B-Instruct');
  });

  it('returns null when nothing matches', () => {
    expect(pickLlmfitMatch('totally-unknown:1b', catalog)).toBeNull();
    expect(pickLlmfitMatch('', catalog)).toBeNull();
  });
});

import { catalogEntryToInfo } from '../src/services/llmfit.js';

describe('catalogEntryToInfo (fast path: no per-model llmfit subprocess)', () => {
  it('maps a `llmfit list` entry to model info', () => {
    const info = catalogEntryToInfo({
      name: 'Qwen/Qwen2.5-Coder-7B-Instruct', context_length: 32768, min_vram_gb: 3.9, quantization: 'Q4_K_M',
      use_case: 'Code generation and completion', parameter_count: '7.6B', capabilities: ['tool_use'],
    });
    expect(info).toMatchObject({ name: 'Qwen/Qwen2.5-Coder-7B-Instruct', contextLength: 32768, minVramGb: 3.9, bestQuant: 'Q4_K_M', useCase: 'Code generation and completion' });
  });
  it('tolerates missing fields', () => {
    expect(catalogEntryToInfo({ name: 'x/y' })).toMatchObject({ name: 'x/y', contextLength: undefined, minVramGb: undefined });
  });
});
