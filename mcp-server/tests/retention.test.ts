import { describe, it, expect } from 'vitest';
import { retentionOf, isDueForReview } from '../src/memory/retention.js';

describe('retentionOf', () => {
  it('is full confidence at time of review', () => {
    const now = Date.now();
    expect(retentionOf({ confidence: 0.9, lastReviewedAt: now, halfLifeDays: 30 }, now)).toBeCloseTo(0.9);
  });

  it('halves at exactly one half-life', () => {
    const now = Date.now();
    const oneHalfLifeAgo = now - 30 * 86400000;
    expect(retentionOf({ confidence: 0.8, lastReviewedAt: oneHalfLifeAgo, halfLifeDays: 30 }, now)).toBeCloseTo(0.4);
  });

  it('matches the exact formula the browser dashboard uses (dag-blackboard.js)', () => {
    const node = { confidence: 0.7, lastReviewedAt: Date.now() - 10 * 86400000, halfLifeDays: 20 };
    const days = 10;
    const expected = 0.7 * Math.pow(2, -days / 20);
    expect(retentionOf(node)).toBeCloseTo(expected, 10);
  });
});

describe('isDueForReview', () => {
  it('is due once retention drops below the threshold', () => {
    const now = Date.now();
    const longAgo = now - 100 * 86400000;
    expect(isDueForReview({ confidence: 0.9, lastReviewedAt: longAgo, halfLifeDays: 10 }, 0.5, now)).toBe(true);
  });

  it('is not due right after review', () => {
    const now = Date.now();
    expect(isDueForReview({ confidence: 0.9, lastReviewedAt: now, halfLifeDays: 10 }, 0.5, now)).toBe(false);
  });
});
