import { vi, beforeEach } from 'vitest';

// List of all known API key environment variables to stub out for isolation
const API_KEYS = [
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'CO_API_KEY',
    'MISTRAL_API_KEY',
    'ZHIPU_API_KEY',
    'CEREBRAS_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'GITHUB_TOKEN',
    'HUGGINGFACE_API_KEY',
    'LLM7_API_KEY',
    'NVIDIA_API_KEY',
    'OLLAMA_API_URL',
    'OPENROUTER_API_KEY',
    'SILICONFLOW_API_KEY',
    'KILOCODE_API_KEY'
];

beforeEach(() => {
    // Ensure no real API keys leak into tests unless explicitly stubbed by the test
    for (const key of API_KEYS) {
        vi.stubEnv(key, '');
    }
});

// Add unhandled rejection logging as requested by user
process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
