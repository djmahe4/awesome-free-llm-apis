import { describe, it, expect, afterEach, vi } from 'vitest';
import { OVHcloudProvider } from '../src/providers/ovhcloud.js';

// #143: OVHCLOUD_API_KEY=free is the documented way to use the anonymous tier.

describe('OVHcloud keyless tier', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each(['free', 'keyless', 'FREE'])('is available with OVHCLOUD_API_KEY=%s', (value) => {
        vi.stubEnv('OVHCLOUD_API_KEY', value);
        expect(new OVHcloudProvider().isAvailable()).toBe(true);
    });
    it('is available with a real-looking token', () => {
        vi.stubEnv('OVHCLOUD_API_KEY', 'ovh_1234567890abcdef1234567890');
        expect(new OVHcloudProvider().isAvailable()).toBe(true);
    });
    it('is not available without a key or with a placeholder', () => {
        vi.stubEnv('OVHCLOUD_API_KEY', '');
        expect(new OVHcloudProvider().isAvailable()).toBe(false);
        vi.stubEnv('OVHCLOUD_API_KEY', 'your_key_here');
        expect(new OVHcloudProvider().isAvailable()).toBe(false);
    });
});
