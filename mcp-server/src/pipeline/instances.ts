import { TextRouterMiddleware } from './middlewares/TextRouterMiddleware.js';
import { ImageRouterMiddleware } from './middlewares/ImageRouterMiddleware.js';
import { AgenticMiddleware } from './middlewares/AgenticMiddleware.js';
import { WorkspaceContextMiddleware } from './middlewares/WorkspaceContextMiddleware.js';
import { ResponseCacheMiddleware } from './middlewares/ResponseCacheMiddleware.js';
import { StructuralMarkdownMiddleware } from './middlewares/StructuralMiddleware.js';

/**
 * Pipeline Instance Registry (Hardened)
 * 
 * Provides lazy-loaded singleton instances of all middlewares to be shared across the application.
 * This pattern prevents ReferenceErrors during module initialization caused by circular 
 * dependencies between middlewares (e.g., AgenticMiddleware needing sharedRouter 
 * and sharedRouter needing the full pipeline definition).
 */

let _structuralMarkdownMiddleware: StructuralMarkdownMiddleware | null = null;
let _sharedResponseCache: ResponseCacheMiddleware | null = null;
let _workspaceContextMiddleware: WorkspaceContextMiddleware | null = null;
let _sharedRouter: TextRouterMiddleware | null = null;
let _sharedImageRouter: ImageRouterMiddleware | null = null;
let _agenticMiddleware: AgenticMiddleware | null = null;

/**
 * Gets the singleton instance of StructuralMarkdownMiddleware.
 */
export function getStructuralMarkdownMiddleware(): StructuralMarkdownMiddleware {
    if (!_structuralMarkdownMiddleware) {
        _structuralMarkdownMiddleware = new StructuralMarkdownMiddleware();
    }
    return _structuralMarkdownMiddleware;
}

/**
 * Gets the singleton instance of ResponseCacheMiddleware.
 */
export function getSharedResponseCache(): ResponseCacheMiddleware {
    if (!_sharedResponseCache) {
        _sharedResponseCache = new ResponseCacheMiddleware();
    }
    return _sharedResponseCache;
}

/**
 * Gets the singleton instance of WorkspaceContextMiddleware.
 */
export function getWorkspaceContextMiddleware(): WorkspaceContextMiddleware {
    if (!_workspaceContextMiddleware) {
        _workspaceContextMiddleware = new WorkspaceContextMiddleware();
    }
    return _workspaceContextMiddleware;
}

/**
 * Gets the singleton instance of IntelligentRouterMiddleware.
 */
export function getSharedRouter(): TextRouterMiddleware {
    if (!_sharedRouter) {
        _sharedRouter = new TextRouterMiddleware();
    }
    return _sharedRouter;
}

/**
 * Gets the singleton instance of ImageRouterMiddleware.
 */
export function getSharedImageRouter(): ImageRouterMiddleware {
    if (!_sharedImageRouter) {
        _sharedImageRouter = new ImageRouterMiddleware();
    }
    return _sharedImageRouter;
}

/**
 * Gets the singleton instance of AgenticMiddleware.
 */
export function getAgenticMiddleware(): AgenticMiddleware {
    if (!_agenticMiddleware) {
        _agenticMiddleware = new AgenticMiddleware();
    }
    return _agenticMiddleware;
}

// Deprecated direct exports to be removed after full migration
// Keeping them temporarily but initializing them lazily if accessed
export const structuralMarkdownMiddleware = getStructuralMarkdownMiddleware();
export const sharedResponseCache = getSharedResponseCache();
export const workspaceContextMiddleware = getWorkspaceContextMiddleware();
export const sharedRouter = getSharedRouter();
export const sharedImageRouter = getSharedImageRouter();
export const agenticMiddleware = getAgenticMiddleware();

