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

  const width = 600;
  const height = 360;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 60;

  const positions = {};
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    positions[n.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });

  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '">';
  svg += '<defs><marker id="dagmem-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--glass-border)"></path></marker></defs>';

  edges.forEach(e => {
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to) return;
    const dimEdge = q && !matches({ id: e.from, content: '', tags: [] }) && !matches({ id: e.to, content: '', tags: [] });
    svg += '<line class="dagmem-svg-edge" x1="' + from.x + '" y1="' + from.y + '" x2="' + to.x + '" y2="' + to.y + '" opacity="' + (dimEdge ? 0.15 : 1) + '"><title>' + esc(e.from) + ' -&gt; ' + esc(e.to) + ' (' + esc(e.relation) + ')</title></line>';
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

  svg += '</svg>';

  const detailId = 'dagmem-node-detail';
  dagMemGraphBody.innerHTML =
    '<div class="dagmem-svg-wrap">' + svg + '</div>' +
    '<div id="' + detailId + '" class="dagmem-detail-card" style="margin-top:14px;"><span style="color:var(--text-muted);">💡 Click any node circle in the graph to inspect metadata, tags, and media pointer.</span></div>';

  dagMemGraphBody.querySelectorAll('.dagmem-svg-node').forEach(g => {
    g.addEventListener('click', () => {
      const id = g.getAttribute('data-node-id');
      const n = nodes.find(x => x.id === id);
      if (!n) return;
      const detail = document.getElementById(detailId);
      if (detail) {
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
      }
    });
  });
}

async function loadDagMemGraph() {
  const ws = dagMemWorkspaceInput.value.trim();
  if (!ws) return;
  dagMemGraphBody.innerHTML = '<div class="conv-empty">Loading…</div>';
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

