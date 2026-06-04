import { describe, it, expect } from 'vitest';
import { detectHallucination } from '../src/middleware/agentic/agentic-middleware.js';

describe('Hallucination Detector Unit Tests', () => {
    it('detectHallucination() returns PASS for clean response', () => {
        const response = "Here is the implementation of the auth middleware. I verified that file exists on disk.";
        const report = detectHallucination(response);
        expect(report.status).toBe('PASS');
    });

    it('returns FAIL for phantom citation: according to the docs', () => {
        const response = "According to the docs, the class possesses a method called execute.";
        const report = detectHallucination(response);
        expect(report.status).toBe('FAIL');
        expect(report.reason).toContain('phantom citation');
    });

    it('returns FAIL for invented state: the module is located in...', () => {
        const response = "The class is located in src/auth.ts.";
        const report = detectHallucination(response);
        expect(report.status).toBe('FAIL');
        expect(report.reason).toContain('invented state');
    });

    it('returns LOOP_DETECTED when last 2 responses are semantically identical', () => {
        const response1 = "Let's check the database configuration now.";
        const response2 = "Let's check the database configuration now.";
        const report = detectHallucination(response2, response1);
        expect(report.status).toBe('LOOP_DETECTED');
    });
});
