'use strict';
// ─── Markdown + Mermaid Renderer ────────────────────────────────
let _mermaidCounter = 0;

async function renderMarkdown(text) {
  if (!text) return '';
  // Split on mermaid fences first
  const parts = text.split(/(```mermaid[\s\S]*?```)/g);
  const rendered = await Promise.all(parts.map(async (part, i) => {
    const mermaidMatch = part.match(/^```mermaid\s*([\s\S]*?)```$/);
    if (mermaidMatch) {
      const definition = mermaidMatch[1].trim();
      const id = `mermaid-${Date.now()}-${_mermaidCounter++}`;
      if (window.__mermaid) {
        try {
          const { svg } = await window.__mermaid.render(id, definition);
          return `<div class="mermaid-diagram" style="overflow:auto;margin:12px 0;padding:12px;background:rgba(0,0,0,.25);border-radius:var(--radius-sm);">${svg}</div>`;
        } catch (e) {
          return `<pre style="color:var(--accent-red);font-size:.78rem;">Mermaid error: ${esc(e.message)}</pre>`;
        }
      }
      return `<pre class="code-block" style="font-size:.78rem;">${esc(definition)}</pre>`;
    }

    // Extract normal code blocks first to prevent inline replacements inside them
    let codeBlocks = [];
    let noCode = part.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      let codeContent = esc(code.trim());
      if (lang === 'diff') {
        const diffLines = codeContent.split('\n');
        codeContent = diffLines.map(l => {
          if (l.startsWith('+')) return `<span style="color:#4ade80">${l}</span>`;
          if (l.startsWith('-')) return `<span style="color:#f87171">${l}</span>`;
          if (l.startsWith('@@')) return `<span style="color:#38bdf8">${l}</span>`;
          return l;
        }).join('\n');
      }
      codeBlocks.push(`<pre class="code-block" style="font-size:.78rem;overflow-x:auto;"><code>${codeContent}</code></pre>`);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // Regular markdown
    let safePart = esc(noCode);

    let html = safePart
      // Inline code
      .replace(/`([^`]+)`/g, (_, c) => `<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:3px;font-family:'JetBrains Mono',monospace;font-size:.85em;">${c}</code>`)
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${t}</strong>`)
      // Italic
      .replace(/\*([^*]+)\*/g, (_, t) => `<em>${t}</em>`)
      // Markdown links: [text](url) — only http(s) URLs become real links, everything else stays plain text
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${text}</a>`)
      // H1-H5 (matched in descending order of hashes)
      .replace(/^##### (.+)$/gm, '<h5 style="font-size:.78rem;font-weight:600;color:var(--text-primary);margin:8px 0 2px;">$1</h5>')
      .replace(/^#### (.+)$/gm, '<h4 style="font-size:.82rem;font-weight:600;color:var(--text-primary);margin:9px 0 3px;">$1</h4>')
      .replace(/^### (.+)$/gm, '<h3 style="font-size:.85rem;color:var(--text-primary);margin:10px 0 4px;">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="font-size:.95rem;color:var(--text-primary);margin:12px 0 6px;">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="font-size:1.05rem;color:var(--accent-purple);margin:14px 0 8px;">$1</h1>')
      // Unordered lists
      .replace(/^[\-\*] (.+)$/gm, '<li style="margin-left:16px;list-style:disc;">$1</li>')
      // Ordered lists
      .replace(/^\d+\. (.+)$/gm, '<li style="margin-left:16px;list-style:decimal;">$1</li>')
      // Horizontal rule
      .replace(/^---+$/gm, '<hr style="border-color:var(--glass-border);margin:12px 0;">')
      // Paragraphs — blank line becomes paragraph break
      .replace(/\n\n+/g, '</p><p style="margin:6px 0;">')
      // Single newlines become <br>
      .replace(/\n/g, '<br>');

    if (window.WikiLinkParser?.replaceInternalLinks) {
      html = window.WikiLinkParser.replaceInternalLinks(html);
    } else {
      html = html.replace(/\[\[([^\]]+)\]\]/g, (_, title) => `<a href="#" class="wiki-link" data-title="${title.replace(/"/g, '&quot;')}">${title}</a>`);
    }

    // Restore code blocks (which are already escaped) after inline markdown
    codeBlocks.forEach((cb, idx) => {
      html = html.replace(`__CODE_BLOCK_${idx}__`, cb);
    });

    return html;
  }));
  return `<div class="md-body" style="line-height:1.6;font-size:.82rem;color:var(--text-secondary);">${rendered.join('')}</div>`;
}

