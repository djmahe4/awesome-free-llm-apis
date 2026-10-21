import { describe, it, expect, vi } from 'vitest';
import { MediaRouterMiddleware } from '../src/pipeline/middlewares/MediaRouterMiddleware.js';
import { TaskType, type PipelineContext } from '../src/pipeline/middleware.js';

describe('MediaRouterMiddleware', () => {
  it('bypasses non-media tasks', async () => {
    const middleware = new MediaRouterMiddleware();
    let nextCalled = false;
    const ctx: PipelineContext = {
      taskType: TaskType.Coding,
      request: { messages: [{ role: 'user', content: 'write code' }] }
    } as any;

    await middleware.execute(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(ctx.response).toBeUndefined();
  });

  it('routes TaskType.Media and populates context.response', async () => {
    const middleware = new MediaRouterMiddleware();
    const ctx: PipelineContext = {
      taskType: TaskType.Media,
      request: { messages: [{ role: 'user', content: 'Generate BGM for intro scene' }] }
    } as any;

    vi.spyOn(middleware as any, 'routeDirector').mockResolvedValue({
      id: 'mock-1',
      object: 'chat.completion',
      created: Date.now(),
      model: 'groq:mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Proposed slot: 0-30000ms' }, finish_reason: 'stop' }]
    });

    await middleware.execute(ctx, async () => {});
    expect(ctx.response).toBeDefined();
    expect(ctx.response?.choices[0].message.content).toContain('Proposed slot');
  });
});
