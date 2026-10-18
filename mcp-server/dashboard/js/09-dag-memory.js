'use strict';
// ─── DAG Memory Graph (memory_tool storage+DAG core) ─────────────
// Renders manage_memory's node/edge graph (node_add/node_link/graph_query
// actions) for a workspace — mirrors the Cyber Tool Decision Graph pattern
// above (card-list columns by type + edge list), just grouped by DAG node
// type instead of CTF decision-graph type.
const dagMemWorkspaceInput = document.getElementById('dagmem-workspace-input');
const dagMemFolderBtn      = document.getElementById('dagmem-folder-btn');
const dagMemLoadBtn        = document.getElementById('dagmem-load-btn');
const dagMemFilterInput    = document.getElementById('dagmem-filter-input');
const dagMemGraphBody      = document.getElementById('dagmem-graph-body');
const dagMemNodeType       = document.getElementById('dagmem-node-type');
const dagMemNodeContent    = document.getElementById('dagmem-node-content');
const dagMemNodeTags       = document.getElementById('dagmem-node-tags');
const dagMemAddNodeBtn     = document.getElementById('dagmem-add-node-btn');
const dagMemLinkFrom       = document.getElementById('dagmem-link-from');
const dagMemLinkTo         = document.getElementById('dagmem-link-to');
const dagMemLinkRelation   = document.getElementById('dagmem-link-relation');
const dagMemLinkBtn        = document.getElementById('dagmem-link-btn');
const dagMemFormStatus     = document.getElementById('dagmem-form-status');

let _dagMemGraphData = { nodes: [], edges: [] };
let dagMemInitialized = false;
let _dagMemPan = { x: 0, y: 0 };   // pan offset applied to the graph group
let _dagMemLastW = 0;              // container width at last render (RO guard)

const DAG_NODE_TYPE_COLOR = {
  text: 'var(--accent-cyan)',
  image: 'var(--accent-purple)',
  video: 'var(--accent-amber)',
  audio: 'var(--accent-green)',
  pdf_page: 'var(--accent-red)',
};

async function callManageMemoryDag(params) {
  const r = await fetch('/api/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'manage_memory', params: { ...params, workspace_root: dagMemWorkspaceInput.value.trim() } })
  });
  const d = await r.json();
  if (!r.ok || d.ok === false) throw new Error(d.error || d.result?.error || 'Request failed');
  return d.result;
}

function renderDagMemGraph(filterText) {
  const { nodes, edges } = _dagMemGraphData;
  if (!nodes.length) {
    dagMemGraphBody.innerHTML = '<div class="conv-empty">No DAG memory nodes for this workspace yet.</div>';
    return;
  }

  const q = (filterText || '').trim().toLowerCase();
  const matches = (n) => !q || n.id.toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q) || (n.tags || []).some(t => t.toLowerCase().includes(q));

  // Self-aware sizing: fit the real container instead of a fixed 600×360.
  // Height is fixed to the CSS-rendered svg height (400px) so the viewBox
  // matches the box 1:1 — measuring the body height would vary with the
  // detail card text and feed a ResizeObserver re-render loop.
  const rect = dagMemGraphBody.getBoundingClientRect();
  const width  = Math.max(560, Math.round(rect.width) || 600);
  const height = 400;
  _dagMemLastW = Math.round(rect.width);
  const cx = width / 2;
  const cy = height / 2;
  // Elliptical ring so nodes spread across the available width (a circle
  // would keep the graph narrow even on a 1600px container).
  const twoRings = nodes.length > 10;
  const rx = Math.max(200, width / 2 - 72);
  const ry = Math.max(150, height / 2 - 56);
  const rxIn = rx * 0.55;
  const ryIn = ry * 0.55;

  const positions = {};
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    const outer = !twoRings || i % 2 === 0;
    const useRx = outer ? rx : rxIn;
    const useRy = outer ? ry : ryIn;
    positions[n.id] = { x: cx + useRx * Math.cos(angle), y: cy + useRy * Math.sin(angle) };
  });

  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '">';
  svg += '<defs><marker id="dagmem-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--glass-border)"></path></marker></defs>';
  svg += '<g class="dagmem-pan" transform="translate(' + _dagMemPan.x + ',' + _dagMemPan.y + ')">';

  edges.forEach(e => {
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to) return;
    const dimEdge = q && !matches({ id: e.from, content: '', tags: [] }) && !matches({ id: e.to, content: '', tags: [] });
    svg += '<line class="dagmem-svg-edge" data-from="' + esc(e.from) + '" data-to="' + esc(e.to) + '" x1="' + from.x + '" y1="' + from.y + '" x2="' + to.x + '" y2="' + to.y + '" opacity="' + (dimEdge ? 0.15 : 1) + '"><title>' + esc(e.from) + ' -&gt; ' + esc(e.to) + ' (' + esc(e.relation) + ')</title></line>';
  });

  nodes.forEach(n => {
    const pos = positions[n.id];
    const dim = !matches(n);
    const color = DAG_NODE_TYPE_COLOR[n.type] || 'var(--accent-cyan)';
    const label = (n.content || n.filePath || n.id).slice(0, 18);
    svg += '<g class="dagmem-svg-node' + (dim ? ' dim' : '') + '" data-node-id="' + esc(n.id) + '">';
    svg += '<circle cx="' + pos.x + '" cy="' + pos.y + '" r="14" fill="' + color + '"><title>' + esc(n.id) + '</title></circle>';
    svg += '<text x="' + pos.x + '" y="' + (pos.y + 26) + '" text-anchor="middle">' + esc(label) + '</text>';
    svg += '</g>';
  });

  svg += '</g></svg>';

  const detailId = 'dagmem-node-detail';
  dagMemGraphBody.innerHTML =
    '<div class="dagmem-svg-wrap">' + svg + '</div>' +
    '<div id="' + detailId + '" class="dagmem-detail-card" style="margin-top:14px;"><span style="color:var(--text-muted);">💡 Drag a node to move it, drag the background to pan, click a node to inspect metadata, tags, and media pointer.</span></div>';

  _dagMemBindInteractions(positions, nodes, detailId);
}

