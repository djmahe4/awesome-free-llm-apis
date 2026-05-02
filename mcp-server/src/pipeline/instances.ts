import { IntelligentRouterMiddleware } from './middlewares/IntelligentRouterMiddleware.js';
import { AgenticMiddleware } from '../middleware/agentic/agentic-middleware.js';
import { WorkspaceContextMiddleware } from './middlewares/WorkspaceContextMiddleware.js';
import { ResponseCacheMiddleware } from './middlewares/ResponseCacheMiddleware.js';
import { StructuralMarkdownMiddleware } from '../middleware/agentic/structural-middleware.js';

/**
 * Pipeline Instance Registry
 * 
 * Provides singleton instances of all middlewares to be shared across the application.
 * This prevents circular dependencies between middlewares that need to trigger 
 * the pipeline recursively (e.g., AgenticMiddleware calling subtasks).
 */

export const structuralMarkdownMiddleware = new StructuralMarkdownMiddleware();
export const sharedResponseCache = new ResponseCacheMiddleware();
export const workspaceContextMiddleware = new WorkspaceContextMiddleware();
export const agenticMiddleware = new AgenticMiddleware();
export const sharedRouter = new IntelligentRouterMiddleware();
