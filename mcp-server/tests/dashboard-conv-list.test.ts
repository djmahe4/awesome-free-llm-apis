import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The conversation list drew every saved session (5,000+ after smoke runs) in a box a details element could not
// bound, so rows piled over the tool list and could not be clicked. The box is bounded in CSS, the list scrolls,
// and only the newest rows are drawn.

const dash = path.resolve(__dirname, '..', 'dashboard');
const read = (p: string) => fs.readFileSync(path.join(dash, p), 'utf8').replace(/\r\n/g, '\n');

describe('playground conversation list', () => {
    const html = read('partials/05-playground.html');
    const css = read('style.css');
    const js = read('js/05-playground-chat.js');

    it('does not size the details element as a flex box', () => {
        const card = html.match(/<details class="card conv-card"[^>]*>/);
        expect(card).not.toBeNull();
        expect(card![0]).not.toMatch(/display:\s*flex/);
        expect(card![0]).not.toMatch(/max-height/);
    });
    it('bounds the body and lets the list scroll inside it', () => {
        expect(css).toMatch(/details\.conv-card\[open\]\s*>\s*\.conv-card-body\s*\{[^}]*max-height:\s*\d+px[^}]*overflow:\s*hidden/);
        expect(css).toMatch(/\.conv-list\s*\{[^}]*overflow-y:\s*auto[^}]*max-height:\s*\d+px/);
    });
    it('draws a bounded number of rows and keeps the open one', () => {
        expect(js).toMatch(/MAX_CONV_ROWS\s*=\s*\d+/);
        expect(js).toMatch(/sessions\.find\(s => s\.id === activeSessionId\)/);
        expect(js).toContain('conv-more');
    });
    it('the assembled page carries the same markup', () => {
        const index = read('index.html');
        expect(index).toContain('class="card conv-card"');
    });
});
