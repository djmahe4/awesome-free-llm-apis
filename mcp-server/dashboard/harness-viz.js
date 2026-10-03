/**
 * Harness 2.5D / Three.js Reactive Visualizer with 2D Canvas Fallback
 * Visualizes:
 *  1. Multi-agent concurrent claims (file leases, reasoning scopes)
 *  2. Interactive wiki knowledge base nexus rays (links from active agent nodes to wiki pages)
 *  3. Dynamic orbit, pulse particles, ray shaders, and collision rings
 */

class HarnessVisualizer {
  constructor(canvasId, containerId, tooltipId, detailId) {
    this.canvas = document.getElementById(canvasId);
    this.container = document.getElementById(containerId);
    this.tooltip = document.getElementById(tooltipId);
    this.detail = document.getElementById(detailId);
    this.isWebGL = false;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.animId = null;
    this.nodes = [];
    this.edges = [];
    this.wikiRays = [];
    this.hoveredNode = null;
    this.selectedNode = null;
    this.physicsEnabled = true;
    this.mouse = { x: 0, y: 0 };
    this.raycaster = null;
    this.pulse = 0;

    this.init();
  }

  detectWebGL() {
    try {
      const gl = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
      return !!(window.WebGLRenderingContext && gl && typeof THREE !== 'undefined');
    } catch (e) {
      return false;
    }
  }

  init() {
    if (!this.canvas) return;
    this.isWebGL = this.detectWebGL();
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width || 700;
    this.height = rect.height || 380;

    if (this.isWebGL) {
      this.initThree();
    } else {
      this.initCanvas2D();
    }
    this.bindEvents();
  }

