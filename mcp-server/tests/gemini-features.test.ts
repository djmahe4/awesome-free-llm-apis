import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiProvider } from '../src/providers/gemini.js';
import { ChatRequest } from '../src/providers/types.js';

interface GeminiInternalRequest {
    model: string;
    messages: any[];
    stream: boolean;
    temperature?: number;
    response_format?: any;
    google_search?: boolean;
}

describe('Gemini Feature Verification', () => {
    let provider: GeminiProvider;

    beforeEach(() => {
        provider = new GeminiProvider();
        // Mock runPythonClient to avoid actual execution
        vi.spyOn(provider as any, 'runPythonClient').mockResolvedValue({
            type: 'response',
            text: '{"status": "ok"}',
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        });
    });

    it('should pass response_format (JSON Schema) to python client', async () => {
        const schema = {
            type: 'object',
            properties: {
                name: { type: 'string' }
            }
        };

        const request: ChatRequest = {
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: 'hello' }],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'test_schema',
                    schema: schema
                }
            }
        };

        await provider.chat(request);

        const spy = vi.spyOn(provider as any, 'runPythonClient');
        const lastCall = spy.mock.calls[0][0] as GeminiInternalRequest;

        expect(lastCall.response_format).toBeDefined();
        expect(lastCall.response_format.type).toBe('json_schema');
        expect(lastCall.response_format.json_schema.schema).toEqual(schema);
    });

    it('should pass google_search flag to python client', async () => {
        const request: ChatRequest = {
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: 'what is the weather' }],
            google_search: true
        };

        await provider.chat(request);

        const spy = vi.spyOn(provider as any, 'runPythonClient');
        const lastCall = spy.mock.calls[0][0] as GeminiInternalRequest;

        expect(lastCall.google_search).toBe(true);
    });

    it('should default google_search to undefined if not provided', async () => {
        const request: ChatRequest = {
            model: 'gemini-2.5-flash',
            messages: [{ role: 'user', content: 'hello' }]
        };

        await provider.chat(request);

        const spy = vi.spyOn(provider as any, 'runPythonClient');
        const lastCall = spy.mock.calls[0][0] as GeminiInternalRequest;

        expect(lastCall.google_search).toBeUndefined();
    });
});
