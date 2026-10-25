import { describe, it, expect } from 'vitest';
import { detectBlockingChallenge } from '../src/browser/BlockDetector.js';
import { DomStateFingerprinter } from '../src/browser/BrowserSession.js';

// B7: any page that merely mentioned "captcha" or showed a "Ray ID" was reported as blocked, and the DOM
// fingerprint dropped every line containing the letters "ms" (items, forms, terms, programs...), so a change
// in those lines looked like no change.

const page = (lines: number, extra: string[] = []) =>
    [...Array.from({ length: lines }, (_, i) => `row ${i}: product name ${i} price ${i}.99`), ...extra].join('\n');

describe('detectBlockingChallenge: walls, not mentions', () => {
    it('a long page that mentions captcha in its footer is not blocked', () => {
        expect(detectBlockingChallenge(page(80, ['text "This site is protected by reCAPTCHA and the Google Privacy Policy apply"'])).blocked).toBe(false);
        expect(detectBlockingChallenge(page(80, ['text "Solve the captcha to leave a comment"'])).blocked).toBe(false);
    });

    it('a long article that shows a Ray ID is not blocked, a short Cloudflare error page is', () => {
        expect(detectBlockingChallenge(page(80, ['text "Cloudflare Ray ID: 8f2a1b3c4d5e"'])).blocked).toBe(false);
        const wall = detectBlockingChallenge('heading "Sorry, you have been blocked"\ntext "You are unable to access example.com"\ntext "Cloudflare Ray ID: 8f2a1b3c4d5e"');
        expect(wall.blocked).toBe(true);
        expect(wall.type).toBe('cloudflare');
    });

    it('a short page with a lone "Ray ID:" and no Cloudflare mention is not blocked', () => {
        expect(detectBlockingChallenge('text "Support ticket Ray ID: 12 opened by Ray"').blocked).toBe(false);
    });

    it('"Just a moment..." as a loading hint on a real page is not blocked', () => {
        expect(detectBlockingChallenge(page(80, ['text "Just a moment... loading more results"'])).blocked).toBe(false);
    });

    it('strong Cloudflare markers block whatever the page length', () => {
        expect(detectBlockingChallenge(page(80, ['text "Checking your browser before accessing example.com"'])).type).toBe('cloudflare');
        expect(detectBlockingChallenge(page(80, ['div "cf-turnstile"'])).type).toBe('cloudflare');
    });

    it('a small page that is only a captcha widget is still blocked', () => {
        const r = detectBlockingChallenge('heading "Security check"\niframe title="reCAPTCHA"\ntext "I\'m not a robot"');
        expect(r.blocked).toBe(true);
        expect(r.type).toBe('captcha');
    });

    it('the structural signal still blocks an otherwise unmarked wall', () => {
        expect(detectBlockingChallenge('heading "Welcome"', true)).toMatchObject({ blocked: true, type: 'unknown' });
    });
});

describe('DomStateFingerprinter', () => {
    it('a change in a line that merely contains "ms" changes the hash', () => {
        const a = 'link "Terms of service"\nbutton "Add to cart"\ntext "3 items"';
        const b = 'link "Terms of service"\nbutton "Add to cart"\ntext "4 items"';
        expect(DomStateFingerprinter.computeHash(a)).not.toBe(DomStateFingerprinter.computeHash(b));
        const c = 'heading "Programs"\nlink "Forms"';
        const d = 'heading "Programs"\nlink "Forms and Terms"';
        expect(DomStateFingerprinter.computeHash(c)).not.toBe(DomStateFingerprinter.computeHash(d));
    });

    it('timing noise is still ignored', () => {
        const a = 'text "Loaded in 120ms"\nbutton "Go"\ntext "timestamp 1700000000"';
        const b = 'text "Loaded in 987ms"\nbutton "Go"\ntext "timestamp 1700000999"';
        expect(DomStateFingerprinter.computeHash(a)).toBe(DomStateFingerprinter.computeHash(b));
        expect(DomStateFingerprinter.computeHash('text "took 1.5 ms"\nx')).toBe(DomStateFingerprinter.computeHash('text "took 22 ms"\nx'));
    });
});
