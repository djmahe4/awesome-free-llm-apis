import { Middleware, PipelineContext, NextFunction, TaskType } from '../middleware.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { listLocalModels, chatLocal } from '../../providers/ollama-local.js';
import type { ChatResponse } from '../../providers/types.js';

export class MediaRouterMiddleware implements Middleware {
  name = 'MediaRouterMiddleware';

  async execute(context: PipelineContext, next: NextFunction): Promise<void> {
    const isMediaTask =
      context.taskType === TaskType.Media ||
      context.request.messages.some((m) => typeof m.content === 'string' && m.content.includes('[MEDIA_PIPELINE]'));

    if (!isMediaTask) {
      return next();
    }

    try {
      const response = await this.routeDirector(context);
      if (response) {
        context.response = response;
        return;
      }
    } catch (err: any) {
      if (process.env.DEBUG) {
        console.error('[MediaRouterMiddleware] Error routing media task:', err.message);
      }
    }

    // Fall through to next middleware if media routing fails
    return next();
  }

  private async routeDirector(context: PipelineContext): Promise<ChatResponse | undefined> {
    const registry = ProviderRegistry.getInstance();

    // 1. Try local Ollama first for zero-cost offline scripting
    try {
      const localModels = await listLocalModels();
      const directorModel = localModels.find((m) => m.includes('qwen') || m.includes('llama') || m.includes('coder'));
      if (directorModel) {
        const lastMsg = context.request.messages[context.request.messages.length - 1]?.content || '';
        const res = await chatLocal(directorModel, [
          { role: 'system', content: 'You are AgenticDirector for movie_tool. Coordinate timeline slots and media planning.' },
          { role: 'user', content: typeof lastMsg === 'string' ? lastMsg : JSON.stringify(lastMsg) }
        ]);
        return {
          id: `local-${Date.now()}`,
          object: 'chat.completion',
          created: Date.now(),
          model: `ollama-local:${res.model}`,
          choices: [{ index: 0, message: { role: 'assistant', content: res.content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: res.promptTokens, completion_tokens: res.completionTokens, total_tokens: res.promptTokens + res.completionTokens }
        };
      }
    } catch {
      // Local Ollama offline, proceed to cloud providers
    }

    // 2. Groq fallback (fast frontier reasoning)
    const groq = registry.getProvider('groq');
    if (groq && groq.isAvailable()) {
      const model = groq.models[0]?.id || 'openai/gpt-oss-120b';
      const maxTokens = Math.max(context.request.max_tokens || 0, 500);
      try {
        const res = await groq.chat({ ...context.request, model, max_tokens: maxTokens });
        // Handle reasoning models where output might reside in reasoning field or content
        const choice = res.choices[0];
        const msg = choice?.message as any;
        if (msg && !msg.content && msg.reasoning) {
          msg.content = msg.reasoning;
        }
        return res;
      } catch (err: any) {
        if (process.env.DEBUG) {
          console.error('[MediaRouterMiddleware] Groq route failed:', err.message);
        }
      }
    }

    // 3. Gemini fallback (gemini-3.5-flash-lite primary, gemini-3.1-flash-lite secondary)
    const gemini = registry.getProvider('gemini');
    if (gemini && gemini.isAvailable()) {
      try {
        return await gemini.chat({ ...context.request, model: 'gemini-3.5-flash-lite' });
      } catch (err: any) {
        if (process.env.DEBUG) {
          console.error('[MediaRouterMiddleware] Gemini 3.5 route failed, trying 3.1:', err.message);
        }
        try {
          return await gemini.chat({ ...context.request, model: 'gemini-3.1-flash-lite' });
        } catch (e: any) {
          if (process.env.DEBUG) {
            console.error('[MediaRouterMiddleware] Gemini 3.1 fallback failed:', e.message);
          }
        }
      }
    }

    return undefined;
  }
}