// ─── Graph interaction: node drag, background pan, out-of-view fade ───
function _dagMemBindInteractions(positions, nodes, detailId) {
  const svg = dagMemGraphBody.querySelector('.dagmem-svg-wrap svg');
  if (!svg) return;
  const gPan = svg.querySelector('.dagmem-pan');

  const toSvgLocal = (evt) => {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };
  const toPanLocal = (evt) => {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(gPan.getScreenCTM().inverse());
  };

  // Nodes whose center has left the visible viewBox fade out (with CSS
  // transition) while dragging, so the remaining nodes stay readable.
  const updateOutOfView = () => {
    const dragging = svg.classList.contains('dragging');
    const vb = svg.viewBox.baseVal;
    svg.querySelectorAll('.dagmem-svg-node').forEach(g => {
      const p = positions[g.getAttribute('data-node-id')];
      if (!p) return;
      const x = p.x + _dagMemPan.x;
      const y = p.y + _dagMemPan.y;
      const outside = x < -48 || x > vb.width + 48 || y < -48 || y > vb.height + 48;
      g.classList.toggle('dagmem-out', dragging && outside);
    });
  };

  const refreshEdges = () => {
    svg.querySelectorAll('.dagmem-svg-edge').forEach(l => {
      const f = positions[l.dataset.from];
      const t = positions[l.dataset.to];
      if (!f || !t) return;
      l.setAttribute('x1', f.x); l.setAttribute('y1', f.y);
      l.setAttribute('x2', t.x); l.setAttribute('y2', t.y);
    });
  };

  const showDetail = (id) => {
    const n = nodes.find(x => x.id === id);
    if (!n) return;
    const detail = document.getElementById(detailId);
    if (!detail) return;
    const color = DAG_NODE_TYPE_COLOR[n.type] || 'var(--accent-cyan)';
    const tagBadges = (n.tags || []).map(t => '<span class="badge badge-purple" style="font-size:0.65rem;margin-right:4px;">#' + esc(t) + '</span>').join('');
    detail.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
        '<span class="dagmem-badge" style="background:' + color + ';color:#000;">' + esc(n.type) + '</span>' +
        '<strong style="color:var(--text-primary);font-size:0.85rem;">' + esc(n.id) + '</strong>' +
        '<span class="badge badge-cyan" style="font-size:0.65rem;margin-left:auto;">Retention ' + ((n.confidence ?? 0) * 100).toFixed(0) + '%</span>' +
      '</div>' +
      '<div style="margin-bottom:6px;font-size:0.82rem;color:var(--text-primary);">' + esc(n.content || n.filePath || '') + '</div>' +
      (tagBadges ? '<div style="margin-top:4px;">' + tagBadges + '</div>' : '');
  };

  // Node drag ──────────────────────────────────────────────────
  svg.querySelectorAll('.dagmem-svg-node').forEach(g => {
    let dragging = false, moved = false, start = null, startPos = null;
    g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const id = g.getAttribute('data-node-id');
      if (!positions[id]) return;
      dragging = true; moved = false;
      start = toPanLocal(e);
      startPos = { ...positions[id] };
      g.classList.add('dagmem-active');
      svg.classList.add('dragging');
      try { g.setPointerCapture(e.pointerId); } catch {}
      updateOutOfView();
    });
    g.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const cur = toPanLocal(e);
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      if (!moved) return;
      const id = g.getAttribute('data-node-id');
      positions[id] = { x: startPos.x + dx, y: startPos.y + dy };
      const circle = g.querySelector('circle');
      const text = g.querySelector('text');
      circle.setAttribute('cx', positions[id].x);
      circle.setAttribute('cy', positions[id].y);
      text.setAttribute('x', positions[id].x);
      text.setAttribute('y', positions[id].y + 26);
      refreshEdges();
      updateOutOfView();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      g.classList.remove('dagmem-active');
      svg.classList.remove('dragging');
      svg.querySelectorAll('.dagmem-out').forEach(x => x.classList.remove('dagmem-out'));
      if (!moved) showDetail(g.getAttribute('data-node-id'));  // click, not drag
      try { g.releasePointerCapture(e.pointerId); } catch {}
    };
    g.addEventListener('pointerup', endDrag);
    g.addEventListener('pointercancel', endDrag);
  });

  // Background pan ─────────────────────────────────────────────
  let panning = false, panStart = null, panOrigin = null, panMoved = false;
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.dagmem-svg-node')) return;
    panning = true; panMoved = false;
    panStart = toSvgLocal(e);
    panOrigin = { ..._dagMemPan };
    svg.classList.add('panning', 'dragging');
    try { svg.setPointerCapture(e.pointerId); } catch {}
    updateOutOfView();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const cur = toSvgLocal(e);
    const dx = cur.x - panStart.x;
    const dy = cur.y - panStart.y;
    if (!panMoved && Math.hypot(dx, dy) > 4) panMoved = true;
    _dagMemPan = { x: panOrigin.x + dx, y: panOrigin.y + dy };
    gPan.setAttribute('transform', 'translate(' + _dagMemPan.x + ',' + _dagMemPan.y + ')');
    updateOutOfView();
  });
  const endPan = (e) => {
    if (!panning) return;
    panning = false;
    svg.classList.remove('panning', 'dragging');
    svg.querySelectorAll('.dagmem-out').forEach(x => x.classList.remove('dagmem-out'));
    try { svg.releasePointerCapture(e.pointerId); } catch {}
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);

  // Re-fit only when the container WIDTH changes (self-aware layout).
  // Height changes come from the detail card text and must not re-render,
  // otherwise innerHTML rewrite → height change → RO → render loops forever.
  _dagMemBindInteractions._ro?.disconnect();
  if (typeof ResizeObserver !== 'undefined') {
    _dagMemBindInteractions._ro = new ResizeObserver(() => {
      if (!document.getElementById('panel-dagmemory')?.classList.contains('active')) return;
      const w = Math.round(dagMemGraphBody.getBoundingClientRect().width);
      if (Math.abs(w - _dagMemLastW) < 4) return;
      clearTimeout(_dagMemBindInteractions._t);
      _dagMemBindInteractions._t = setTimeout(() => {
        if (document.getElementById('panel-dagmemory')?.classList.contains('active')) {
          renderDagMemGraph(dagMemFilterInput?.value || '');
        }
      }, 150);
    });
    _dagMemBindInteractions._ro.observe(dagMemGraphBody);
  }
}