// Smart response renderer: extracts the actual message text (result / result.content)
// and renders it as markdown regardless of whether it "looks like" markdown — the
// markdown-indicator regex used to gate this, so plain short replies (e.g. "OK", "9")
// fell through to a raw JSON dump of the whole result object, which meant metadata
// fields like `model`/`provider` (added for the UI badges, never meant to be shown as
// message text) ended up printed inline in the chat bubble. Falls back to a JSON dump
// only when there's genuinely no string content field to render.
function renderQuantumFeedback(fb) {
  if (!fb) return '';
  const isDrifted = fb.isDrifted;
  const driftColor = isDrifted ? 'var(--accent-red)' : 'var(--accent-green)';
  const driftText = isDrifted ? '⚠ Drift Detected' : '✓ Coherent';

  let html = `<div class="card" style="margin-top:16px; border-color: ${driftColor};">`;
  html += `<div class="card-header" style="color:${driftColor}">⚛ Quantum Telemetry: ${driftText} (Score: ${fb.driftScore})</div>`;
  html += `<div class="card-body" style="font-size:0.8rem; display:flex; flex-direction:column; gap:8px;">`;

  if (fb.decoheredQubits && fb.decoheredQubits.length) {
    html += `<div><strong>Decohered Qubits:</strong> ${fb.decoheredQubits.map(q => `<span class="badge badge-amber">q${esc(q)}</span>`).join(' ')}</div>`;
  }
  if (fb.crossBranchCorrelations && fb.crossBranchCorrelations.length) {
    html += `<div><strong>Cross-Branch Correlations:</strong><ul style="margin-left:20px; list-style:circle;">`;
    html += fb.crossBranchCorrelations.map(c => {
      if (typeof c === 'string') return `<li>${esc(c)}</li>`;
      let relBadge = 'badge-gray';
      if (c.relation === 'consensus') relBadge = 'badge-green';
      else if (c.relation === 'adversarial') relBadge = 'badge-red';
      const sim = c.similarity != null ? ` (similarity: ${esc(c.similarity)})` : '';
      const qA = c.qubitA != null ? `q${esc(c.qubitA)}` : 'A';
      const qB = c.qubitB != null ? `q${esc(c.qubitB)}` : 'B';
      const pA = c.personaA ? ` (${esc(c.personaA)})` : '';
      const pB = c.personaB ? ` (${esc(c.personaB)})` : '';
      return `<li>${qA}${pA} ↔ ${qB}${pB}: <span class="badge ${relBadge}">${esc(c.relation || 'neutral')}</span>${sim}</li>`;
    }).join('');
    html += `</ul></div>`;
  }
  if (fb.recommendedGates && fb.recommendedGates.length) {
    html += `<div><strong>Recommended Gates:</strong><div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:4px;">`;
    html += fb.recommendedGates.map(g => `<div style="border:1px solid var(--glass-border); padding:6px; border-radius:4px;"><span class="badge badge-purple">${esc(g.gate)}</span> Target: ${g.target != null ? esc(g.target) : 'none'} Col: ${g.column != null ? esc(g.column) : 0}<br><span style="color:var(--text-muted); font-size:0.7rem;">${esc(g.reason)}</span></div>`).join('');
    html += `</div></div>`;
  }
  html += `</div></div>`;
  return html;
}

