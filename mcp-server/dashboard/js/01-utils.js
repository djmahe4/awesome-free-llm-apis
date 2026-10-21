/* ============================================================
   Free LLM MCP Dashboard v2 — app.js
   ============================================================ */

'use strict';

// ─── Utility ────────────────────────────────────────────────────
function modelBadge(model, provider) {
  if (!model && !provider) return '';
  const label = provider && model ? `${provider}/${model}` : (provider || model);
  return `<span class="latency-badge model-badge" style="display:inline-flex;" title="Model used for this call">🧬 ${esc(label)}</span>`;
}

function esc(str) {
  if (str == null || str === '') return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

// Single shared HTML escaper (loaded before dag-blackboard.js and
// productivity-ui.js, which used to each carry their own copy).
function escapeHtml(str) {
  return esc(str);
}

function fmt(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

// Renders one "contextInjected" entry — server sends "<label>\n<excerpt>" (excerpt optional).
// Shows a 400-char preview inline; if the excerpt is longer, a <details> reveals the rest,
// same click-to-expand pattern used elsewhere in this file (history entries, tool-call bubbles).
const CONTEXT_PREVIEW_CHARS = 400;
function renderContextEntry(raw) {
  const nlIdx = raw.indexOf('\n');
  const label = nlIdx === -1 ? raw : raw.slice(0, nlIdx);
  const excerpt = nlIdx === -1 ? '' : raw.slice(nlIdx + 1).trim();
  if (!excerpt) return `<li>${esc(label)}</li>`;
  const isLong = excerpt.length > CONTEXT_PREVIEW_CHARS;
  const preview = isLong ? excerpt.slice(0, CONTEXT_PREVIEW_CHARS) + '…' : excerpt;
  const excerptStyle = "white-space:pre-wrap;font-family:'JetBrains Mono',monospace;font-size:.68rem;opacity:.85;margin-top:3px;";
  return `<li>
    <div>${esc(label)}</div>
    <div style="${excerptStyle}">${esc(preview)}</div>
    ${isLong ? `<details style="margin-top:3px;"><summary style="cursor:pointer;font-size:.66rem;color:var(--accent-cyan);">Show full (${excerpt.length} chars)</summary><div style="${excerptStyle}">${esc(excerpt)}</div></details>` : ''}
  </li>`;
}

// JSON syntax highlighter — XSS-safe: escape HTML first
function highlightJSON(obj) {
  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  // Escape HTML entities before injecting into DOM
  const safe = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return safe.replace(
    /(&quot;(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\&])*&quot;(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    match => {
      if (/^&quot;/.test(match)) {
        if (/:$/.test(match)) return `<span class="json-key">${match}</span>`;
        return `<span class="json-str">${match}</span>`;
      }
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
      if (/null/.test(match))       return `<span class="json-null">${match}</span>`;
      return `<span class="json-num">${match}</span>`;
    }
  );
}

