import { bench, describe } from 'vitest';
import { executeInSandbox } from '../src/sandbox/executor.js';

const largeApiResponse = JSON.stringify({
  id: 'chatcmpl-123',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o',
  choices: Array.from({ length: 50 }, (_, i) => ({
    index: i,
    message: {
      role: 'assistant',
      content: `This is response number ${i} with some content. `.repeat(20),
    },
    finish_reason: 'stop',
  })),
  usage: {
    prompt_tokens: 100,
    completion_tokens: 5000,
    total_tokens: 5100,
  },
});

describe('Code Mode Compression', () => {
  bench('direct response (no compression)', () => {
    const size = largeApiResponse.length;
  });

  bench('code mode (extract key fields)', async () => {
    const code = `
      var resp = JSON.parse(DATA);
      var first = resp.choices[0].message.content.slice(0, 100);
      print(JSON.stringify({ model: resp.model, preview: first, total: resp.usage.total_tokens }));
    `;
    await executeInSandbox(code, largeApiResponse, 5000);
  });
});
