import { pipeline } from '@huggingface/transformers';
import fs from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
            }
            const fileStream = createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });
            fileStream.on('error', (err) => {
                reject(err);
            });
        }).on('error', reject);
    });
}

/**
 * Pre-downloads the embedding model and kokoro-onnx weights.
 * This prevents timeouts during tests and ensures production readiness.
 */
async function download() {
    const modelName = 'Xenova/bge-small-en-v1.5';
    console.log(`[Build] Pre-downloading embedding model: ${modelName}...`);
    
    try {
        await pipeline('feature-extraction', modelName);
        console.log('[Build] Model downloaded and cached successfully.');
    } catch (err) {
        console.error('[Build] Failed to download model:', err.message);
    }

    // Pre-download Kokoro-ONNX weights for instant local TTS
    try {
        const kokoroDir = path.resolve(root, 'models', 'kokoro');
        await fs.mkdir(kokoroDir, { recursive: true });

        const files = [
            {
                name: 'voices-v1.0.bin',
                url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'
            },
            {
                name: 'kokoro-v1.0.onnx',
                url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx'
            }
        ];

        for (const file of files) {
            const target = path.join(kokoroDir, file.name);
            if (!existsSync(target)) {
                console.log(`[Build] Downloading Kokoro asset ${file.name}...`);
                await downloadFile(file.url, target);
                console.log(`[Build] ${file.name} downloaded successfully.`);
            } else {
                console.log(`[Build] Kokoro asset ${file.name} already present.`);
            }
        }
    } catch (err) {
        console.warn('[Build] Warning: Kokoro weights download skipped/failed:', err.message);
    }
}

download();
