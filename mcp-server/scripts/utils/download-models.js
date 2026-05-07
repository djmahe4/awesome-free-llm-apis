import { pipeline } from '@huggingface/transformers';

/**
 * Pre-downloads the embedding model used by the memory system.
 * This prevents timeouts during tests and ensures production readiness.
 */
async function download() {
    const modelName = 'Xenova/bge-small-en-v1.5';
    console.log(`[Build] Pre-downloading embedding model: ${modelName}...`);
    
    try {
        // Initializing the pipeline will trigger the download if not present
        await pipeline('feature-extraction', modelName);
        console.log('[Build] Model downloaded and cached successfully.');
    } catch (err) {
        console.error('[Build] Failed to download model:', err.message);
        // We don't exit with error here to avoid blocking builds if HF is down,
        // but it will likely fail later during tests if not resolved.
    }
}

download();
