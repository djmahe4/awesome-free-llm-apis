'use strict';
// ─── Interactive Multi-Agent Relay & Scope Flow Canvas ───────────
let relayCanvasAnimId = null;
let relayNodes = [];
let relayEdges = [];
let relaySelectedNode = null;
let relayHoveredNode = null;
let relayPhysicsEnabled = true;
const relayReduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let relayLightningEnabled = !relayReduceMotion;

const relayCanvas = document.getElementById('harness-relay-canvas');
const relayTooltip = document.getElementById('harness-relay-tooltip');
const relayStats = document.getElementById('harness-flow-stats');
const relayDetail = document.getElementById('harness-relay-detail');
const relayPhysicsToggle = document.getElementById('harness-flow-physics-toggle');
const relayLightningToggle = document.getElementById('harness-flow-lightning-toggle');

if (relayPhysicsToggle) {
  relayPhysicsToggle.addEventListener('click', () => {
    relayPhysicsEnabled = !relayPhysicsEnabled;
    relayPhysicsToggle.textContent = `Dynamic Orbit: ${relayPhysicsEnabled ? 'ON' : 'OFF'}`;
  });
}

if (relayLightningToggle) {
  if (relayReduceMotion) {
    relayLightningEnabled = false;
    relayLightningToggle.textContent = 'Lightning Bridge: OFF';
  }
  window.relayLightningEnabled = relayLightningEnabled;
  relayLightningToggle.addEventListener('click', () => {
    relayLightningEnabled = !relayLightningEnabled;
    window.relayLightningEnabled = relayLightningEnabled;
    relayLightningToggle.textContent = `Lightning Bridge: ${relayLightningEnabled ? 'ON' : 'OFF'}`;
  });
}
window.relayLightningEnabled = relayLightningEnabled;

