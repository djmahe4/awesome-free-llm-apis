import { describe, it, expect } from 'vitest';
import { detectHallucination } from '../src/pipeline/middlewares/AgenticMiddleware.js';

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

    it('does not flag common coding comments like "as shown in the code" as hallucination', () => {
        const responses = [
            "Here is the updated function, as shown in the code below.",
            "As described in the file, we need to export this function.",
            "As seen in the source, the route uses JWT auth."
        ];
        for (const res of responses) {
            const report = detectHallucination(res);
            expect(report.status).toBe('PASS');
        }
    });
});

