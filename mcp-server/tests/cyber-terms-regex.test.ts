import { describe, it, expect } from 'vitest';
import { CYBER_TERMS_REGEX } from '../src/utils/TaskClassifier.js';

describe('CYBER_TERMS_REGEX bug-bounty coverage', () => {
  it.each([
    'hunt for bug bounties on example.com',
    'bug bounty reconnaissance for example.com',
    'run a bug-hunting workflow against the target',
    'use the bug_hunting skill to enumerate subdomains',
    'escalate the finding from a pentest',
  ])('classifies %j as cyber', (prompt) => {
    expect(CYBER_TERMS_REGEX.test(prompt)).toBe(true);
  });

  it.each([
    'summarize the quarterly report',
    'refactor the onboarding docs',
    'summarize what we discussed yesterday',
  ])('does not classify %j as cyber', (prompt) => {
    expect(CYBER_TERMS_REGEX.test(prompt)).toBe(false);
  });
});