function initRelayCanvas(activeScopes = [], reasoningScopes = []) {
  if (!relayCanvas) return;
  const ctx = relayCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = relayCanvas.parentElement.getBoundingClientRect();
  const width = rect.width || 700;
  const height = rect.height || 380;
  
  relayCanvas.width = width * dpr;
  relayCanvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  const cx = width / 2;
  const cy = height / 2;

  // Build node set
  const nodeMap = new Map();
  const edges = [];

  // Agents & File leases
  activeScopes.forEach((claim, idx) => {
    const agentNodeId = `agent:${claim.agentId}`;
    if (!nodeMap.has(agentNodeId)) {
      nodeMap.set(agentNodeId, {
        id: agentNodeId,
        label: claim.agentId,
        sub: 'Agent Worker',
        type: 'agent',
        color: '#06b6d4',
        r: 18,
        x: cx + Math.cos(idx) * 120 + (Math.random() - 0.5) * 40,
        y: cy + Math.sin(idx) * 100 + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        data: claim
      });
    }

    (claim.files || []).forEach((file, fIdx) => {
      const fileNodeId = `file:${file}`;
      if (!nodeMap.has(fileNodeId)) {
        nodeMap.set(fileNodeId, {
          id: fileNodeId,
          label: file.split(/[\/\\]/).pop(),
          sub: file,
          type: 'file',
          color: '#10b981',
          r: 13,
          x: cx + (Math.random() - 0.5) * 260,
          y: cy + (Math.random() - 0.5) * 180,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          data: { file, claimedBy: claim.agentId }
        });
      }
      edges.push({
        from: agentNodeId,
        to: fileNodeId,
        type: 'claim',
        color: 'rgba(16,185,129,0.45)',
        label: 'claims lease'
      });
    });
  });

  // Reasoning Scopes & Keywords
  reasoningScopes.forEach((rs, rIdx) => {
    const roleNodeId = `role:${rs.role}:${rs.agentId}`;
    if (!nodeMap.has(roleNodeId)) {
      nodeMap.set(roleNodeId, {
        id: roleNodeId,
        label: rs.role,
        sub: `Agent: ${rs.agentId}`,
        type: 'agent',
        color: '#7c3aed',
        r: 16,
        x: cx + Math.cos(rIdx + 2) * 140,
        y: cy + Math.sin(rIdx + 2) * 110,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        data: rs
      });
    }

    (rs.keywords || []).forEach(kw => {
      const kwNodeId = `kw:${kw.toLowerCase()}`;
      if (!nodeMap.has(kwNodeId)) {
        nodeMap.set(kwNodeId, {
          id: kwNodeId,
          label: `#${kw}`,
          sub: 'Reasoning Keyword',
          type: 'keyword',
          color: '#ec4899',
          r: 11,
          x: cx + (Math.random() - 0.5) * 280,
          y: cy + (Math.random() - 0.5) * 200,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          data: { keyword: kw, role: rs.role, findings: rs.findingsText }
        });
      }
      edges.push({
        from: roleNodeId,
        to: kwNodeId,
        type: 'relay',
        color: 'rgba(236,72,153,0.45)',
        label: 'relays keyword'
      });
    });
  });

  // Demo fallback if no scopes live
  if (nodeMap.size === 0) {
    const demo = [
      { id: 'agent:security-reviewer', label: 'security-reviewer', sub: 'Agent', type: 'agent', color: '#06b6d4', r: 18, x: cx - 140, y: cy - 40 },
      { id: 'agent:coder-agent', label: 'coder-agent', sub: 'Agent', type: 'agent', color: '#7c3aed', r: 18, x: cx + 140, y: cy - 40 },
      { id: 'file:src/auth.ts', label: 'auth.ts', sub: 'mcp-server/src/auth.ts', type: 'file', color: '#10b981', r: 14, x: cx, y: cy - 100 },
      { id: 'file:src/server.ts', label: 'server.ts', sub: 'mcp-server/src/server.ts', type: 'file', color: '#10b981', r: 14, x: cx - 20, y: cy + 110 },
      { id: 'kw:jwt-tokens', label: '#jwt-tokens', sub: 'Keyword Collision', type: 'keyword', color: '#ec4899', r: 12, x: cx, y: cy - 10 },
      { id: 'kw:session-lease', label: '#session-lease', sub: 'Relayed Context', type: 'keyword', color: '#ec4899', r: 12, x: cx + 80, y: cy + 50 }
    ];
    demo.forEach(d => {
      nodeMap.set(d.id, { ...d, vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, data: { demo: true } });
    });
    edges.push(
      { from: 'agent:security-reviewer', to: 'file:src/auth.ts', type: 'claim', color: 'rgba(16,185,129,0.5)', label: 'file lease lock' },
      { from: 'agent:security-reviewer', to: 'kw:jwt-tokens', type: 'relay', color: 'rgba(236,72,153,0.5)', label: 'reasoning collision' },
      { from: 'agent:coder-agent', to: 'kw:jwt-tokens', type: 'relay', color: 'rgba(236,72,153,0.5)', label: 'relayed context pass' },
      { from: 'agent:coder-agent', to: 'file:src/server.ts', type: 'claim', color: 'rgba(16,185,129,0.5)', label: 'file lease lock' },
      { from: 'agent:coder-agent', to: 'kw:session-lease', type: 'relay', color: 'rgba(236,72,153,0.5)', label: 'memory decay pass' }
    );
  }

  relayNodes = Array.from(nodeMap.values());
  relayEdges = edges;

  if (relayStats) {
    relayStats.textContent = `${relayNodes.length} nodes • ${relayEdges.length} relays`;
  }

  startRelayLoop(ctx, width, height);
}

/**
 * Shared lightning-bridge bolt: jagged traveling discharge along an edge.
 * Used by the fallback relay loop below AND by harness-viz.js (the live
 * HarnessVisualizer 2D renderer) — both guard on relayLightningEnabled.
 * Coordinates are whatever the caller passes (canvas XY or mesh position XY).
 */