async function loadDagMemGraph() {
  const ws = dagMemWorkspaceInput.value.trim();
  if (!ws) return;
  dagMemGraphBody.innerHTML = '<div class="conv-empty">Loading…</div>';
  _dagMemPan = { x: 0, y: 0 };
  try {
    const result = await callManageMemoryDag({ action: 'graph_query' });
    if ((!result.nodes || result.nodes.length === 0) && (!result.edges || result.edges.length === 0)) {
      _dagMemGraphData = { nodes: DEMO_DAG_NODES, edges: DEMO_DAG_EDGES };
    } else {
      _dagMemGraphData = { nodes: result.nodes || [], edges: result.edges || [] };
    }
    renderDagMemGraph(dagMemFilterInput?.value || '');
    localStorage.setItem('mcp-workspace', ws);
  } catch (err) {
    dagMemGraphBody.innerHTML = `<div class="conv-empty">Failed to load graph: ${esc(err.message)}</div>`;
  }
}

async function addDagMemNode() {
  const content = dagMemNodeContent.value.trim();
  if (!content) { dagMemFormStatus.textContent = 'Content is required.'; return; }
  const tags = dagMemNodeTags.value.split(',').map(t => t.trim()).filter(Boolean);
  dagMemFormStatus.textContent = 'Adding…';
  try {
    await callManageMemoryDag({ action: 'node_add', node: { type: dagMemNodeType.value, content, tags } });
    dagMemFormStatus.textContent = 'Node added.';
    dagMemNodeContent.value = '';
    dagMemNodeTags.value = '';
    loadDagMemGraph();
  } catch (err) {
    dagMemFormStatus.textContent = `Failed to add node: ${err.message}`;
  }
}

