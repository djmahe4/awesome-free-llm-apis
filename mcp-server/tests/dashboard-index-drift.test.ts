import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const partialsDir = path.resolve(__dirname, '..', 'dashboard', 'partials');
const indexPath = path.resolve(__dirname, '..', 'dashboard', 'index.html');

describe('dashboard index.html assembly', () => {
  it('assembles from dashboard/partials/ byte-identically (drift check)', () => {
    const partials = fs
      .readdirSync(partialsDir)
      .filter((f) => f.endsWith('.html'))
      .sort();

    expect(partials.length).toBeGreaterThanOrEqual(10);
    // zero-padded names: lexical sort must equal documented load order
    expect(partials[0]).toBe('00-head.html');
    expect(partials[partials.length - 1]).toBe('15-footer.html');

    const assembled = partials
      .map((f) => fs.readFileSync(path.join(partialsDir, f), 'utf-8'))
      .join('');
    const onDisk = fs.readFileSync(indexPath, 'utf-8');

    // line endings depend on core.autocrlf on the machine; the drift being checked is in the content
    const lf = (t: string) => t.replace(/\r\n/g, '\n');
    expect(lf(assembled)).toBe(lf(onDisk));
  });

  it('keeps the split script tag order intact in the assembled page', () => {
    const html = fs.readFileSync(indexPath, 'utf-8');
    const jsTags = [...html.matchAll(/<script src="(\/js\/\d{2}-[a-z-]+\.js)"><\/script>/g)].map(
      (m) => m[1]
    );
    expect(jsTags).toEqual([
      '/js/00-field-visibility.js',
      '/js/01-utils.js',
      '/js/02-markdown.js',
      '/js/03-shell.js',
      '/js/04-playground-form.js',
      '/js/05-playground-chat.js',
      '/js/06-memory-profile.js',
      '/js/07-wiki-cyber.js',
      '/js/08-steering.js',
      '/js/09-dag-memory.js',
      '/js/10-harness-telemetry.js',
      '/js/11-relay-canvas.js',
    ]);
  });
});