function drawRelayLightning(ctx, from, to, edgeIndex, phase) {
  const enabled = typeof window.relayLightningEnabled !== 'undefined' ? window.relayLightningEnabled : relayLightningEnabled;
  if (!enabled) return;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len <= 24) return;
  const nx = -dy / len;
  const ny = dx / len;
  const span = 0.24;
  const lt = (phase * 0.5 + edgeIndex * 0.23 + 0.1) % 1;
  const t0 = lt - span;
  const steps = 7;
  const flick = 0.65 + Math.random() * 0.35;
  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const frac = s / steps;
    const t = Math.max(0, Math.min(1, t0 + span * frac));
    const off = (Math.random() - 0.5) * 8 * Math.sin(Math.PI * frac);
    pts.push(from.x + dx * t + nx * off, from.y + dy * t + ny * off);
  }
  ctx.save();
  const tracePts = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let p = 2; p < pts.length; p += 2) ctx.lineTo(pts[p], pts[p + 1]);
  };
  tracePts();
  ctx.strokeStyle = `rgba(56,242,255,${0.22 * flick})`;
  ctx.lineWidth = 5;
  ctx.stroke();
  tracePts();
  ctx.shadowColor = '#38f2ff';
  ctx.shadowBlur = 9;
  ctx.strokeStyle = `rgba(214,246,255,${0.95 * flick})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Bolt head flash
  ctx.beginPath();
  ctx.arc(pts[pts.length - 2], pts[pts.length - 1], 2.4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#38f2ff';
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.restore();
}

function startRelayLoop(ctx, width, height) {
  if (relayCanvasAnimId) cancelAnimationFrame(relayCanvasAnimId);

  let pulse = 0;

  function render() {
    pulse += 0.03;
    ctx.clearRect(0, 0, width, height);

    // Subtle background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < width; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    // Dynamic Physics / Gentle Orbit
    if (relayPhysicsEnabled) {
      for (const node of relayNodes) {
        if (node === relaySelectedNode) continue;
        node.x += node.vx;
        node.y += node.vy;

        // Boundaries
        if (node.x < node.r + 10 || node.x > width - node.r - 10) node.vx *= -1;
        if (node.y < node.r + 10 || node.y > height - node.r - 10) node.vy *= -1;
      }
    }

    // Render Edges
    for (let ei = 0; ei < relayEdges.length; ei++) {
      const edge = relayEdges[ei];
      const from = relayNodes.find(n => n.id === edge.from);
      const to = relayNodes.find(n => n.id === edge.to);
      if (!from || !to) continue;

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = edge.color;
      ctx.lineWidth = (relayHoveredNode && (relayHoveredNode.id === from.id || relayHoveredNode.id === to.id)) ? 2.5 : 1.2;
      ctx.stroke();

      // Flow pulse particle
      const t = (Math.sin(pulse + from.x * 0.01) + 1) / 2;
      const px = from.x + (to.x - from.x) * t;
      const py = from.y + (to.y - from.y) * t;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = edge.type === 'claim' ? '#10b981' : '#ec4899';
      ctx.shadowColor = edge.type === 'claim' ? '#10b981' : '#ec4899';
      ctx.shadowBlur = 6;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Lightning bridge: jagged bolt traveling from → to along the edge
      drawRelayLightning(ctx, from, to, ei, pulse);
    }

    // Render Nodes
    for (const node of relayNodes) {
      const isHovered = relayHoveredNode && relayHoveredNode.id === node.id;
      const isSelected = relaySelectedNode && relaySelectedNode.id === node.id;

      // Glow halo
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r + (isHovered || isSelected ? 6 : 2), 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? 'rgba(6,182,212,0.25)' : 'rgba(255,255,255,0.04)';
      ctx.fill();

      // Node Body
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.shadowColor = node.color;
      ctx.shadowBlur = isHovered || isSelected ? 12 : 5;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Node Border
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.4)';
      ctx.stroke();

      // Label text
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillStyle = '#f1f5f9';
      ctx.textAlign = 'center';
      ctx.fillText(node.label, node.x, node.y + node.r + 14);
    }

    relayCanvasAnimId = requestAnimationFrame(render);
  }

  render();
}

// Canvas Interaction (Hover / Drag / Inspect)
if (relayCanvas) {
  let isDragging = false;

  relayCanvas.addEventListener('mousemove', e => {
    const rect = relayCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (isDragging && relaySelectedNode) {
      relaySelectedNode.x = mx;
      relaySelectedNode.y = my;
      return;
    }

    let found = null;
    for (const node of relayNodes) {
      const dist = Math.hypot(node.x - mx, node.y - my);
      if (dist <= node.r + 4) {
        found = node;
        break;
      }
    }

    relayHoveredNode = found;
    if (found) {
      relayCanvas.style.cursor = 'pointer';
      if (relayTooltip) {
        relayTooltip.style.display = 'block';
        relayTooltip.style.left = `${Math.min(mx + 12, rect.width - 240)}px`;
        relayTooltip.style.top = `${Math.min(my + 12, rect.height - 80)}px`;
        relayTooltip.innerHTML = `
          <div style="font-weight:700;color:${found.color};">${esc(found.label)}</div>
          <div style="font-size:.7rem;color:var(--text-secondary);">${esc(found.sub || found.type)}</div>
          ${found.data?.findings ? `<div style="margin-top:4px;font-size:.68rem;color:var(--text-muted);">${esc(found.data.findings.slice(0, 100))}…</div>` : ''}
        `;
      }
    } else {
      relayCanvas.style.cursor = 'grab';
      if (relayTooltip) relayTooltip.style.display = 'none';
    }
  });

  relayCanvas.addEventListener('mousedown', e => {
    if (relayHoveredNode) {
      relaySelectedNode = relayHoveredNode;
      isDragging = true;
      relayCanvas.style.cursor = 'grabbing';
      if (relayDetail) {
        relayDetail.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;width:100%;">
            <span style="font-weight:700;color:${relaySelectedNode.color};font-family:'JetBrains Mono',monospace;">Selected: ${esc(relaySelectedNode.label)}</span>
            <span class="badge badge-purple">${esc(relaySelectedNode.type)}</span>
            <span style="font-size:.72rem;color:var(--text-muted);">${esc(relaySelectedNode.sub || '')}</span>
            <button class="btn btn-secondary btn-sm" onclick="this.parentElement.parentElement.innerHTML = 'Inspect metadata and inter-agent relays by clicking any canvas node.'" style="margin-left:auto;padding:2px 8px;font-size:.7rem;">Reset</button>
          </div>
          ${relaySelectedNode.data?.findings ? `<div style="width:100%;margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:.72rem;background:rgba(0,0,0,0.3);padding:6px;border-radius:4px;">${esc(relaySelectedNode.data.findings)}</div>` : ''}
        `;
      }
    }
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });
}

// Expose drawRelayLightning globally for harness-viz.js and external callers
window.drawRelayLightning = drawRelayLightning;

let _harnessVizInstance = null;

function updateRelayVisualization(activeScopes = [], reasoningScopes = [], wikiPages = [], handoffs = []) {
  if (window.HarnessVisualizer) {
    if (!_harnessVizInstance) {
      _harnessVizInstance = new window.HarnessVisualizer(
        'harness-relay-canvas',
        'harness-relay-canvas-wrap',
        'harness-relay-tooltip',
        'harness-node-detail'
      );
    }
    _harnessVizInstance.updateData(activeScopes, reasoningScopes, wikiPages, handoffs);
  } else {
    initRelayCanvas(activeScopes, reasoningScopes);
  }
}

window.updateRelayVisualization = updateRelayVisualization;
window.getHarnessVizInstance = () => _harnessVizInstance;

// Hook into existing renderHarnessTelemetry
const _prevRenderHarnessTelemetry = renderHarnessTelemetry;
renderHarnessTelemetry = function(data) {
  _prevRenderHarnessTelemetry(data);
  updateRelayVisualization(data.activeScopes || [], data.reasoningScopes || [], data.wikiPages || [], data.handoffs || []);
};
