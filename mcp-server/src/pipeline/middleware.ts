import type { ChatRequest, ChatResponse } from '../providers/types.js';

export interface PipelineContext {
    request: ChatRequest;
    taskType?: TaskType;
    providerId?: string;
    response?: ChatResponse;
    estimatedTokens?: number;
    workspaceRoot?: string;
    wsHash?: string;
    keywords?: string[];
    /**
     * Set by LLMExecutor after a successful provider call when the provider
     * reports remaining token quota via response headers (x-ratelimit-remaining-tokens).
     * ContextManager reads this to override its static model-window target with a
     * real-time budget — the bridge between executor and compressor.
     */
    providerRemainingTokens?: number;
    [key: string]: any;
}

export enum TaskType {
    Coding = 'coding',
    Moderation = 'moderation',
    Classification = 'classification',
    UserIntent = 'user_intent',
    SemanticSearch = 'search',
    Summarization = 'summarization',
    EntityExtraction = 'extraction',
    Chat = 'chat',
}

export type NextFunction = () => Promise<void>;

export interface Middleware {
    name: string;
    execute(context: PipelineContext, next: NextFunction): Promise<void>;
}

export class PipelineExecutor {
    private middlewares: Middleware[] = [];

    use(middleware: Middleware) {
        this.middlewares.push(middleware);
        return this;
    }

    async execute(context: PipelineContext): Promise<PipelineContext> {
        let index = -1;

        const dispatch = async (i: number): Promise<void> => {
            if (i <= index) throw new Error('next() called multiple times');
            index = i;
            const middleware = this.middlewares[i];
            if (middleware) {
                await middleware.execute(context, dispatch.bind(null, i + 1));
            }
        };

        await dispatch(0);
        return context;
    }
}