  initThree() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, this.width / this.height, 0.1, 1000);
    this.camera.position.set(0, 0, 400);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);

    this.raycaster = new THREE.Raycaster();
    this.nodeGroup = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.rayGroup = new THREE.Group();
    this.scene.add(this.edgeGroup);
    this.scene.add(this.rayGroup);
    this.scene.add(this.nodeGroup);

    // Ambient & Point light for 2.5D depth
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    const pointLight = new THREE.PointLight(0x06b6d4, 1.5, 600);
    pointLight.position.set(0, 50, 200);
    this.scene.add(ambientLight);
    this.scene.add(pointLight);

    this.startThreeLoop();
  }

  initCanvas2D() {
    this.ctx = this.canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.start2DLoop();
  }

  bindEvents() {
    let isDragging = false;
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (this.isWebGL) {
        this.mouse.x = (mx / this.width) * 2 - 1;
        this.mouse.y = -(my / this.height) * 2 + 1;
        this.checkThreeHover(e, mx, my);
      } else {
        if (isDragging && this.selectedNode) {
          this.selectedNode.x = mx;
          this.selectedNode.y = my;
          return;
        }
        let found = null;
        for (const n of this.nodes) {
          if (Math.hypot(n.x - mx, n.y - my) <= n.r + 5) {
            found = n;
            break;
          }
        }
        this.hoveredNode = found;
        this.updateTooltip(found, mx, my);
      }
    });

    this.canvas.addEventListener('mousedown', () => {
      if (this.hoveredNode) {
        this.selectedNode = this.hoveredNode;
        isDragging = true;
        this.canvas.style.cursor = 'grabbing';
        this.renderDetail(this.selectedNode);
      }
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
      if (this.canvas) this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
    });
  }

  checkThreeHover(e, mx, my) {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.nodeGroup.children);
    if (intersects.length > 0) {
      const mesh = intersects[0].object;
      this.hoveredNode = mesh.userData;
      this.canvas.style.cursor = 'pointer';
      this.updateTooltip(this.hoveredNode, mx, my);
    } else {
      this.hoveredNode = null;
      this.canvas.style.cursor = 'grab';
      this.updateTooltip(null);
    }
  }

  updateTooltip(node, mx, my) {
    if (!this.tooltip) return;
    if (!node) {
      this.tooltip.style.display = 'none';
      return;
    }
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${Math.min(mx + 12, this.width - 240)}px`;
    this.tooltip.style.top = `${Math.min(my + 12, this.height - 90)}px`;
    this.tooltip.innerHTML = `
      <div style="font-weight:700;color:${node.color};">${this.esc(node.label)}</div>
      <div style="font-size:.7rem;color:var(--text-secondary);">${this.esc(node.sub || node.type)}</div>
      ${node.tier ? `<span class="badge badge-cyan" style="margin-top:3px;font-size:0.62rem;">Wiki ${this.esc(node.tier)}</span>` : ''}
      ${node.data?.findings ? `<div style="margin-top:4px;font-size:.68rem;color:var(--text-muted);">${this.esc(node.data.findings.slice(0, 100))}…</div>` : ''}
    `;
  }

  renderDetail(node) {
    if (!this.detail) return;
    this.detail.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;width:100%;">
        <span style="font-weight:700;color:${node.color};font-family:'JetBrains Mono',monospace;">Selected: ${this.esc(node.label)}</span>
        <span class="badge ${node.type === 'wiki' ? 'badge-cyan' : 'badge-purple'}">${this.esc(node.type)}</span>
        <span style="font-size:.72rem;color:var(--text-muted);">${this.esc(node.sub || '')}</span>
        <button class="btn btn-secondary btn-sm" onclick="this.parentElement.parentElement.innerHTML = 'Inspect metadata, claims, and nexus rays by clicking any node.'" style="margin-left:auto;padding:2px 8px;font-size:.7rem;">Reset</button>
      </div>
      ${node.data?.findings ? `<div style="width:100%;margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:.72rem;background:rgba(0,0,0,0.3);padding:6px;border-radius:4px;">${this.esc(node.data.findings)}</div>` : ''}
    `;
  }

  updateData(activeScopes = [], reasoningScopes = [], wikiPages = []) {
    const nodeMap = new Map();
    const edges = [];
    const wikiRays = [];
    const cx = this.width / 2;
    const cy = this.height / 2;

    // 1. Agents & File Claims
    activeScopes.forEach((claim, idx) => {
      const agentId = `agent:${claim.agentId}`;
      if (!nodeMap.has(agentId)) {
        nodeMap.set(agentId, {
          id: agentId,
          label: claim.agentId,
          sub: 'Active Worker',
          type: 'agent',
          color: '#06b6d4',
          r: 18,
          x: cx + Math.cos(idx) * 120,
          y: cy + Math.sin(idx) * 100,
          z: 20,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          data: claim
        });
      }

      (claim.files || []).forEach(file => {
        const fileId = `file:${file}`;
        if (!nodeMap.has(fileId)) {
          nodeMap.set(fileId, {
            id: fileId,
            label: file.split(/[\/\\]/).pop(),
            sub: file,
            type: 'file',
            color: '#10b981',
            r: 13,
            x: cx + (Math.random() - 0.5) * 260,
            y: cy + (Math.random() - 0.5) * 180,
            z: 0,
            vx: (Math.random() - 0.5) * 0.2,
            vy: (Math.random() - 0.5) * 0.2,
            data: { file, claimedBy: claim.agentId }
          });
        }
        edges.push({
          from: agentId,
          to: fileId,
          type: 'claim',
          color: 'rgba(16,185,129,0.5)',
          label: 'file lease lock'
        });
      });
    });

    // 2. Reasoning Scopes & Keywords
    reasoningScopes.forEach((rs, idx) => {
      const roleId = `role:${rs.role}:${rs.agentId}`;
      if (!nodeMap.has(roleId)) {
        nodeMap.set(roleId, {
          id: roleId,
          label: rs.role,
          sub: `Agent: ${rs.agentId}`,
          type: 'agent',
          color: '#7c3aed',
          r: 16,
          x: cx + Math.cos(idx + 2) * 140,
          y: cy + Math.sin(idx + 2) * 110,
          z: 15,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          data: rs
        });
      }

      (rs.keywords || []).forEach(kw => {
        const kwId = `kw:${kw.toLowerCase()}`;
        if (!nodeMap.has(kwId)) {
          nodeMap.set(kwId, {
            id: kwId,
            label: `#${kw}`,
            sub: 'Collision Scope',
            type: 'keyword',
            color: '#ec4899',
            r: 11,
            x: cx + (Math.random() - 0.5) * 280,
            y: cy + (Math.random() - 0.5) * 200,
            z: -10,
            vx: (Math.random() - 0.5) * 0.3,
            vy: (Math.random() - 0.5) * 0.3,
            data: { keyword: kw, role: rs.role, findings: rs.findingsText }
          });
        }
        edges.push({
          from: roleId,
          to: kwId,
          type: 'relay',
          color: 'rgba(236,72,153,0.5)',
          label: 'reasoning collision'
        });
      });
    });

    // 3. Wiki Knowledge Base Nexus Rays
    const effectiveWiki = wikiPages.length > 0 ? wikiPages : [
      { title: 'ADR-001-Harness-Protocol', tier: 'semantic', tags: ['architecture', 'harness', 'agents'] },
      { title: 'Global-Wiki-Taxonomy', tier: 'semantic', tags: ['wiki', 'memory', 'knowledge'] }
    ];

    effectiveWiki.forEach((wp, wIdx) => {
      const wikiId = `wiki:${wp.title}`;
      if (!nodeMap.has(wikiId)) {
        nodeMap.set(wikiId, {
          id: wikiId,
          label: wp.title.replace(/^ADR-\d+-?/, ''),
          sub: `Wiki Page (${wp.tier})`,
          tier: wp.tier,
          type: 'wiki',
          color: '#3b82f6',
          r: 14,
          x: cx + Math.cos(wIdx * 1.8) * 220,
          y: cy + Math.sin(wIdx * 1.8) * 140,
          z: -25,
          vx: (Math.random() - 0.5) * 0.15,
          vy: (Math.random() - 0.5) * 0.15,
          data: wp
        });
      }

      // Project nexus ray to any active agent
      for (const [nid, n] of nodeMap.entries()) {
        if (n.type === 'agent') {
          wikiRays.push({
            from: n.id,
            to: wikiId,
            type: 'nexus_ray',
            color: 'rgba(59,130,246,0.55)',
            label: 'wiki knowledge stream'
          });
        }
      }
    });

    this.nodes = Array.from(nodeMap.values());
    this.edges = edges;
    this.wikiRays = wikiRays;

    const stats = document.getElementById('harness-flow-stats');
    if (stats) {
      stats.textContent = `${this.nodes.length} nodes • ${this.edges.length} relays • ${this.wikiRays.length} nexus rays`;
    }

    if (this.isWebGL) {
      this.rebuildThreeMeshes();
    }
  }

  rebuildThreeMeshes() {
    while (this.nodeGroup.children.length > 0) {
      this.nodeGroup.remove(this.nodeGroup.children[0]);
    }

    const sphereGeo = new THREE.SphereGeometry(1, 16, 16);
    this.nodes.forEach(node => {
      const mat = new THREE.MeshStandardMaterial({
        color: node.color,
        emissive: node.color,
        emissiveIntensity: 0.35,
        roughness: 0.3,
        metalness: 0.8
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.scale.set(node.r, node.r, node.r);
      mesh.position.set(node.x - this.width / 2, -(node.y - this.height / 2), node.z || 0);
      mesh.userData = node;
      node.mesh = mesh;
      this.nodeGroup.add(mesh);
    });
  }

  startThreeLoop() {
    const render = () => {
      this.pulse += 0.03;
      if (this.physicsEnabled) {
        this.nodes.forEach(n => {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < n.r + 10 || n.x > this.width - n.r - 10) n.vx *= -1;
          if (n.y < n.r + 10 || n.y > this.height - n.r - 10) n.vy *= -1;
          if (n.mesh) {
            n.mesh.position.set(n.x - this.width / 2, -(n.y - this.height / 2), (n.z || 0) + Math.sin(this.pulse + n.x) * 4);
          }
        });
      }

      this.rebuildThreeLines();
      this.renderer.render(this.scene, this.camera);
      this.animId = requestAnimationFrame(render);
    };
    render();
  }

  rebuildThreeLines() {
    while (this.edgeGroup.children.length > 0) this.edgeGroup.remove(this.edgeGroup.children[0]);
    while (this.rayGroup.children.length > 0) this.rayGroup.remove(this.rayGroup.children[0]);

    // Regular Edges
    for (const e of this.edges) {
      const f = this.nodes.find(n => n.id === e.from);
      const t = this.nodes.find(n => n.id === e.to);
      if (!f || !t || !f.mesh || !t.mesh) continue;

      const pts = [f.mesh.position, t.mesh.position];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: e.type === 'claim' ? 0x10b981 : 0xec4899,
        transparent: true,
        opacity: 0.45,
        linewidth: 1.5
      });
      const line = new THREE.Line(geo, mat);
      this.edgeGroup.add(line);
    }

    // Nexus Rays (Pulsing Cyan-Blue)
    for (const r of this.wikiRays) {
      const f = this.nodes.find(n => n.id === r.from);
      const t = this.nodes.find(n => n.id === r.to);
      if (!f || !t || !f.mesh || !t.mesh) continue;

      const pts = [f.mesh.position, t.mesh.position];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineDashedMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.6 + Math.sin(this.pulse * 2) * 0.3,
        dashSize: 6,
        gapSize: 3
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      this.rayGroup.add(line);
    }
  }

  start2DLoop() {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;

    const render = () => {
      this.pulse += 0.03;
      ctx.clearRect(0, 0, width, height);

      // Background grid
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let x = 0; x < width; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      for (let y = 0; y < height; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }

      // Physics
      if (this.physicsEnabled) {
        for (const n of this.nodes) {
          if (n === this.selectedNode) continue;
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < n.r + 10 || n.x > width - n.r - 10) n.vx *= -1;
          if (n.y < n.r + 10 || n.y > height - n.r - 10) n.vy *= -1;
        }
      }

      // Draw Nexus Rays (Wiki Links)
      for (const ray of this.wikiRays) {
        const from = this.nodes.find(n => n.id === ray.from);
        const to = this.nodes.find(n => n.id === ray.to);
        if (!from || !to) continue;

        ctx.setLineDash([4, 4]);
        ctx.lineDashOffset = -this.pulse * 15;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.strokeStyle = `rgba(59,130,246,${0.4 + Math.sin(this.pulse * 2) * 0.25})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw Relay / Claim Edges
      for (const edge of this.edges) {
        const from = this.nodes.find(n => n.id === edge.from);
        const to = this.nodes.find(n => n.id === edge.to);
        if (!from || !to) continue;

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.strokeStyle = edge.color;
        ctx.lineWidth = (this.hoveredNode && (this.hoveredNode.id === from.id || this.hoveredNode.id === to.id)) ? 2.5 : 1.2;
        ctx.stroke();

        // Pulsing Particle
        const t = (Math.sin(this.pulse + from.x * 0.01) + 1) / 2;
        const px = from.x + (to.x - from.x) * t;
        const py = from.y + (to.y - from.y) * t;
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = edge.type === 'claim' ? '#10b981' : '#ec4899';
        ctx.shadowColor = edge.type === 'claim' ? '#10b981' : '#ec4899';
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Draw Nodes
      for (const n of this.nodes) {
        const isHovered = this.hoveredNode && this.hoveredNode.id === n.id;
        const isSelected = this.selectedNode && this.selectedNode.id === n.id;

        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + (isHovered || isSelected ? 6 : 2), 0, Math.PI * 2);
        ctx.fillStyle = isHovered ? 'rgba(6,182,212,0.25)' : 'rgba(255,255,255,0.04)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.shadowColor = n.color;
        ctx.shadowBlur = isHovered || isSelected ? 12 : 5;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255,255,255,0.4)';
        ctx.stroke();

        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillStyle = '#f1f5f9';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + n.r + 14);
      }

      this.animId = requestAnimationFrame(render);
    };

    render();
  }

  esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
}

// Global visualizer singleton export
window.HarnessVisualizer = HarnessVisualizer;
