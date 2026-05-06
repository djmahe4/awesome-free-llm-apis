import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';

// Mock persistence to avoid disk I/O and ENOENT errors during tests
vi.mock('../src/utils/PersistenceManager.js', () => ({
    persistence: {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue({ providers: {} }),
    }
}));

beforeEach(() => {
    // Mock console to prevent Vitest RPC race conditions during teardown
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('LLMExecutor - Token Refund', () => {
    let executor: LLMExecutor;

    beforeEach(() => {
        executor = new LLMExecutor();
        executor.flush();
    });

    it('should track tokens correctly during normal operation', () => {
        executor.deductTokens('test-provider', 1000);
        
        const state = executor.getTokenState();
        expect(state['test-provider'].localTotalTokens).toBe(1000);
        expect(state['test-provider'].localTotalRequests).toBe(1);
    });

    it('should refund tokens on non-rate-limit errors', () => {
        executor.deductTokens('test-provider', 1000);
        
        executor.refundTokens('test-provider', 1000);
        
        const state = executor.getTokenState();
        expect(state['test-provider'].localTotalTokens).toBe(0);
        expect(state['test-provider'].localTotalRequests).toBe(0);
    });

    it('should handle refund for non-existent tracker gracefully', () => {
        // Should not throw, just do nothing
        expect(() => executor.refundTokens('non-existent', 1000)).not.toThrow();
    });

    it('should restore remaining tokens on refund', () => {
        executor.updateProviderTokenState('test-provider', { remainingTokens: 500 });
        executor.deductTokens('test-provider', 200);
        
        executor.refundTokens('test-provider', 200);
        
        const state = executor.getTokenState();
        expect(state['test-provider'].remainingTokens).toBe(500);
    });
});

describe('LLMExecutor - Provider Circuit Breaker', () => {
    let executor: LLMExecutor;

    beforeEach(() => {
        executor = new LLMExecutor();
        executor.flush();
    });

    it('should start with closed circuit', () => {
        expect(executor.isProviderCircuitOpen('test-provider')).toBe(false);
    });

    it('should track failures but keep circuit closed below threshold', () => {
        // Threshold is 2
        executor.recordProviderFailure('circuit-test');
        expect(executor.isProviderCircuitOpen('circuit-test')).toBe(false);
        
        executor.recordProviderFailure('circuit-test');
        // Now it should be open
        expect(executor.isProviderCircuitOpen('circuit-test')).toBe(true);
    });

    it('should open circuit after 2 consecutive failures', () => {
        executor.recordProviderFailure('test-provider');
        executor.recordProviderFailure('test-provider');
        
        expect(executor.isProviderCircuitOpen('test-provider')).toBe(true);
        
        const stats = executor.getProviderStats();
        expect(stats['test-provider'].errors).toBe(2);
        expect(stats['test-provider'].circuitOpen).toBe(true);
        expect(stats['test-provider'].cooldownRemaining).toBeGreaterThan(0);
    });

    it('should reset consecutive failures and close circuit on success', () => {
        // Trigger circuit opening
        executor.recordProviderFailure('test-provider');
        executor.recordProviderFailure('test-provider');
        expect(executor.isProviderCircuitOpen('test-provider')).toBe(true);

        // Success should reset everything
        executor.recordProviderSuccess('test-provider');
        expect(executor.isProviderCircuitOpen('test-provider')).toBe(false);

        // Should require 2 MORE failures to open again
        executor.recordProviderFailure('test-provider');
        expect(executor.isProviderCircuitOpen('test-provider')).toBe(false);
    });

    it('should close circuit after cooldown period', async () => {
        executor.recordProviderFailure('test-provider');
        executor.recordProviderFailure('test-provider');
        
        expect(executor.isProviderCircuitOpen('test-provider')).toBe(true);
        
        // Test the stats contain cooldown info
        const stats = executor.getProviderStats();
        expect(stats['test-provider'].cooldownRemaining).toBeGreaterThan(25000);
    });

    it('should track total errors even after cooldown expires', () => {
        executor.recordProviderFailure('test-provider');
        executor.recordProviderFailure('test-provider');
        
        // Circuit opens with 2 errors
        expect(executor.isProviderCircuitOpen('test-provider')).toBe(true);
        
        const stats = executor.getProviderStats();
        expect(stats['test-provider'].errors).toBe(2);
    });

    it('should provide provider stats', () => {
        executor.recordProviderFailure('test-provider');
        
        const stats = executor.getProviderStats();
        
        expect(stats['test-provider']).toBeDefined();
        expect(stats['test-provider'].errors).toBe(1);
        expect(stats['test-provider'].circuitOpen).toBe(false);
    });

    it('should return empty stats for providers without failures', () => {
        const stats = executor.getProviderStats();
        expect(stats['unknown-provider']).toBeUndefined();
    });
});

describe('LLMExecutor - Token Refund Integration', () => {
    it('should refund tokens when hasEnoughTokens returns false', () => {
        const executor = new LLMExecutor();
        executor.flush();
        
        // Set low remaining tokens
        executor.updateProviderTokenState('test-provider', { 
            remainingTokens: 100,
            refreshTime: Date.now() + 60000 
        });
        
        // Deduct more than available
        executor.deductTokens('test-provider', 500);
        
        // Tokens should go negative (we track what we tried)
        const state = executor.getTokenState();
        expect(state['test-provider'].localTotalTokens).toBe(500);
        
        // Refund brings it back
        executor.refundTokens('test-provider', 500);
        
        const stateAfterRefund = executor.getTokenState();
        expect(stateAfterRefund['test-provider'].localTotalTokens).toBe(0);
    });
});
