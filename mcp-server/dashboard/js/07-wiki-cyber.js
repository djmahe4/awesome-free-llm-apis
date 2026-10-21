'use strict';
// ─── WIKI TAB ───────────────────────────────────────────────────
const wikiWorkspaceModule = window.DashboardWiki?.create({ esc, renderMarkdown });
function initWikiTab() {
  wikiWorkspaceModule?.initTab?.();
}

// ─── Cyber Tool Decision Graph (v1.0.9) ──────────────────────────
// Visualizes the node/edge graph cyber_tool's 'save_graph'/'load_graph'
// actions already build for a CTF coaching session (RepositoryGraph under
// the hood, src/memory/dependency-scanner.ts) — no new backend graph
// structure needed, just a read + render.
const cyberGraphSessionInput = document.getElementById('cyber-graph-session-input');
const cyberGraphLoadBtn      = document.getElementById('cyber-graph-load-btn');
const cyberGraphSearchInput  = document.getElementById('cyber-graph-search-input');
const cyberGraphBody         = document.getElementById('cyber-graph-body');

let _cyberGraphData = { nodes: [], edges: [] };

const CYBER_NODE_TYPE_COLOR = {
  goal: 'var(--accent-purple)',
  hypothesis: 'var(--accent-cyan)',
  action: 'var(--accent-amber)',
  finding: 'var(--accent-green)',
  deadend: 'var(--accent-red)',
};

function renderCyberGraph(filterText) {
  const { nodes, edges } = _cyberGraphData;
  if (!nodes.length) {
    cyberGraphBody.innerHTML = '<div class="conv-empty">No decision-graph nodes recorded for this session yet.</div>';
    return;
  }

  const q = (filterText || '').trim().toLowerCase();
  const matches = (n) => !q || n.id.toLowerCase().includes(q) || (n.metadata?.label || '').toLowerCase().includes(q);

  const nodesByType = {};
  for (const n of nodes) {
    const t = n.metadata?.ctfType || n.type || 'action';
    (nodesByType[t] = nodesByType[t] || []).push(n);
  }

  const columns = ['goal', 'hypothesis', 'action', 'finding', 'deadend']
    .filter(t => nodesByType[t]?.length)
    .map(t => {
      const cards = nodesByType[t].map(n => {
        const dim = !matches(n);
        const color = CYBER_NODE_TYPE_COLOR[t] || 'var(--accent-cyan)';
        return `
          <div class="provider-card" data-node-id="${esc(n.id)}" style="opacity:${dim ? 0.3 : 1};border-left:3px solid ${color};margin-bottom:8px;">
            <div class="provider-name" style="font-size:.78rem;">${esc(n.metadata?.label || n.id)}</div>
            <div class="provider-id">${esc(n.id)}</div>
          </div>`;
      }).join('');
      return `
        <div style="flex:1;min-width:180px;">
          <div class="section-sub" style="text-transform:uppercase;font-size:.68rem;letter-spacing:.05em;margin-bottom:8px;color:${CYBER_NODE_TYPE_COLOR[t] || 'var(--text-muted)'};">${esc(t)} (${nodesByType[t].length})</div>
          ${cards}
        </div>`;
    }).join('');

  const edgeLines = edges
    .filter(e => !q || matches({ id: e.source, metadata: {} }) || matches({ id: e.target, metadata: {} }))
    .map(e => `<div style="font-family:'JetBrains Mono',monospace;font-size:.72rem;color:var(--text-muted);">${esc(e.source)} → ${esc(e.target)} <span style="color:var(--text-muted-2,var(--text-muted));">(${esc(e.type)})</span></div>`)
    .join('');

  cyberGraphBody.innerHTML = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;">${columns}</div>
    <div style="padding-top:12px;border-top:1px solid var(--glass-border);">
      <div class="section-sub" style="margin-bottom:6px;">Edges (${edges.length})</div>
      ${edgeLines || '<div class="conv-empty">No edges yet.</div>'}
    </div>`;
}

async function loadCyberGraph() {
  const sessionId = cyberGraphSessionInput.value.trim();
  if (!sessionId) return;
  cyberGraphBody.innerHTML = '<div class="conv-empty">Loading…</div>';
  try {
    const r = await fetch(`/api/cyber_tool/task_graph/${encodeURIComponent(sessionId)}`);
    const d = await r.json();
    if (!r.ok || d.success === false) throw new Error(d.error || 'Failed to load graph');
    _cyberGraphData = { nodes: d.nodes || [], edges: d.edges || [] };
    renderCyberGraph(cyberGraphSearchInput.value);
  } catch (err) {
    cyberGraphBody.innerHTML = `<div class="conv-empty">Failed to load graph: ${esc(err.message)}</div>`;
  }
}

cyberGraphLoadBtn?.addEventListener('click', loadCyberGraph);
cyberGraphSessionInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadCyberGraph(); });
cyberGraphSearchInput?.addEventListener('input', () => renderCyberGraph(cyberGraphSearchInput.value));

