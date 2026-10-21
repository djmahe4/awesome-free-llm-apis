(function () {
  'use strict';

  const TYPED_KINDS = new Set(['page', 'image', 'audio', 'video', 'pdf', 'quote']);

  function escAttr(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseLocator(locator) {
    if (!locator) return null;
    const value = String(locator).trim();
    if (!value) return null;

    const timeMatch = value.match(/^t=([^\s]+)$/i);
    if (timeMatch) {
      return { kind: 'time', value: timeMatch[1] };
    }

    const pageMatch = value.match(/^page\s*=\s*(\d+)$/i);
    if (pageMatch) {
      return { kind: 'page', value: Number(pageMatch[1]) };
    }

    const lineMatch = value.match(/^L(\d+)(?:-L(\d+))?$/i);
    if (lineMatch) {
      const start = Number(lineMatch[1]);
      const end = Number(lineMatch[2] || lineMatch[1]);
      return { kind: 'line', start, end };
    }

    return { kind: 'raw', value };
  }

  function parseWikiToken(rawToken) {
    const raw = String(rawToken || '').trim();
    if (!raw) return null;

    const hashIdx = raw.indexOf('#');
    const noLocator = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    const locatorRaw = hashIdx === -1 ? '' : raw.slice(hashIdx + 1).trim();

    const colonIdx = noLocator.indexOf(':');
    if (colonIdx === -1) {
      return {
        type: 'page',
        typed: false,
        target: noLocator.trim(),
        locatorRaw,
        locator: parseLocator(locatorRaw),
        raw,
        label: noLocator.trim()
      };
    }

    const kind = noLocator.slice(0, colonIdx).trim().toLowerCase();
    const target = noLocator.slice(colonIdx + 1).trim();

    if (!target) return null;

    if (!TYPED_KINDS.has(kind)) {
      return {
        type: 'page',
        typed: false,
        target: raw,
        locatorRaw: '',
        locator: null,
        raw,
        label: raw
      };
    }

    return {
      type: kind,
      typed: true,
      target,
      locatorRaw,
      locator: parseLocator(locatorRaw),
      raw,
      label: `${kind}:${target}${locatorRaw ? '#' + locatorRaw : ''}`
    };
  }

  function parseWikiReferences(text) {
    const input = String(text || '');
    const refs = [];
    let idx = 0;

    while (idx < input.length) {
      const start = input.indexOf('[[', idx);
      if (start === -1) break;
      const end = input.indexOf(']]', start + 2);
      if (end === -1) break;

      const inner = input.slice(start + 2, end);
      const parsed = parseWikiToken(inner);
      if (parsed) {
        refs.push({
          start,
          end: end + 2,
          raw: `[[${inner}]]`,
          ...parsed
        });
      }
      idx = end + 2;
    }

    return refs;
  }

  function toAnchor(token) {
    const cls = token.typed ? `wiki-link wiki-typed-link wiki-link-${token.type}` : 'wiki-link';
    const attrs = [
      `href="#"`,
      `class="${cls}"`,
      `data-wiki-link="1"`,
      `data-link-type="${escAttr(token.type)}"`,
      `data-link-target="${escAttr(token.target)}"`
    ];

    if (token.locatorRaw) {
      attrs.push(`data-link-locator="${escAttr(token.locatorRaw)}"`);
    }

    if (token.type === 'page') {
      attrs.push(`data-title="${escAttr(token.target)}"`);
    }

    const label = token.typed ? token.label : token.target;
    return `<a ${attrs.join(' ')}>${escAttr(label)}</a>`;
  }

  function replaceInternalLinks(text) {
    const input = String(text || '');
    const refs = parseWikiReferences(input);
    if (!refs.length) return input;

    let out = '';
    let cursor = 0;
    refs.forEach(ref => {
      out += input.slice(cursor, ref.start);
      out += toAnchor(ref);
      cursor = ref.end;
    });
    out += input.slice(cursor);
    return out;
  }

  window.WikiLinkParser = {
    parseWikiReferences,
    parseWikiToken,
    replaceInternalLinks,
    parseLocator
  };
})();