async function linkDagMemNodes() {
  const from = dagMemLinkFrom.value.trim();
  const to = dagMemLinkTo.value.trim();
  const relation = dagMemLinkRelation.value.trim();
  if (!from || !to || !relation) { dagMemFormStatus.textContent = 'from, to, and relation are all required.'; return; }
  dagMemFormStatus.textContent = 'Linking…';
  try {
    await callManageMemoryDag({ action: 'node_link', from, to, relation });
    dagMemFormStatus.textContent = 'Edge added.';
    dagMemLinkFrom.value = '';
    dagMemLinkTo.value = '';
    dagMemLinkRelation.value = '';
    loadDagMemGraph();
  } catch (err) {
    dagMemFormStatus.textContent = `Failed to link nodes: ${err.message}`;
  }
}

dagMemLoadBtn?.addEventListener('click', loadDagMemGraph);
dagMemFilterInput?.addEventListener('input', () => renderDagMemGraph(dagMemFilterInput.value));
dagMemWorkspaceInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadDagMemGraph(); });
dagMemWorkspaceInput?.addEventListener('change', () => {
  localStorage.setItem('mcp-workspace', dagMemWorkspaceInput.value.trim());
  loadDagMemGraph();
});

// Folder picker matching pg-folder-btn
dagMemFolderBtn?.addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    alert('Your browser does not support the Folder Picker API. Please type the path manually.');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const current = dagMemWorkspaceInput.value.trim();
    if (!current) {
      dagMemWorkspaceInput.value = handle.name;
    } else {
      const sep = current.includes('\\') ? '\\' : '/';
      const parts = current.split(sep);
      parts[parts.length - 1] = handle.name;
      dagMemWorkspaceInput.value = parts.join(sep);
    }
    dagMemWorkspaceInput.dispatchEvent(new Event('change'));
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[DagMemFolderPicker]', e);
  }
});

const DEMO_DAG_NODES = [
  { id: 'goal-root', type: 'text', content: 'Omni-Modal Agent Memory Graph', confidence: 1.0, tags: ['core', 'v1.1.0'] },
  { id: 'vlm-vision', type: 'image', filePath: 'docs/diagrams/vlm-pipeline.png', confidence: 0.92, tags: ['vision', 'ocr'] },
  { id: 'quantum-drift', type: 'text', content: 'Quantum Phase Drift Steer & Telemetry', confidence: 0.85, tags: ['quantum', 'telemetry'] },
  { id: 'dag-tasks', type: 'text', content: 'OMP Task Decomposer & CAS Rollback', confidence: 0.95, tags: ['omp', 'checkpoint'] },
  { id: 'spec-pdf', type: 'pdf_page', filePath: 'specs/system_architecture.pdf', pdfPage: 1, confidence: 0.78, tags: ['spec', 'pdf'] },
  { id: 'media-stream', type: 'video', filePath: 'recordings/audio-stream.mp4', confidence: 0.65, tags: ['video', 'media'] },
];

const DEMO_DAG_EDGES = [
  { from: 'goal-root', to: 'vlm-vision', relation: 'ingests' },
  { from: 'goal-root', to: 'quantum-drift', relation: 'measures' },
  { from: 'goal-root', to: 'dag-tasks', relation: 'decomposes' },
  { from: 'vlm-vision', to: 'spec-pdf', relation: 'extracts_page' },
  { from: 'dag-tasks', to: 'media-stream', relation: 'triggers' },
];

function initDagMemoryTab() {
  if (!dagMemInitialized) {
    dagMemInitialized = true;
    const savedWs = localStorage.getItem('mcp-workspace') || (document.getElementById('pg-workspace')?.value || '').trim();
    if (savedWs) {
      dagMemWorkspaceInput.value = savedWs;
      loadDagMemGraph();
    } else {
      // Default to demo visualization so graph is never empty on first view
      dagMemWorkspaceInput.value = 'awesome-free-llm-apis (demo)';
      _dagMemGraphData = { nodes: DEMO_DAG_NODES, edges: DEMO_DAG_EDGES };
      renderDagMemGraph(dagMemFilterInput?.value || '');
    }
  }
}

