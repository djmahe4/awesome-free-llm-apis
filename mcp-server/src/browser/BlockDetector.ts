/**
 * Detects the common "you didn't actually scrape the page, you scraped a
 * challenge wall" failure mode — a Cloudflare/CAPTCHA interstitial that never
 * got interacted with. Without this, a blocked page silently produces a
 * near-empty snapshot and looks identical to a genuinely empty page, which is
 * exactly the false-success case strict mode is meant to rule out.
 *
 * Deliberately text/marker based (not a live DOM check) so it works against
 * anything that already produced a snapshot string — take_snapshot output,
 * evaluate_script results, etc.
 */
export type BlockingChallengeType = 'cloudflare' | 'captcha' | 'unknown';

export interface BlockingChallengeResult {
    blocked: boolean;
    type?: BlockingChallengeType;
    evidence?: string;
}

/**
 * A wall is a page that is (almost) nothing but the challenge. Markers split by how much they prove:
 *  - strong: only a real Cloudflare challenge contains them, whatever the page length;
 *  - wall-sized: generic words ("captcha", "just a moment...", "verify you are human") that a normal page
 *    can also use (a footer notice, a loading hint), so they count only on a small page;
 *  - "ray id:" counts only together with the word cloudflare (error footers have both; a blog or a support
 *    ticket may have just one).
 */
const STRONG_CLOUDFLARE_MARKERS = [
    'checking your browser before accessing',
    'attention required! | cloudflare',
    'cf-turnstile',
    'cf_chl_',
];
const WALL_SIZED_CLOUDFLARE_MARKERS = ['just a moment...', 'verify you are human'];

const CAPTCHA_MARKERS = [
    'g-recaptcha',
    'recaptcha',
    'hcaptcha',
    'h-captcha',
    "i'm not a robot",
    'please complete the security check',
    'captcha',
];

/** Non-empty lines at or under which a page can be a challenge wall rather than a page with a widget. */
const WALL_MAX_LINES = 40;

/**
 * Scans page text/HTML-ish content for known challenge markers. Case-insensitive.
 * `type` prefers 'cloudflare' over generic 'captcha' when both hit, since Cloudflare's
 * own Turnstile challenge often also contains the word "captcha" in surrounding copy.
 *
 * `structuralSignal`, when passed true, means SnapshotDiffer.looksLikeStructuralInterstitial()
 * already found a near-total top-level wipeout replaced by a small added set (an interstitial
 * swap shape) — OR'd into the marker-based result as a secondary, marker-independent signal for
 * challenge walls that don't happen to contain any of the known text markers above.
 */
export function detectBlockingChallenge(text: string, structuralSignal = false): BlockingChallengeResult {
    if (!text) return structuralSignal ? { blocked: true, type: 'unknown', evidence: 'structural-interstitial' } : { blocked: false };
    const lower = text.toLowerCase();
    const smallPage = lower.split(/\r?\n/).filter(l => l.trim()).length <= WALL_MAX_LINES;

    for (const marker of STRONG_CLOUDFLARE_MARKERS) {
        if (lower.includes(marker)) return { blocked: true, type: 'cloudflare', evidence: marker };
    }
    if (smallPage) {
        for (const marker of WALL_SIZED_CLOUDFLARE_MARKERS) {
            if (lower.includes(marker)) return { blocked: true, type: 'cloudflare', evidence: marker };
        }
        if (lower.includes('ray id:') && lower.includes('cloudflare')) return { blocked: true, type: 'cloudflare', evidence: 'ray id: + cloudflare' };
        for (const marker of CAPTCHA_MARKERS) {
            if (lower.includes(marker)) return { blocked: true, type: 'captcha', evidence: marker };
        }
    }
    if (structuralSignal) {
        return { blocked: true, type: 'unknown', evidence: 'structural-interstitial' };
    }
    return { blocked: false };
}
