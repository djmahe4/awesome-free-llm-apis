import { getEncoding, Tiktoken } from 'js-tiktoken';

let sharedEncoder: Tiktoken | null = null;

/**
 * Gets a shared instance of the cl100k_base encoder.
 * Loading the encoder is expensive, so we use a singleton.
 */
export function getSharedEncoder(): Tiktoken {
    if (!sharedEncoder) {
        sharedEncoder = getEncoding('cl100k_base');
    }
    return sharedEncoder;
}

/**
 * Helper to count tokens for a string using the shared encoder.
 */
export function countStringTokens(text: string): number {
    return getSharedEncoder().encode(text).length;
}