function renderCodingAgentsCard(res) {
  if (!res) return '';
  let html = `<div class="card" style="margin-top:16px; border-color: var(--accent-cyan);">`;
  html += `<div class="card-header">🤖 Agent Pipeline: <span class="badge badge-cyan">${esc(res.pipelineStage || 'unknown')}</span>`;
  if ((res.restoredFiles && res.restoredFiles.length > 0) || res.status === 'rollback' || res.pipelineStage === 'rollback') {
    const count = res.restoredFiles?.length ? ` (${res.restoredFiles.length} files restored)` : '';
    html += ` <span class="badge badge-amber">Rollback${count}</span>`;
  } else if (res.applied || res.status === 'applied' || res.status === 'success') {
    html += ` <span class="badge badge-green">Applied</span>`;
  } else {
    html += ` <span class="badge badge-purple">Dry Run</span>`;
  }
  html += `</div>`;
  html += `<div class="card-body" style="font-size:0.8rem; display:flex; flex-direction:column; gap:12px;">`;

  if (res.anchors && res.anchors.length) {
    html += `<div><strong>Anchors:</strong> ${res.anchors.map(a => `<code style="background:rgba(255,255,255,.08);padding:2px 4px;border-radius:3px;margin-right:4px;">${esc(typeof a === 'string' ? a : (a.hashTag || a.filePath || JSON.stringify(a)))}</code>`).join('')}</div>`;
  }

  if (res.diagnostics && res.diagnostics.length) {
    html += `<div><strong>Diagnostics:</strong><ul style="margin-left:0; padding-left:0; list-style:none; display:flex; flex-direction:column; gap:4px; margin-top:4px;">`;
    html += res.diagnostics.map(d => {
      let bClass = 'badge-gray';
      if (d.severity === 'error') bClass = 'badge-red';
      else if (d.severity === 'warning') bClass = 'badge-amber';
      else if (d.severity === 'info') bClass = 'badge-blue';
      const loc = d.filePath ? `[${d.filePath}${d.line != null ? ':' + d.line : ''}] ` : (d.line != null ? `Line ${d.line}: ` : '');
      return `<li style="background:rgba(255,255,255,.03); padding:4px 8px; border-radius:4px; border-left:2px solid ${bClass.includes('red')?'var(--accent-red)':(bClass.includes('amber')?'var(--accent-amber)':'#60a5fa')}"><span class="badge ${bClass}">${esc(d.severity)}</span> ${esc(loc)}${esc(d.message)}</li>`;
    }).join('');
    html += `</ul></div>`;
  }

  if (res.patchPlan && res.patchPlan.length) {
    html += `<div><strong>File Patches:</strong><div style="display:flex; flex-direction:column; gap:8px; margin-top:4px;">`;
    html += res.patchPlan.map(p => {
      let diffHtml = '';
      const diffText = p.unifiedDiff || (p.replacementSnippet ? `@@ -${p.startLine} +${p.startLine} @@\n${p.replacementSnippet}` : '');
      if (diffText) {
        const diffLines = diffText.split('\n');
        diffHtml = `<pre class="code-block diff-viewer" style="margin-top:4px; font-size:0.75rem; padding:8px; max-height:450px; overflow-y:auto;"><code>`;
        diffHtml += diffLines.map(l => {
          if (l.startsWith('+')) return `<span style="color:#4ade80">${esc(l)}</span>`;
          if (l.startsWith('-')) return `<span style="color:#f87171">${esc(l)}</span>`;
          if (l.startsWith('@@')) return `<span style="color:#38bdf8">${esc(l)}</span>`;
          return esc(l);
        }).join('\n');
        diffHtml += `</code></pre>`;
      }
      return `<div style="border:1px solid var(--glass-border); border-radius:6px; padding:8px;">
        <div style="font-weight:bold; margin-bottom:4px; color:var(--text-primary);">📝 ${esc(p.filePath || 'file')}</div>
        ${diffHtml}
      </div>`;
    }).join('');
    html += `</div></div>`;
  }

  html += `</div></div>`;
  return html;
}

function renderLocalPatchCard(res) {
  if (!res || !res.patch) return '';
  let html = `<div class="card" style="margin-top:16px; border-color: var(--accent-purple);">`;
  html += `<div class="card-header">🩹 Local LLM Patch: <span class="badge ${res.success ? 'badge-green' : 'badge-red'}">${res.success ? 'Success' : 'Failed'}</span>`;
  if (res.modelUsed) {
    html += ` <span class="badge badge-purple">${esc(res.modelUsed)}</span>`;
  }
  html += `</div>`;
  html += `<div class="card-body" style="font-size:0.8rem; display:flex; flex-direction:column; gap:8px;">`;
  html += `<div><strong>Target File:</strong> <code>${esc(res.filePath || '')}</code></div>`;
  if (res.patch) {
    const diffLines = res.patch.split('\n');
    html += `<div><strong>Patch Content:</strong>`;
    html += `<pre class="code-block diff-viewer" style="margin-top:4px; font-size:0.75rem; padding:8px; max-height:450px; overflow-y:auto;"><code>`;
    html += diffLines.map(l => {
      if (l.startsWith('+')) return `<span style="color:#4ade80">${esc(l)}</span>`;
      if (l.startsWith('-')) return `<span style="color:#f87171">${esc(l)}</span>`;
      if (l.startsWith('@@')) return `<span style="color:#38bdf8">${esc(l)}</span>`;
      return esc(l);
    }).join('\n');
    html += `</code></pre></div>`;
  }
  html += `</div></div>`;
  return html;
}

async function renderResponse(data) {
  const result = data.result ?? data;
  let baseHtml = '';

  const mdText = typeof result === 'string'
    ? result
    : (result?.content || result?.response || result?.markdown);

  if (typeof mdText === 'string' && mdText.trim()) {
    baseHtml = await renderMarkdown(mdText);
  } else {
    const SIZE_THRESHOLD = 100 * 1024;
    const jsonStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (jsonStr.length > SIZE_THRESHOLD) {
      baseHtml = `<span style="color:var(--text-muted);font-size:.78rem;">Response too large to render (${(jsonStr.length/1024).toFixed(0)}KB). </span><button class="copy-raw-btn btn btn-outline btn-sm" data-v="${esc(jsonStr)}" style="margin-left:8px;">Copy Raw</button>`;
    } else {
      baseHtml = highlightJSON(result);
    }
  }

  let extras = '';
  if (result && typeof result === 'object') {
    if (result.feedback && result.feedback.driftScore !== undefined) {
      extras += renderQuantumFeedback(result.feedback);
    }
    if (result.patchPlan || result.diagnostics || result.pipelineStage) {
      extras += renderCodingAgentsCard(result);
    }
    if (result.patch && result.filePath) {
      extras += renderLocalPatchCard(result);
    }
  }

  return baseHtml + extras;
}
