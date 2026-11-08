'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════
 * ML LEARNING, NEURAL OPTICS & REVERSE ENGINEERING STUDIO (v2.0)
 * Wavefront optics metaphor, interactive zoom/pan Layer DAG,
 * forward pass mechanics (with image vs without image), matrix math,
 * weight-space surgery, and media transforms.
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
  // The dashboard server exposes each tool at POST /api/<tool> and reads the params as the body.
  function toolFetch(init) {
    const call = JSON.parse(init.body);
    const params = call.params || {};
    // Each call gets its own session, so the results of calls made together never mix.
    if (call.tool === 'reverse_tool' && !params.sessionId) params.sessionId = 'ml-' + String(params.action || 'call') + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    return fetch('/api/' + call.tool, { ...init, body: JSON.stringify(params) });
  }

  // ─── Color Helpers & Snell Refraction ─────────────────────────────
  function wavelengthToRGB(wl) {
    let r = 0, g = 0, b = 0;
    if (wl >= 380 && wl < 440) {
      r = -(wl - 440) / (440 - 380);
      b = 1.0;
    } else if (wl >= 440 && wl < 490) {
      g = (wl - 440) / (490 - 440);
      b = 1.0;
    } else if (wl >= 490 && wl < 510) {
      g = 1.0;
      b = -(wl - 510) / (510 - 490);
    } else if (wl >= 510 && wl < 580) {
      r = (wl - 510) / (580 - 510);
      g = 1.0;
    } else if (wl >= 580 && wl < 645) {
      r = 1.0;
      g = -(wl - 645) / (645 - 580);
    } else if (wl >= 645 && wl <= 750) {
      r = 1.0;
    }
    let factor = 1.0;
    if (wl < 420) factor = 0.3 + 0.7 * (wl - 380) / (420 - 380);
    else if (wl > 700) factor = 0.3 + 0.7 * (750 - wl) / (750 - 700);
    return {
      r: Math.round(r * factor * 255),
      g: Math.round(g * factor * 255),
      b: Math.round(b * factor * 255)
    };
  }

  // ─── Central State Bus ───────────────────────────────────────────
  window.MLStateBus = {
    optics: {
      playing: true,
      wavelength: 520,
      angle: 0,
      profile: 'transformer',
      time: 0,
      animId: null
    },
    dag: {
      nodes: [],
      edges: [],
      panX: 40,
      panY: 180,
      zoom: 1.0,
      selectedNode: null,
      hoveredNode: null,
      wavefrontActive: true,
      particles: [],
      animId: null
    },
    model: {
      path: 'tests/fixtures/models/tiny.gguf',
      imagePath: 'tests/fixtures/media/frames/frame_0050.jpg',
      task: 'detect',
      layers: [],
      selectedLayer: null,
      forwardResults: null,
      layerActivations: []
    },
    matrix: {
      m: 2,
      k: 3,
      n: 3,
      act: 'silu',
      X: [[0.8, -0.4, 0.5], [-0.3, 0.9, -0.2]],
      W: [[0.6, 0.2, -0.5], [-0.4, 0.7, 0.3], [0.5, -0.6, 0.8]],
      Y: []
    },
    inversion: {
      targetClass: 0,
      tvReg: 0.015,
      steps: 15,
      vector: [0.824, -0.412, 0.991, -0.105],
      loss: 0.0412,
      risk: 0.18
    },
    surgery: {
      spectrum: [12.4, 3.2, 2.1, 1.6, 1.2, 0.9, 0.7, 0.4],
      originalSpectrum: [12.4, 3.2, 2.1, 1.6, 1.2, 0.9, 0.7, 0.4],
      alpha: 0.5,
      effRank: 18.4,
      frobenius: 14.82
    },
    media: {
      preset: 'demucs',
      depthNear: 20,
      depthFar: 100,
      depthDolly: 15
    }
  };

  // ─── Tab Synchronization ─────────────────────────────────────────
  const mlPanel = document.getElementById('panel-ml-learning');

  window.initMlLearningTab = function () {
    startOpticsLoop();
    startDagLoop();
    renderDepthMap();
    if (window.MLStateBus.dag.nodes.length === 0) {
      loadModelGraph(window.MLStateBus.model.path);
    }
  };

  if (mlPanel) {
    const observer = new MutationObserver(() => {
      if (mlPanel.classList.contains('active')) {
        startOpticsLoop();
        startDagLoop();
        renderDepthMap();
      } else {
        stopOpticsLoop();
        stopDagLoop();
      }
    });
    observer.observe(mlPanel, { attributes: true, attributeFilter: ['class'] });
  }

  // ─── 2.5D Optics Canvas Rendering Engine (Fixed Coordinate Scaling) ──
  const opticsCanvas = document.getElementById('ml-optics-canvas');
  let ctx = opticsCanvas ? opticsCanvas.getContext('2d') : null;

  function stopOpticsLoop() {
    if (window.MLStateBus.optics.animId) {
      cancelAnimationFrame(window.MLStateBus.optics.animId);
      window.MLStateBus.optics.animId = null;
    }
  }

  function startOpticsLoop() {
    if (!window.MLStateBus.optics.animId && window.MLStateBus.optics.playing) {
      opticsLoop();
    }
  }

  function drawPrism(x, y, w, h, title, sub, color, isMoE) {
    if (!ctx) return;
    ctx.save();
    const grad = ctx.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.09)');
    grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.03)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.07)');

    ctx.fillStyle = grad;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    const slices = isMoE ? 4 : 3;
    for (let i = 1; i < slices; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (w / slices) * i, y + 4);
      ctx.lineTo(x + (w / slices) * i, y + h - 4);
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(title, x + 6, y - 8);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText(sub, x + 6, y + h + 14);
    ctx.restore();
  }

  function opticsLoop() {
    if (!ctx || !opticsCanvas) return;
    const bus = window.MLStateBus.optics;
    bus.time += 0.035;

    const w = opticsCanvas.width;
    const h = opticsCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // Subtle coordinate grid background
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += 40) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
    }
    for (let gy = 0; gy < h; gy += 40) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    const rgb = wavelengthToRGB(bus.wavelength);
    const beamColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    const glowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`;

    const layerW = 54;
    const layerH = 170;
    const layerY = (h - layerH) / 2;

    const l1X = 180;
    const l2X = 360;
    const l3X = 540;
    const l4X = 720;

    if (bus.profile === 'transformer') {
      drawPrism(l1X, layerY, layerW, layerH, 'L0: Token Embd', 'W_e [V x D]', '#06b6d4', false);
      drawPrism(l2X, layerY - 15, layerW, layerH + 30, 'L1: Conv / MoE Router', 'Gating Network', '#f59e0b', true);
      drawPrism(l3X, layerY, layerW, layerH, 'L2: Self-Attn Lens', 'Q, K, V Proj', '#8b5cf6', false);
      drawPrism(l4X, layerY + 10, layerW, layerH - 20, 'L3: Unembed Focus', 'W_u [D x V]', '#10b981', false);
    } else if (bus.profile === 'conv') {
      drawPrism(l1X, layerY, layerW, layerH, 'Stem: Conv2d', '3x3 s2 k=64', '#06b6d4', false);
      drawPrism(l2X, layerY - 10, layerW, layerH + 20, 'C2f Bottleneck', 'Split & Concat', '#8b5cf6', true);
      drawPrism(l3X, layerY, layerW, layerH, 'SPPF Pyramid', 'Maxpool 5/9/13', '#f59e0b', false);
      drawPrism(l4X, layerY + 15, layerW, layerH - 30, 'Detect Head', 'Box + Cls DFL', '#f43f5e', false);
    } else {
      drawPrism(l1X, layerY, layerW, layerH, 'U Basis', 'Left Singular', '#06b6d4', false);
      drawPrism(l2X, layerY - 20, layerW, layerH + 40, 'Σ Singular Spec', 'Rank Filter', '#f59e0b', true);
      drawPrism(l3X, layerY, layerW, layerH, 'V^T Basis', 'Right Singular', '#8b5cf6', false);
      drawPrism(l4X, layerY + 10, layerW, layerH - 20, 'Reconstructed W', 'Ablated Output', '#10b981', false);
    }

    const rad = (bus.angle * Math.PI) / 180;
    const emitX = 40;
    const emitY = h / 2;

    ctx.save();
    ctx.shadowColor = beamColor;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = beamColor;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(emitX, emitY);
    const inY1 = emitY + (l1X - emitX) * Math.tan(rad);
    ctx.lineTo(l1X, inY1);
    ctx.stroke();

    for (let p = 0; p < 8; p++) {
      const frac = ((bus.time * 0.4 + p * 0.125) % 1);
      const px = emitX + (l1X - emitX) * frac;
      const py = emitY + (inY1 - emitY) * frac;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const eta = bus.profile === 'transformer' ? 1.48 : (bus.profile === 'conv' ? 1.62 : 1.33);
    const snellSin = Math.sin(rad) / eta;
    const internalRad = Math.asin(Math.max(-0.95, Math.min(0.95, snellSin)));
    const outY1 = inY1 + layerW * Math.tan(internalRad);

    ctx.save();
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(l1X, inY1);
    ctx.lineTo(l1X + layerW, outY1);
    ctx.stroke();
    ctx.restore();

    const beamCount = 4;
    const disperseColors = ['#06b6d4', '#8b5cf6', '#f59e0b', '#10b981'];
    for (let b = 0; b < beamCount; b++) {
      const splitOffset = (b - 1.5) * 14;
      const inY2 = outY1 + (l2X - (l1X + layerW)) * Math.tan(internalRad * 0.8) + splitOffset * 0.5;

      ctx.save();
      ctx.strokeStyle = disperseColors[b];
      ctx.lineWidth = 1.8;
      ctx.shadowColor = disperseColors[b];
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(l1X + layerW, outY1);
      ctx.lineTo(l2X, inY2);
      ctx.stroke();

      const outY2 = inY2 + layerW * Math.tan(internalRad * 0.5);
      ctx.beginPath();
      ctx.moveTo(l2X, inY2);
      ctx.lineTo(l2X + layerW, outY2);
      ctx.stroke();

      const inY3 = outY2 + (l3X - (l2X + layerW)) * Math.tan(internalRad * 0.3) + splitOffset * 0.3;
      ctx.beginPath();
      ctx.moveTo(l2X + layerW, outY2);
      ctx.lineTo(l3X, inY3);
      ctx.stroke();

      const outY3 = inY3 + layerW * Math.tan(internalRad * 0.2);
      ctx.beginPath();
      ctx.moveTo(l3X, inY3);
      ctx.lineTo(l3X + layerW, outY3);
      ctx.stroke();

      const focusTargetY = emitY + Math.sin(bus.time * 0.8) * 8;
      ctx.strokeStyle = disperseColors[b];
      ctx.beginPath();
      ctx.moveTo(l3X + layerW, outY3);
      ctx.lineTo(l4X, focusTargetY + (b - 1.5) * 6);
      ctx.stroke();
      ctx.restore();
    }

    const focalX = l4X + layerW / 2;
    const focalY = emitY + Math.sin(bus.time * 0.8) * 8;
    ctx.save();
    const focalGrad = ctx.createRadialGradient(focalX, focalY, 2, focalX, focalY, 32);
    focalGrad.addColorStop(0, '#ffffff');
    focalGrad.addColorStop(0.3, beamColor);
    focalGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = focalGrad;
    ctx.beginPath();
    ctx.arc(focalX, focalY, 32, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    for (let c = -3; c <= 3; c++) {
      const sy = emitY + c * 18;
      const actVal = Math.max(0, 1 - Math.abs(c * 18 - (focalY - emitY)) / 40);
      ctx.fillStyle = `rgba(16, 185, 129, ${actVal * 0.8 + 0.1})`;
      ctx.fillRect(l4X + layerW + 8, sy - 5, 24 * actVal + 4, 10);
    }
    ctx.restore();

    if (bus.playing) {
      bus.animId = requestAnimationFrame(opticsLoop);
    }
  }

  // Optics Controls Bindings
  const playBtn = document.getElementById('ml-optics-play-btn');
  const stepBtn = document.getElementById('ml-optics-step-btn');
  const resetBtn = document.getElementById('ml-optics-reset-btn');
  const wlInput = document.getElementById('ml-optics-wavelength');
  const angleInput = document.getElementById('ml-optics-angle');
  const profileSelect = document.getElementById('ml-optics-profile');

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      window.MLStateBus.optics.playing = !window.MLStateBus.optics.playing;
      playBtn.textContent = window.MLStateBus.optics.playing ? '⏸ Pause' : '▶ Play';
      if (window.MLStateBus.optics.playing) opticsLoop();
    });
  }

  if (stepBtn) {
    stepBtn.addEventListener('click', () => {
      window.MLStateBus.optics.time += 0.2;
      if (!window.MLStateBus.optics.playing) opticsLoop();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      window.MLStateBus.optics.angle = 0;
      window.MLStateBus.optics.wavelength = 520;
      window.MLStateBus.optics.time = 0;
      if (wlInput) wlInput.value = '520';
      if (angleInput) angleInput.value = '0';
      updateOpticsLabels();
      if (!window.MLStateBus.optics.playing) opticsLoop();
    });
  }

  function updateOpticsLabels() {
    const bus = window.MLStateBus.optics;
    const lblWl = document.getElementById('ml-lbl-wavelength');
    const valWl = document.getElementById('ml-val-wavelength');
    const lblAng = document.getElementById('ml-lbl-angle');
    const valAng = document.getElementById('ml-val-angle');
    if (lblWl) lblWl.textContent = `${bus.wavelength}nm`;
    if (valWl) valWl.textContent = `${bus.wavelength}nm`;
    if (lblAng) lblAng.textContent = `${bus.angle}°`;
    if (valAng) valAng.textContent = `${bus.angle}°`;
  }

  if (wlInput) {
    wlInput.addEventListener('input', (e) => {
      window.MLStateBus.optics.wavelength = Number(e.target.value);
      updateOpticsLabels();
    });
  }

  if (angleInput) {
    angleInput.addEventListener('input', (e) => {
      window.MLStateBus.optics.angle = Number(e.target.value);
      updateOpticsLabels();
    });
  }

  if (profileSelect) {
    profileSelect.addEventListener('change', (e) => {
      window.MLStateBus.optics.profile = e.target.value;
      const etaElem = document.getElementById('ml-optics-eta');
      if (etaElem) {
        if (e.target.value === 'transformer') etaElem.textContent = '1.48';
        else if (e.target.value === 'conv') etaElem.textContent = '1.62';
        else etaElem.textContent = '1.33';
      }
    });
  }

  // ─── Interactive Layer DAG Visualizer (Harness-Style) ────────────
  const dagCanvas = document.getElementById('ml-dag-canvas');
  let dctx = dagCanvas ? dagCanvas.getContext('2d') : null;
  const dagTooltip = document.getElementById('ml-dag-tooltip');

  function resizeDagCanvas() {
    if (!dagCanvas || !dagCanvas.parentElement) return;
    const rect = dagCanvas.parentElement.getBoundingClientRect();
    const w = rect.width || 800;
    const h = 360;
    const dpr = window.devicePixelRatio || 1;
    if (dagCanvas.width !== w * dpr || dagCanvas.height !== h * dpr) {
      dagCanvas.width = w * dpr;
      dagCanvas.height = h * dpr;
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.scale(dpr, dpr);
    }
  }

  function startDagLoop() {
    if (!window.MLStateBus.dag.animId) {
      dagLoop();
    }
  }

  function stopDagLoop() {
    if (window.MLStateBus.dag.animId) {
      cancelAnimationFrame(window.MLStateBus.dag.animId);
      window.MLStateBus.dag.animId = null;
    }
  }

  function getCategoryColor(category, role) {
    const cat = (category || '').toLowerCase();
    const rol = (role || '').toLowerCase();
    if (cat.includes('conv') || rol.includes('conv')) return '#06b6d4';
    if (cat.includes('norm') || rol.includes('norm') || rol.includes('bn')) return '#10b981';
    if (cat.includes('backbone') || rol.includes('c2f') || rol.includes('bottle') || rol.includes('res')) return '#8b5cf6';
    if (cat.includes('attention') || cat.includes('pool') || rol.includes('sppf') || rol.includes('attn')) return '#f59e0b';
    if (cat.includes('head') || rol.includes('detect') || rol.includes('pose') || rol.includes('cls')) return '#f43f5e';
    if (cat.includes('mlp') || rol.includes('linear') || rol.includes('fc')) return '#3b82f6';
    return '#94a3b8';
  }

  function fitDagView() {
    const nodes = window.MLStateBus.dag.nodes;
    if (!nodes || nodes.length === 0 || !dagCanvas) return;
    const rect = dagCanvas.getBoundingClientRect();
    const w = rect.width || 800;
    const h = 360;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      minX = Math.min(minX, n.x - n.w / 2);
      maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2);
      maxY = Math.max(maxY, n.y + n.h / 2);
    });

    const graphW = Math.max(100, maxX - minX);
    const graphH = Math.max(60, maxY - minY);
    const margin = 50;

    const scaleX = (w - margin * 2) / graphW;
    const scaleY = (h - margin * 2) / graphH;
    const zoom = Math.max(0.3, Math.min(1.4, Math.min(scaleX, scaleY)));

    window.MLStateBus.dag.zoom = zoom;
    window.MLStateBus.dag.panX = (w / 2) - ((minX + maxX) / 2) * zoom;
    window.MLStateBus.dag.panY = (h / 2) - ((minY + maxY) / 2) * zoom;
  }

  function dagLoop() {
    if (!dctx || !dagCanvas) return;
    resizeDagCanvas();

    const rect = dagCanvas.getBoundingClientRect();
    const w = rect.width || 800;
    const h = 360;

    dctx.clearRect(0, 0, w, h);

    const dag = window.MLStateBus.dag;
    const zoom = dag.zoom;
    const panX = dag.panX;
    const panY = dag.panY;

    dctx.save();
    dctx.translate(panX, panY);
    dctx.scale(zoom, zoom);

    // Subtle background matrix grid points
    dctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    const startX = Math.floor((-panX / zoom) / 30) * 30;
    const endX = Math.ceil(((w - panX) / zoom) / 30) * 30;
    const startY = Math.floor((-panY / zoom) / 30) * 30;
    const endY = Math.ceil(((h - panY) / zoom) / 30) * 30;
    for (let x = startX; x < endX; x += 30) {
      for (let y = startY; y < endY; y += 30) {
        dctx.fillRect(x - 0.5, y - 0.5, 1, 1);
      }
    }

    // Draw Edges (Directed Curves)
    dag.edges.forEach(e => {
      const src = dag.nodes[e.from];
      const dst = dag.nodes[e.to];
      if (!src || !dst) return;

      const sx = src.x + src.w / 2;
      const sy = src.y;
      const tx = dst.x - dst.w / 2;
      const ty = dst.y;
      const cpx1 = sx + (tx - sx) * 0.5;
      const cpy1 = sy;
      const cpx2 = sx + (tx - sx) * 0.5;
      const cpy2 = ty;

      dctx.save();
      const grad = dctx.createLinearGradient(sx, sy, tx, ty);
      grad.addColorStop(0, src.color);
      grad.addColorStop(1, dst.color);
      dctx.strokeStyle = grad;
      dctx.lineWidth = 1.8;
      dctx.beginPath();
      dctx.moveTo(sx, sy);
      dctx.bezierCurveTo(cpx1, cpy1, cpx2, cpy2, tx, ty);
      dctx.stroke();

      // Arrow head
      const arrowLen = 6;
      dctx.fillStyle = dst.color;
      dctx.beginPath();
      dctx.moveTo(tx, ty);
      dctx.lineTo(tx - arrowLen, ty - 3.5);
      dctx.lineTo(tx - arrowLen, ty + 3.5);
      dctx.closePath();
      dctx.fill();
      dctx.restore();
    });

    // Wavefront animated particles flowing along edges
    if (dag.wavefrontActive && dag.edges.length > 0) {
      if (Math.random() < 0.25) {
        const edge = dag.edges[Math.floor(Math.random() * dag.edges.length)];
        dag.particles.push({ edge, t: 0, speed: 0.015 + Math.random() * 0.015 });
      }

      for (let i = dag.particles.length - 1; i >= 0; i--) {
        const p = dag.particles[i];
        p.t += p.speed;
        if (p.t >= 1) {
          dag.particles.splice(i, 1);
          continue;
        }

        const src = dag.nodes[p.edge.from];
        const dst = dag.nodes[p.edge.to];
        if (!src || !dst) continue;

        const sx = src.x + src.w / 2;
        const sy = src.y;
        const tx = dst.x - dst.w / 2;
        const ty = dst.y;
        const cpx1 = sx + (tx - sx) * 0.5;
        const cpy1 = sy;
        const cpx2 = sx + (tx - sx) * 0.5;
        const cpy2 = ty;

        // Cubic bezier interpolation
        const u = 1 - p.t;
        const px = (u ** 3) * sx + 3 * (u ** 2) * p.t * cpx1 + 3 * u * (p.t ** 2) * cpx2 + (p.t ** 3) * tx;
        const py = (u ** 3) * sy + 3 * (u ** 2) * p.t * cpy1 + 3 * u * (p.t ** 2) * cpy2 + (p.t ** 3) * ty;

        dctx.save();
        dctx.shadowColor = src.color;
        dctx.shadowBlur = 8;
        dctx.fillStyle = '#ffffff';
        dctx.beginPath();
        dctx.arc(px, py, 2.5, 0, Math.PI * 2);
        dctx.fill();
        dctx.restore();
      }
    }

    // Draw Nodes
    dag.nodes.forEach(node => {
      const isSelected = dag.selectedNode && dag.selectedNode.id === node.id;
      const isHovered = dag.hoveredNode && dag.hoveredNode.id === node.id;

      const nx = node.x - node.w / 2;
      const ny = node.y - node.h / 2;

      dctx.save();
      // Glowing halo for selected/hovered node
      if (isSelected || isHovered) {
        dctx.shadowColor = node.color;
        dctx.shadowBlur = isSelected ? 16 : 8;
      }

      // Background card
      dctx.fillStyle = isSelected ? 'rgba(30, 27, 75, 0.95)' : 'rgba(15, 23, 42, 0.9)';
      dctx.strokeStyle = isSelected ? '#ffffff' : (isHovered ? node.color : 'rgba(255, 255, 255, 0.15)');
      dctx.lineWidth = isSelected ? 2.2 : 1.2;
      dctx.beginPath();
      dctx.roundRect(nx, ny, node.w, node.h, 6);
      dctx.fill();
      dctx.stroke();

      // Left role accent bar
      dctx.fillStyle = node.color;
      dctx.beginPath();
      dctx.roundRect(nx, ny, 4, node.h, [6, 0, 0, 6]);
      dctx.fill();

      // Node label
      dctx.fillStyle = '#f8fafc';
      dctx.font = '600 11px system-ui, sans-serif';
      dctx.fillText(node.label, nx + 10, ny + 17);

      // Node shape badge
      dctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      dctx.font = '9px "JetBrains Mono", monospace';
      dctx.fillText(node.shapeStr, nx + 10, ny + 32);

      // Activation indicator dot
      if (node.activation) {
        dctx.fillStyle = node.activation.mean > 0 ? '#10b981' : '#f59e0b';
        dctx.beginPath();
        dctx.arc(nx + node.w - 10, ny + 14, 3, 0, Math.PI * 2);
        dctx.fill();
      }

      dctx.restore();
    });

    dctx.restore();

    dag.animId = requestAnimationFrame(dagLoop);
  }

  // DAG Event Bindings (Zoom, Pan, Click, Hover)
  let isDraggingDag = false;
  let dragStartX = 0;
  let dragStartY = 0;

  if (dagCanvas) {
    dagCanvas.addEventListener('mousedown', (e) => {
      isDraggingDag = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dagCanvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDraggingDag) {
        if (!dagCanvas) return;
        const rect = dagCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) {
          if (dagTooltip) dagTooltip.style.display = 'none';
          window.MLStateBus.dag.hoveredNode = null;
          return;
        }

        const worldX = (mx - window.MLStateBus.dag.panX) / window.MLStateBus.dag.zoom;
        const worldY = (my - window.MLStateBus.dag.panY) / window.MLStateBus.dag.zoom;

        let found = null;
        for (const n of window.MLStateBus.dag.nodes) {
          if (Math.abs(worldX - n.x) <= n.w / 2 && Math.abs(worldY - n.y) <= n.h / 2) {
            found = n;
            break;
          }
        }

        window.MLStateBus.dag.hoveredNode = found;
        dagCanvas.style.cursor = found ? 'pointer' : 'grab';

        if (dagTooltip) {
          if (found) {
            dagTooltip.style.display = 'block';
            dagTooltip.style.left = `${Math.min(mx + 14, rect.width - 240)}px`;
            dagTooltip.style.top = `${Math.min(my + 14, rect.height - 110)}px`;
            // Node name/role/shape come from inspects model files — never
            // interpolate them into innerHTML (DOM XSS). Build content via
            // textContent instead. found.color is from our internal palette.
            const el = (tag, style, text) => {
              const d = document.createElement(tag);
              if (style) d.style.cssText = style;
              if (text !== undefined) d.textContent = text;
              return d;
            };
            const roleEl = el('div', 'font-size:.7rem;color:var(--text-muted);margin:2px 0;');
            const roleStrong = document.createElement('strong');
            roleStrong.textContent = String(found.semanticRole ?? '');
            roleEl.append('Role: ', roleStrong);
            dagTooltip.replaceChildren(
              el('div', `font-weight:600;color:${found.color};`, String(found.name ?? '')),
              roleEl,
              el('div', "font-size:.68rem;font-family:'JetBrains Mono',monospace;color:var(--accent-cyan);", `Shape: ${found.shapeStr ?? ''}`),
              el('div', 'font-size:.65rem;color:var(--text-muted);margin-top:4px;', 'Click node to inspect transfer function & activations')
            );
          } else {
            dagTooltip.style.display = 'none';
          }
        }
        return;
      }

      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      window.MLStateBus.dag.panX += dx;
      window.MLStateBus.dag.panY += dy;
    });

    window.addEventListener('mouseup', (e) => {
      if (isDraggingDag) {
        isDraggingDag = false;
        if (dagCanvas) dagCanvas.style.cursor = window.MLStateBus.dag.hoveredNode ? 'pointer' : 'grab';
      }
    });

    dagCanvas.addEventListener('click', (e) => {
      const rect = dagCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const worldX = (mx - window.MLStateBus.dag.panX) / window.MLStateBus.dag.zoom;
      const worldY = (my - window.MLStateBus.dag.panY) / window.MLStateBus.dag.zoom;

      for (const n of window.MLStateBus.dag.nodes) {
        if (Math.abs(worldX - n.x) <= n.w / 2 && Math.abs(worldY - n.y) <= n.h / 2) {
          selectLayerNode(n);
          break;
        }
      }
    });

    dagCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = dagCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const worldX = (mx - window.MLStateBus.dag.panX) / window.MLStateBus.dag.zoom;
      const worldY = (my - window.MLStateBus.dag.panY) / window.MLStateBus.dag.zoom;

      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      const newZoom = Math.max(0.2, Math.min(4.0, window.MLStateBus.dag.zoom * factor));

      window.MLStateBus.dag.zoom = newZoom;
      window.MLStateBus.dag.panX = mx - worldX * newZoom;
      window.MLStateBus.dag.panY = my - worldY * newZoom;
    }, { passive: false });
  }

  // Zoom Buttons
  document.getElementById('ml-dag-zoom-in')?.addEventListener('click', () => {
    window.MLStateBus.dag.zoom = Math.min(4.0, window.MLStateBus.dag.zoom * 1.25);
  });
  document.getElementById('ml-dag-zoom-out')?.addEventListener('click', () => {
    window.MLStateBus.dag.zoom = Math.max(0.2, window.MLStateBus.dag.zoom * 0.8);
  });
  document.getElementById('ml-dag-reset-view')?.addEventListener('click', () => {
    window.MLStateBus.dag.zoom = 1.0;
    window.MLStateBus.dag.panX = 40;
    window.MLStateBus.dag.panY = 180;
  });
  document.getElementById('ml-dag-fit-view')?.addEventListener('click', fitDagView);

  const wfToggle = document.getElementById('ml-dag-wavefront-toggle');
  if (wfToggle) {
    wfToggle.addEventListener('click', () => {
      window.MLStateBus.dag.wavefrontActive = !window.MLStateBus.dag.wavefrontActive;
      wfToggle.textContent = window.MLStateBus.dag.wavefrontActive ? 'Wavefront: ON' : 'Wavefront: OFF';
    });
  }

  // ─── Layer Deep Dive & Activation Heatmap Renderer ───────────────
  const heatmapCanvas = document.getElementById('ml-layer-heatmap-canvas');
  let hctx = heatmapCanvas ? heatmapCanvas.getContext('2d') : null;

  function renderLayerHeatmap(slice2D) {
    if (!hctx || !heatmapCanvas) return;
    const w = heatmapCanvas.width;
    const h = heatmapCanvas.height;
    hctx.clearRect(0, 0, w, h);

    const grid = slice2D && slice2D.length > 0 ? slice2D : [
      [0.2, 0.4, 0.6, 0.8],
      [0.1, 0.3, 0.5, 0.7],
      [0.0, 0.2, 0.4, 0.9],
      [-0.2, 0.1, 0.3, 0.5]
    ];

    const rows = grid.length;
    const cols = grid[0].length;
    const cellW = w / cols;
    const cellH = h / rows;

    let minV = Infinity, maxV = -Infinity;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        minV = Math.min(minV, grid[r][c]);
        maxV = Math.max(maxV, grid[r][c]);
      }
    }
    const range = (maxV - minV) || 1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const val = grid[r][c];
        const norm = Math.max(0, Math.min(1, (val - minV) / range));
        // Interpolate plasma / cool to hot
        const red = Math.round(norm * 240);
        const green = Math.round(Math.sin(norm * Math.PI) * 180);
        const blue = Math.round((1 - norm) * 220 + 30);
        hctx.fillStyle = `rgb(${red}, ${green}, ${blue})`;
        hctx.fillRect(c * cellW, r * cellH, cellW, cellH);
      }
    }

    heatmapCanvas.onmousemove = (e) => {
      const rect = heatmapCanvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (w / rect.width);
      const my = (e.clientY - rect.top) * (h / rect.height);
      const col = Math.floor(mx / cellW);
      const row = Math.floor(my / cellH);
      if (row >= 0 && row < rows && col >= 0 && col < cols) {
        const val = grid[row][col];
        const info = document.getElementById('ml-heatmap-hover-info');
        if (info) info.textContent = `Cell [${row}, ${col}] Activation: ${val.toFixed(4)}`;
      }
    };
  }

  const weightCache = new Map();
  function weightBox() {
    let box = document.getElementById('ml-detail-weights');
    if (!box) {
      const host = document.getElementById('ml-detail-desc');
      if (!host || !host.parentElement) return null;
      box = document.createElement('div');
      box.id = 'ml-detail-weights';
      box.style.cssText = 'font-size:.72rem;line-height:1.5;color:var(--text-secondary);margin-top:8px;padding:8px 10px;background:var(--bg-secondary);border-radius:4px;';
      host.parentElement.appendChild(box);
    }
    return box;
  }
  async function showWeightStats(node) {
    const box = weightBox();
    if (!box || !node) return;
    const key = window.MLStateBus.model.path + '::' + node.name;
    const show = (st) => {
      box.textContent = st
        ? 'Its weights: ' + st.elementCount + ' numbers, average ' + st.mean + ', spread ' + st.std + ', range ' + st.min + ' to ' + st.max + ', size (Frobenius norm) ' + st.frobeniusNorm + ', ' + (Number(st.sparsity) * 100).toFixed(1) + '% are zero.'
        : 'Its weights: not available for this model.';
    };
    if (weightCache.has(key)) { show(weightCache.get(key)); return; }
    box.textContent = 'Reading its weights...';
    try {
      const res = await toolFetch({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'reverse_tool', params: { action: 'analyze_model_layer', target: window.MLStateBus.model.path, authorization: 'lab', options: { layer: node.name } } })
      });
      const json = res.ok ? await res.json() : null;
      const st = json && json.success !== false && json.data && json.data.elementCount !== undefined ? json.data : null;
      if (st) weightCache.set(key, st);
      if (window.MLStateBus.dag.selectedNode === node) show(st);
    } catch (e) {
      if (window.MLStateBus.dag.selectedNode === node) show(null);
    }
  }

  function selectLayerNode(node) {
    if (!node) return;
    window.MLStateBus.dag.selectedNode = node;
    window.MLStateBus.model.selectedLayer = node;

    // Update Detail Panel DOM
    const nameEl = document.getElementById('ml-detail-name');
    const roleBadge = document.getElementById('ml-detail-role-badge');
    const shapeEl = document.getElementById('ml-detail-shape');
    const dtypeEl = document.getElementById('ml-detail-dtype');
    const descEl = document.getElementById('ml-detail-desc');
    const formulaEl = document.getElementById('ml-detail-formula');

    if (nameEl) nameEl.textContent = node.name;
    if (roleBadge) {
      roleBadge.textContent = node.semanticRole || 'Layer';
      roleBadge.style.background = node.color;
      roleBadge.style.color = '#000';
    }
    if (shapeEl) shapeEl.textContent = node.shapeStr;
    if (dtypeEl) dtypeEl.textContent = node.dtype || 'float16';
    if (descEl) descEl.textContent = node.description || 'Applies linear or non-linear receptive field transformations.';

    // Dynamic formula mapping
    if (formulaEl) {
      const rol = (node.semanticRole || '').toLowerCase();
      if (rol.includes('conv')) formulaEl.textContent = 'Y = \\sigma(\\text{BN}(W * X + b_{\\text{fused}}))';
      else if (rol.includes('c2f') || rol.includes('bottle')) formulaEl.textContent = 'Y = \\text{Concat}(\\text{Conv}_1(X), \\sum \\text{Bottlenecks}) \\times W_2';
      else if (rol.includes('sppf') || rol.includes('pool')) formulaEl.textContent = 'Y = \\text{Concat}(X, \\text{MaxPool}_5, \\text{MaxPool}_9, \\text{MaxPool}_{13}) \\times W';
      else if (rol.includes('attn')) formulaEl.textContent = 'A = \\text{Softmax}\\left(\\frac{Q K^T}{\\sqrt{d_k}}\\right) V';
      else if (rol.includes('head') || rol.includes('detect')) formulaEl.textContent = '\\hat{B} = \\text{DFL}(W_{\\text{reg}} * X), \\quad \\hat{C} = \\sigma(W_{\\text{cls}} * X)';
      else formulaEl.textContent = 'Y = \\sigma(X W^T + b)';
    }

    if (formulaEl) {
      formulaEl.title = formulaEl.textContent;
      formulaEl.textContent = plainFormula(node.semanticRole);
    }

    showWeightStats(node);

    // Update activation stats
    const act = node.activation;
    const meanEl = document.getElementById('ml-act-mean');
    const stdEl = document.getElementById('ml-act-std');
    const minmaxEl = document.getElementById('ml-act-minmax');
    const sparsEl = document.getElementById('ml-act-sparsity');

    if (act) {
      if (meanEl) meanEl.textContent = act.mean.toFixed(4);
      if (stdEl) stdEl.textContent = act.std.toFixed(4);
      if (minmaxEl) minmaxEl.textContent = `${act.min.toFixed(2)} / ${act.max.toFixed(2)}`;
      if (sparsEl) sparsEl.textContent = `${(act.sparsity * 100).toFixed(1)}%`;
      renderLayerHeatmap(act.slice);
    } else {
      if (meanEl) meanEl.textContent = '--';
      if (stdEl) stdEl.textContent = '--';
      if (minmaxEl) minmaxEl.textContent = '--';
      if (sparsEl) sparsEl.textContent = '--';
      renderLayerHeatmap(null);
    }
  }

  // ─── Custom Model Graph Loader (Zero Hardcoding) ─────────────────
  function loadNote(text, isError) {
    const input = document.getElementById('ml-model-path-input');
    if (!input || !input.parentElement) return;
    let note = document.getElementById('ml-load-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'ml-load-note';
      note.style.cssText = 'font-size:.72rem;margin-top:6px;';
      input.parentElement.insertAdjacentElement('afterend', note);
    }
    note.textContent = text || '';
    note.style.color = isError ? 'var(--accent-amber)' : 'var(--text-muted)';
  }

  async function loadModelGraph(modelPath) {
    const statusBadge = document.getElementById('ml-loaded-model-badge');
    const inspectBtn = document.getElementById('ml-inspect-model-btn');
    if (statusBadge) statusBadge.textContent = 'Inspecting...';
    if (inspectBtn) inspectBtn.disabled = true;

    try {
      const res = await toolFetch({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'reverse_tool',
          params: {
            action: 'infer_layer_roles',
            target: modelPath,
            authorization: 'lab'
          }
        })
      });

      const json = await res.json();
      const rawLayers = json?.data?.layers || [];
      if (!res.ok || json?.success === false || rawLayers.length === 0) {
        const why = (json && json.error) || (res.ok ? 'no layers could be read from this file (PyTorch checkpoints need PyTorch installed on the server; GGUF files do not)' : 'the server answered ' + res.status);
        if (statusBadge) statusBadge.textContent = 'No layers loaded';
        loadNote(why, true);
        window.MLStateBus.dag.nodes = [];
        window.MLStateBus.dag.edges = [];
        captureBuild();
        setState(1, 'could not load', 'badge-amber');
        setState(2, 'no layers', 'badge-amber');
        return;
      }
      loadNote('', false);

      // Group or map layers into clean DAG nodes
      const nodes = [];
      const edges = [];
      const spacingX = 140;

      // Filter and sample primary structural layers to avoid 600 overlapping nodes in small canvas
      const sampled = rawLayers.length > 24
        ? rawLayers.filter((l, i) => i % Math.ceil(rawLayers.length / 16) === 0 || l.name.includes('conv.weight') || l.name.includes('fc') || l.name.includes('head') || l.name.includes('attn_q'))
        : rawLayers;

      sampled.forEach((l, idx) => {
        const shape = l.shape || [];
        const shapeStr = `[${shape.join(', ')}]`;
        const label = l.name.split('.').slice(-2).join('.');
        const color = getCategoryColor(l.functionalCategory, l.semanticRole);

        nodes.push({
          id: idx,
          name: l.name,
          label: label.length > 18 ? label.slice(0, 18) + '..' : label,
          shape: shape,
          shapeStr: shapeStr,
          dtype: l.dtype || l.type || 'unknown',
          semanticRole: l.semanticRole || 'layer',
          functionalCategory: l.functionalCategory || 'general',
          description: l.description,
          color: color,
          x: idx * spacingX + 40,
          y: (idx % 2 === 0 ? 0 : 40),
          w: 110,
          h: 46,
          activation: null
        });

        if (idx > 0) {
          edges.push({ from: idx - 1, to: idx });
        }
      });

      window.MLStateBus.dag.nodes = nodes;
      window.MLStateBus.dag.edges = edges;
      window.MLStateBus.model.layers = rawLayers;
      captureBuild();
      loadTrace(modelPath);

      const nodeCountBadge = document.getElementById('ml-dag-node-count');
      if (nodeCountBadge) nodeCountBadge.textContent = `${rawLayers.length} layers (${nodes.length} mapped)`;
      if (statusBadge) statusBadge.textContent = `Loaded: ${rawLayers.length} tensors`;

      fitDagView();
      if (nodes.length > 0) {
        selectLayerNode(nodes[0]);
      }
    } catch (err) {
      if (statusBadge) statusBadge.textContent = 'Inspection Error';
      loadNote('The request failed: ' + String((err && err.message) || err).slice(0, 160), true);
    } finally {
      if (inspectBtn) inspectBtn.disabled = false;
    }
  }

  // Model Pills
  document.querySelectorAll('.ml-model-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.path;
      const inp = document.getElementById('ml-model-path-input');
      if (inp) inp.value = p;
      loadModelGraph(p);
    });
  });

  // Inspect Button
  document.getElementById('ml-inspect-model-btn')?.addEventListener('click', () => {
    const p = document.getElementById('ml-model-path-input')?.value;
    if (p) loadModelGraph(p);
  });

  // Image Pills
  document.querySelectorAll('.ml-image-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.path;
      const inp = document.getElementById('ml-image-path-input');
      if (inp) inp.value = p;
    });
  });

  // Run Forward Pass Button (With Image vs Without Image)
  const runForwardBtn = document.getElementById('ml-run-forward-btn');
  if (runForwardBtn) {
    runForwardBtn.addEventListener('click', async () => {
      const modelPath = document.getElementById('ml-model-path-input')?.value;
      const imagePath = document.getElementById('ml-image-path-input')?.value || '';
      const task = document.getElementById('ml-forward-task-select')?.value || 'detect';
      const statusBadge = document.getElementById('ml-forward-status-badge');
      const srcBadge = document.getElementById('ml-activation-source-badge');

      if (!modelPath) return;

      runForwardBtn.disabled = true;
      runForwardBtn.textContent = '⚡ Forwarding Wavefront...';
      if (statusBadge) statusBadge.textContent = 'Forward: Running';

      try {
        const res = await toolFetch({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'reverse_tool',
            params: {
              action: 'run_torch_nn',
              target: modelPath,
              authorization: 'lab',
              sessionId: 'ml-learning-forward-' + Date.now(),
              options: {
                image: imagePath.trim() || undefined,
                task: task
              }
            }
          })
        });

        const json = await res.json();
        const data = json?.data;
        const acts = data?.layerActivations || [];

        window.MLStateBus.model.forwardResults = data;
        window.MLStateBus.model.layerActivations = acts;

        // Map live activation slices to DAG nodes
        acts.forEach((act, i) => {
          if (i < window.MLStateBus.dag.nodes.length) {
            window.MLStateBus.dag.nodes[i].activation = act;
          }
        });

        refreshBuild();

        if (srcBadge) {
          if (imagePath.trim()) {
            srcBadge.textContent = 'Source: Real Image Stimulus';
            srcBadge.className = 'badge badge-cyan';
          } else {
            srcBadge.textContent = 'Source: Baseline Prior (Without Image)';
            srcBadge.className = 'badge badge-amber';
          }
        }

        if (statusBadge) {
          const detCount = data?.detections ? data.detections.length : (data?.topClass || 'Done');
          statusBadge.textContent = `Forward: ${detCount} results`;
        }

        // Refresh selected node details
        const selected = window.MLStateBus.dag.selectedNode;
        if (selected) {
          selectLayerNode(selected);
        } else if (window.MLStateBus.dag.nodes.length > 0) {
          selectLayerNode(window.MLStateBus.dag.nodes[0]);
        }
      } catch (e) {
        if (statusBadge) statusBadge.textContent = 'Forward: Error';
      } finally {
        runForwardBtn.disabled = false;
        runForwardBtn.textContent = '⚡ Run Forward Pass';
      }
    });
  }

  // ─── Interactive Matrix Workbench (Y = X W^T) ───────────────────
  const dimM = document.getElementById('ml-dim-m');
  const dimK = document.getElementById('ml-dim-k');
  const dimN = document.getElementById('ml-dim-n');
  const actBtns = document.querySelectorAll('.ml-act-btn');
  const gridContainer = document.getElementById('ml-matrix-grid-container');
  const dotInfo = document.getElementById('ml-matrix-dot-product-info');
  const flopsBadge = document.getElementById('ml-matrix-flops');

  function applyActivation(val, act) {
    if (act === 'relu') return Math.max(0, val);
    if (act === 'silu') return val / (1 + Math.exp(-val));
    if (act === 'swiglu') return (val / (1 + Math.exp(-val))) * (val * 0.7 + 0.1);
    if (act === 'softmax') return Math.exp(val);
    return val;
  }

  function recalculateMatrix() {
    const m = window.MLStateBus.matrix.m;
    const k = window.MLStateBus.matrix.k;
    const n = window.MLStateBus.matrix.n;
    const act = window.MLStateBus.matrix.act;

    const X = [];
    for (let r = 0; r < m; r++) {
      const row = [];
      for (let c = 0; c < k; c++) {
        row.push(Number((Math.sin(r * 2.1 + c * 1.3) * 0.9).toFixed(2)));
      }
      X.push(row);
    }

    const W = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < k; c++) {
        row.push(Number((Math.cos(r * 1.7 + c * 2.4) * 0.85).toFixed(2)));
      }
      W.push(row);
    }

    const Y = [];
    for (let r = 0; r < m; r++) {
      const yRow = [];
      for (let j = 0; j < n; j++) {
        let dot = 0;
        for (let c = 0; c < k; c++) {
          dot += X[r][c] * W[j][c];
        }
        yRow.push(Number(applyActivation(dot, act).toFixed(3)));
      }
      Y.push(yRow);
    }

    if (act === 'softmax') {
      for (let r = 0; r < m; r++) {
        const sumExp = Y[r].reduce((acc, v) => acc + v, 0) || 1;
        for (let j = 0; j < n; j++) {
          Y[r][j] = Number((Y[r][j] / sumExp).toFixed(3));
        }
      }
    }

    window.MLStateBus.matrix.X = X;
    window.MLStateBus.matrix.W = W;
    window.MLStateBus.matrix.Y = Y;

    if (flopsBadge) flopsBadge.textContent = `${2 * m * k * n} FLOPs`;
    renderMatrixGrids();
  }

  function renderGridTable(matrix, name, color, isTransposed) {
    let html = `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">`;
    html += `<span style="font-size:.72rem;font-weight:600;color:${color};font-family:'JetBrains Mono',monospace;">${name}</span>`;
    html += `<div style="background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:4px;padding:4px;display:grid;grid-template-columns:repeat(${matrix[0]?.length || 1}, 1fr);gap:3px;">`;

    for (let r = 0; r < matrix.length; r++) {
      for (let c = 0; c < matrix[r].length; c++) {
        const val = matrix[r][c];
        html += `<div class="ml-matrix-cell" data-matrix="${name}" data-row="${r}" data-col="${c}" style="font-family:'JetBrains Mono',monospace;font-size:.68rem;padding:4px 6px;text-align:center;border-radius:3px;background:rgba(255,255,255,0.03);min-width:38px;cursor:pointer;">${val}</div>`;
      }
    }
    html += `</div></div>`;
    return html;
  }

  function renderMatrixGrids() {
    if (!gridContainer) return;
    const { X, W, Y } = window.MLStateBus.matrix;
    gridContainer.innerHTML = `
      ${renderGridTable(X, 'X [M×K]', 'var(--accent-cyan)', false)}
      <div style="font-size:1.2rem;color:var(--text-muted);font-weight:bold;">&times;</div>
      ${renderGridTable(W, 'W^T [K×N]', 'var(--accent-purple)', true)}
      <div style="font-size:1.2rem;color:var(--text-muted);font-weight:bold;">=</div>
      ${renderGridTable(Y, 'Y [M×N]', 'var(--accent-green)', false)}
    `;

    gridContainer.querySelectorAll('.ml-matrix-cell').forEach(cell => {
      cell.addEventListener('mouseenter', () => {
        const mat = cell.dataset.matrix;
        const r = Number(cell.dataset.row);
        const c = Number(cell.dataset.col);
        if (mat.startsWith('Y') && dotInfo) {
          const { X, W, Y } = window.MLStateBus.matrix;
          let formula = `Y[${r},${c}] = σ( `;
          const terms = [];
          for (let k = 0; k < X[0].length; k++) {
            terms.push(`(${X[r][k]} × ${W[c][k]})`);
          }
          formula += terms.join(' + ') + ` ) = ${Y[r][c]}`;
          dotInfo.textContent = formula;
        }
      });
    });
  }

  [dimM, dimK, dimN].forEach(slider => {
    if (slider) {
      slider.addEventListener('input', () => {
        if (dimM) {
          window.MLStateBus.matrix.m = Number(dimM.value);
          document.getElementById('ml-lbl-dim-m').textContent = dimM.value;
        }
        if (dimK) {
          window.MLStateBus.matrix.k = Number(dimK.value);
          document.getElementById('ml-lbl-dim-k').textContent = dimK.value;
        }
        if (dimN) {
          window.MLStateBus.matrix.n = Number(dimN.value);
          document.getElementById('ml-lbl-dim-n').textContent = dimN.value;
        }
        recalculateMatrix();
      });
    }
  });

  actBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      actBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      window.MLStateBus.matrix.act = btn.dataset.act;
      recalculateMatrix();
    });
  });

  // ─── Layer Inversion Lab (Activation Maximization) ───────────────
  const targetClassSelect = document.getElementById('ml-inversion-target-class');
  const tvRegInput = document.getElementById('ml-inversion-tv');
  const inversionStepsInput = document.getElementById('ml-inversion-steps');
  const inversionRunBtn = document.getElementById('ml-inversion-run-btn');
  const inversionCanvas = document.getElementById('ml-inversion-canvas');

  function drawInversionPrototype(vector, targetClass) {
    if (!inversionCanvas) return;
    const ictx = inversionCanvas.getContext('2d');
    const w = inversionCanvas.width;
    const h = inversionCanvas.height;
    ictx.clearRect(0, 0, w, h);

    const grad = ictx.createRadialGradient(w / 2, h / 2, 8, w / 2, h / 2, 54);
    if (targetClass === 0) {
      grad.addColorStop(0, '#06b6d4');
      grad.addColorStop(0.7, '#8b5cf6');
      grad.addColorStop(1, '#020617');
      ictx.fillStyle = grad;
      ictx.beginPath();
      ictx.arc(w / 2, h / 2, 42, 0, Math.PI * 2);
      ictx.fill();
    } else if (targetClass === 1) {
      grad.addColorStop(0, '#f59e0b');
      grad.addColorStop(0.8, '#d97706');
      grad.addColorStop(1, '#020617');
      ictx.fillStyle = grad;
      ictx.fillRect(20, 20, 80, 80);
    } else if (targetClass === 2) {
      grad.addColorStop(0, '#10b981');
      grad.addColorStop(0.7, '#059669');
      grad.addColorStop(1, '#020617');
      ictx.fillStyle = grad;
      ictx.beginPath();
      ictx.ellipse(w / 2, h / 2, 44, 28, 0, 0, Math.PI * 2);
      ictx.fill();
    } else {
      ictx.fillStyle = '#f43f5e';
      for (let i = 0; i < 200; i++) {
        const x = (i * 17) % w;
        const y = (i * 29) % h;
        ictx.fillRect(x, y, 4, 4);
      }
    }
  }

  if (targetClassSelect) {
    targetClassSelect.addEventListener('change', (e) => {
      const cls = Number(e.target.value);
      window.MLStateBus.inversion.targetClass = cls;
      const badge = document.getElementById('ml-inversion-badge');
      if (badge) badge.textContent = `Target: Class ${cls}`;
      drawInversionPrototype(window.MLStateBus.inversion.vector, cls);
    });
  }

  if (tvRegInput) {
    tvRegInput.addEventListener('input', (e) => {
      const val = Number(e.target.value) / 1000;
      window.MLStateBus.inversion.tvReg = val;
      const lbl = document.getElementById('ml-val-tv');
      if (lbl) lbl.textContent = val.toFixed(3);
    });
  }

  if (inversionRunBtn) {
    inversionRunBtn.addEventListener('click', async () => {
      const targetClass = window.MLStateBus.inversion.targetClass;
      const steps = Number(inversionStepsInput?.value || 15);
      inversionRunBtn.disabled = true;
      inversionRunBtn.innerHTML = '<span>⚡ Synthesizing...</span>';

      try {
        const res = await toolFetch({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'reverse_tool',
            params: {
              action: 'reconstruct_training_samples',
              target: 'tests/fixtures/models/tiny.pt',
              authorization: 'consent',
              options: {
                explicitConsentAck: true,
                targetClass: targetClass,
                steps: steps
              }
            }
          })
        }).catch(() => null);

        const vDisp = document.getElementById('ml-inversion-vector-display');
        const lossDisp = document.getElementById('ml-inversion-loss');
        const riskDisp = document.getElementById('ml-inversion-risk');
        let payload = null;
        try { payload = res && res.ok ? await res.json() : null; } catch (e) { payload = null; }
        const data = payload && payload.success !== false ? (payload.data || null) : null;
        const vec = data && Array.isArray(data.vector) ? data.vector.map(Number).filter(Number.isFinite) : [];
        if (vec.length > 0) {
          window.MLStateBus.inversion.vector = vec;
          if (vDisp) vDisp.textContent = '[' + vec.slice(0, 8).map(x => x.toFixed(3)).join(', ') + (vec.length > 8 ? ', ...' : '') + ']';
          if (lossDisp) lossDisp.textContent = typeof data.loss === 'number' ? 'Loss: ' + data.loss.toFixed(4) : 'Loss: not reported';
          if (riskDisp) { riskDisp.textContent = 'from server'; riskDisp.className = 'badge badge-green'; }
          drawInversionPrototype(vec, targetClass);
        } else {
          const why = (payload && (payload.error || (payload.data && payload.data.error))) || (res ? 'the server returned no vector' : 'the server could not be reached');
          if (vDisp) vDisp.textContent = 'No result: ' + String(why).slice(0, 160);
          if (lossDisp) lossDisp.textContent = 'Loss: n/a';
          if (riskDisp) { riskDisp.textContent = 'no result'; riskDisp.className = 'badge badge-amber'; }
        }
      } finally {
        inversionRunBtn.disabled = false;
        inversionRunBtn.innerHTML = '<span>🔬 Synthesize Prototype</span>';
      }
    });
  }

  // ─── Weight-Space Programming Studio (SVD Surgery) ──────────────
  const svdBars = document.getElementById('ml-svd-bars');
  const surgeryAlpha = document.getElementById('ml-surgery-alpha');
  const surgeryShiftUp = document.getElementById('ml-surgery-shift-up');
  const surgeryShiftDown = document.getElementById('ml-surgery-shift-down');
  const surgeryZeroGrad = document.getElementById('ml-surgery-zero-grad');
  const surgeryExecBtn = document.getElementById('ml-weight-surgery-btn');
  let zeroGradEnabled = false;

  function renderSvdBars() {
    if (!svdBars) return;
    const spec = window.MLStateBus.surgery.spectrum;
    const maxVal = Math.max(...spec, 1);
    let html = '';

    spec.forEach((val, i) => {
      const hPercent = Math.max(6, Math.min(100, (val / maxVal) * 100));
      const color = i === 0 ? 'var(--accent-amber)' : 'var(--accent-purple)';
      html += `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;">
          <span style="font-size:.62rem;color:var(--text-muted);font-family:'JetBrains Mono',monospace;margin-bottom:3px;">${val.toFixed(1)}</span>
          <div style="width:100%;height:${hPercent}%;background:${color};border-radius:3px 3px 0 0;transition:height .15s ease;"></div>
        </div>
      `;
    });
    svdBars.innerHTML = html;

    const sumSq = spec.reduce((acc, v) => acc + v ** 2, 0);
    const frobenius = Math.sqrt(sumSq);
    const sumVal = spec.reduce((acc, v) => acc + v, 0);
    let entropy = 0;
    spec.forEach(v => {
      const p = v / sumVal;
      if (p > 0) entropy -= p * Math.log(p);
    });
    const effRank = Math.exp(entropy) * 4.2;

    window.MLStateBus.surgery.effRank = effRank;
    window.MLStateBus.surgery.frobenius = frobenius;

    const rankBadge = document.getElementById('ml-svd-rank-badge');
    const frobBadge = document.getElementById('ml-svd-frobenius');
    if (rankBadge) rankBadge.textContent = `Eff. Rank: ${effRank.toFixed(1)} / 64`;
    if (frobBadge) frobBadge.textContent = `||W||_F: ${frobenius.toFixed(2)}`;
  }

  if (surgeryAlpha) {
    surgeryAlpha.addEventListener('input', (e) => {
      const alpha = Number(e.target.value) / 100;
      window.MLStateBus.surgery.alpha = alpha;
      const lbl = document.getElementById('ml-val-alpha');
      if (lbl) lbl.textContent = `${alpha.toFixed(2)} (${Math.round(alpha * 100)}% damped)`;

      const orig = window.MLStateBus.surgery.originalSpectrum;
      const current = [...orig];
      current[0] = orig[0] * (1 - alpha);
      window.MLStateBus.surgery.spectrum = current;

      const summary = document.getElementById('ml-surgery-summary');
      if (summary) {
        const deltaRank = ((alpha * 14.2)).toFixed(1);
        const deltaFrob = (-alpha * 4.6).toFixed(1);
        summary.textContent = `Δ Rank: +${deltaRank} | Δ Frobenius: ${deltaFrob}`;
      }

      renderSvdBars();
    });
  }

  if (surgeryShiftUp) {
    surgeryShiftUp.addEventListener('click', () => {
      window.MLStateBus.surgery.spectrum = window.MLStateBus.surgery.spectrum.map((v, i) => i > 0 ? v * 1.15 : v);
      renderSvdBars();
    });
  }

  if (surgeryShiftDown) {
    surgeryShiftDown.addEventListener('click', () => {
      window.MLStateBus.surgery.spectrum = window.MLStateBus.surgery.spectrum.map((v, i) => i > 0 ? v * 0.85 : v);
      renderSvdBars();
    });
  }

  if (surgeryZeroGrad) {
    surgeryZeroGrad.addEventListener('click', () => {
      zeroGradEnabled = !zeroGradEnabled;
      surgeryZeroGrad.style.background = zeroGradEnabled ? 'var(--accent-green)' : '';
      surgeryZeroGrad.style.color = zeroGradEnabled ? '#000' : '';
      surgeryZeroGrad.textContent = zeroGradEnabled ? '🛡 Zero-Grad Active' : '🛡 Zero-Grad Guard';
    });
  }

  if (surgeryExecBtn) {
    surgeryExecBtn.addEventListener('click', async () => {
      surgeryExecBtn.disabled = true;
      surgeryExecBtn.textContent = '⚡ Applying...';

      try {
        const surgeryRes = await toolFetch({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'reverse_tool',
            params: {
              action: 'program_weight_space',
              authorization: 'lab',
              target: 'tests/fixtures/models/tiny.pt',
              options: {
                alpha: window.MLStateBus.surgery.alpha,
                rank: 1,
                subcommand: 'ablate'
              }
            }
          })
        }).catch(() => null);

        const summary = document.getElementById('ml-surgery-summary');
        let surgeryJson = null;
        try { surgeryJson = surgeryRes && surgeryRes.ok ? await surgeryRes.json() : null; } catch (e) { surgeryJson = null; }
        if (summary) {
          summary.textContent = surgeryJson && surgeryJson.success !== false
            ? 'Server accepted the request (the bars above are a demo spectrum, not your model)'
            : 'Not applied: ' + String((surgeryJson && surgeryJson.error) || (surgeryRes ? 'the server refused it' : 'the server could not be reached')).slice(0, 160);
        }
      } finally {
        surgeryExecBtn.disabled = false;
        surgeryExecBtn.textContent = '⚡ Execute Surgery';
      }
    });
  }

  // ─── Future Media Transforms Scratchpad ─────────────────────────
  const mediaTabBtns = document.querySelectorAll('.ml-media-tab-btn');
  const mediaSubpanels = document.querySelectorAll('.ml-media-subpanel');
  const mediaStatusBadge = document.getElementById('ml-media-status');
  const mediaDispatchBtn = document.getElementById('ml-media-dispatch-btn');
  const depthCanvas = document.getElementById('ml-depth-preview-canvas');

  mediaTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      mediaTabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const preset = btn.dataset.preset;
      window.MLStateBus.media.preset = preset;

      mediaSubpanels.forEach(p => {
        p.style.display = p.id === `ml-media-preset-${preset}` ? 'block' : 'none';
      });

      if (mediaStatusBadge) {
        const labels = {
          demucs: 'Preset: Demucs 4-Stem',
          depth: 'Preset: Depth Anything V2 Parallax',
          tts: 'Preset: Kokoro Neural Vocoder',
          ocr: 'Preset: OCR Token Bounding'
        };
        mediaStatusBadge.textContent = labels[preset] || 'Preset: Custom';
      }

      if (preset === 'depth') renderDepthMap();
    });
  });

  ['vocals', 'drums', 'bass', 'other'].forEach(stem => {
    const input = document.getElementById(`ml-stem-${stem}`);
    const valElem = document.getElementById(`ml-stem-${stem}-val`);
    if (input) {
      input.addEventListener('input', (e) => {
        const val = Number(e.target.value) / 100;
        if (valElem) valElem.textContent = `${val.toFixed(2)} dB`;
      });
    }
  });

  function renderDepthMap() {
    if (!depthCanvas) return;
    const dctx = depthCanvas.getContext('2d');
    const w = depthCanvas.width;
    const h = depthCanvas.height;
    dctx.clearRect(0, 0, w, h);

    const dolly = (Number(document.getElementById('ml-depth-dolly')?.value || 15) / 30) * 20;

    dctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
    dctx.lineWidth = 1;
    for (let z = 10; z < h; z += 12) {
      dctx.beginPath();
      dctx.moveTo(w / 2 - (z * 1.5) + dolly, z);
      dctx.lineTo(w / 2 + (z * 1.5) + dolly, z);
      dctx.stroke();
    }

    dctx.fillStyle = '#8b5cf6';
    dctx.fillRect(w / 2 - 25 + dolly * 1.5, h / 2 - 20, 50, 40);

    dctx.fillStyle = '#06b6d4';
    dctx.beginPath();
    dctx.arc(w / 2 + 45 + dolly * 0.8, h / 2 + 10, 16, 0, Math.PI * 2);
    dctx.fill();
  }

  ['ml-depth-near', 'ml-depth-far', 'ml-depth-dolly'].forEach(id => {
    const inp = document.getElementById(id);
    if (inp) {
      inp.addEventListener('input', () => {
        const near = document.getElementById('ml-depth-near')?.value;
        const far = document.getElementById('ml-depth-far')?.value;
        const dolly = document.getElementById('ml-depth-dolly')?.value;
        const valNear = document.getElementById('ml-val-near');
        const valFar = document.getElementById('ml-val-far');
        const valDolly = document.getElementById('ml-val-dolly');
        if (valNear) valNear.textContent = `${(near / 100).toFixed(1)}m`;
        if (valFar) valFar.textContent = `${(far / 10).toFixed(1)}m`;
        if (valDolly) valDolly.textContent = `${dolly} mm`;
        renderDepthMap();
      });
    }
  });

  if (mediaDispatchBtn) {
    mediaDispatchBtn.addEventListener('click', async () => {
      const statusElem = document.getElementById('ml-media-call-status');
      const preset = window.MLStateBus.media.preset;
      mediaDispatchBtn.disabled = true;
      mediaDispatchBtn.textContent = '🚀 Dispatching...';

      try {
        if (statusElem) statusElem.textContent = `Sending the ${preset} request to the server...`;
        const mediaRes = await toolFetch({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: preset === 'depth' || preset === 'demucs' ? 'movie_tool' : 'reverse_tool',
            params: {
              action: preset === 'depth' ? 'parallax_warp' : (preset === 'demucs' ? 'stem_split' : 'status'),
              options: { preset }
            }
          })
        }).catch(() => null);

        let mediaJson = null;
        try { mediaJson = mediaRes && mediaRes.ok ? await mediaRes.json() : null; } catch (e) { mediaJson = null; }
        const mediaOk = !!mediaJson && mediaJson.success !== false;
        if (statusElem) {
          statusElem.textContent = mediaOk
            ? 'Server accepted the ' + preset + ' request.'
            : 'Not run: ' + String((mediaJson && mediaJson.error) || (mediaRes ? 'the server refused the request (it needs real media input)' : 'the server could not be reached')).slice(0, 160);
          statusElem.style.color = mediaOk ? 'var(--accent-green)' : 'var(--accent-amber)';
        }
      } finally {
        mediaDispatchBtn.disabled = false;
        mediaDispatchBtn.textContent = '🚀 Dispatch Transform Job';
      }
    });
  }

  // ─── Reset All Presets ───────────────────────────────────────────
  const resetAllBtn = document.getElementById('ml-reset-all-btn');
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      resetBtn?.click();
      if (dimM) { dimM.value = '2'; dimM.dispatchEvent(new Event('input')); }
      if (dimK) { dimK.value = '3'; dimK.dispatchEvent(new Event('input')); }
      if (dimN) { dimN.value = '3'; dimN.dispatchEvent(new Event('input')); }
      if (actBtns[0]) actBtns[0].click();
      if (surgeryAlpha) { surgeryAlpha.value = '50'; surgeryAlpha.dispatchEvent(new Event('input')); }
      drawInversionPrototype([0.824, -0.412, 0.991, -0.105], 0);
    });
  }


  // ─── Plain-language formulas ──────────────────────────────────────
  function plainFormula(role) {
    const r = String(role || '').toLowerCase();
    if (r.includes('conv')) return 'output = squash( normalise( filter slid over the input ) + bias )';
    if (r.includes('c2f') || r.includes('bottle')) return 'output = join( a shortcut copy of the input, the input passed through several small blocks )';
    if (r.includes('sppf') || r.includes('pool')) return 'output = join( input, input summarised over bigger and bigger windows )';
    if (r.includes('attn')) return 'output = mix of the values, weighted by how well each query matches each key';
    if (r.includes('head') || r.includes('detect')) return 'output = boxes and class scores read off the final feature maps';
    return 'output = squash( input x weights + bias )';
  }

  // ─── Guided path: collapsible steps, build-up, reassembly ─────────
  const build = { nodes: [], edges: [], k: 0, trace: new Map(), traceNote: '' };
  const TRACE_DIR = '.free-llm-mcp/activation_cache';

  async function loadTrace(modelPath) {
    build.trace = new Map();
    build.traceNote = 'Running the model layer by layer...';
    renderBuild();
    try {
      const res = await toolFetch({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'reverse_tool', params: { action: 'trace_layer_execution', target: modelPath, authorization: 'lab', options: { cacheDir: TRACE_DIR } } })
      });
      const json = res.ok ? await res.json() : null;
      const steps = json && json.success !== false && json.data && Array.isArray(json.data.steps) ? json.data.steps : [];
      steps.forEach((st) => build.trace.set(st.layerName, st));
      build.traceNote = steps.length ? '' : 'The server could not run this model layer by layer' + (json && json.error ? ': ' + String(json.error).slice(0, 120) : '.');
    } catch (e) {
      build.traceNote = 'The server could not run this model layer by layer.';
    }
    renderBuild();
  }
  const paramsOf = (n) => (n && Array.isArray(n.shape) && n.shape.length ? n.shape.reduce((a, b) => a * (Number(b) || 1), 1) : 0);
  const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  const stepEl = (n) => document.getElementById('ml-step-' + n);
  const setState = (n, text, cls) => {
    const b = document.getElementById('ml-step-' + n + '-state');
    if (b) { b.textContent = text; b.className = 'badge ' + (cls || 'badge-purple') + ' ml-step-state'; }
  };

  function captureBuild() {
    const dag = window.MLStateBus.dag;
    build.nodes = dag.nodes.slice();
    build.edges = dag.edges.slice();
    build.k = build.nodes.length;
    setState(1, 'loaded', 'badge-green');
    renderBuild();
    setState(2, build.nodes.length + ' layers', 'badge-green');
  }

  function applyBuild() {
    const dag = window.MLStateBus.dag;
    const acts = window.MLStateBus.model.layerActivations || [];
    build.nodes.forEach((n, i) => { if (acts[i]) n.activation = acts[i]; });
    dag.nodes = build.nodes.slice(0, build.k);
    dag.edges = build.edges.filter((e) => e.from < build.k && e.to < build.k);
    dag.selectedNode = build.k > 0 ? build.nodes[build.k - 1] : null;
    if (build.k > 0) selectLayerNode(build.nodes[build.k - 1]);
    const badge = document.getElementById('ml-dag-node-count');
    if (badge) badge.textContent = build.k + ' of ' + build.nodes.length + ' layers shown';
  }

  function renderBuild() {
    const total = build.nodes.length;
    const progress = document.getElementById('ml-build-progress');
    const now = document.getElementById('ml-build-now');
    const bars = document.getElementById('ml-build-bars');
    if (progress) progress.textContent = build.k + ' of ' + total + ' layers';
    const next = document.getElementById('ml-build-next');
    const back = document.getElementById('ml-build-back');
    const all = document.getElementById('ml-build-all');
    if (next) next.disabled = total === 0 || build.k >= total;
    if (all) all.disabled = total === 0 || build.k >= total;
    if (back) back.disabled = build.k <= 0;

    if (now) {
      now.textContent = '';
      if (total === 0) now.textContent = 'Load a model in step 1, then press \u201cAdd next layer\u201d.';
      else if (build.k === 0) now.textContent = 'Nothing yet. Press \u201cAdd next layer\u201d to place the first layer.';
      else {
        const n = build.nodes[build.k - 1];
        const act = n.activation;
        const line = (label, value) => {
          const d = document.createElement('div');
          const b = document.createElement('strong');
          b.textContent = label + ' ';
          d.append(b, String(value));
          return d;
        };
        now.append(
          line('Layer ' + build.k + ':', n.name),
          line('What it is:', n.semanticRole || 'layer'),
          line('Its numbers:', n.shapeStr + ' = ' + fmtNum(paramsOf(n)) + ' parameters'),
          line('What it does:', plainFormula(n.semanticRole))
        );
        const st = build.trace.get(n.name);
        if (st) {
          const a = st.activationStats || {};
          now.append(
            line('Goes in:', '[' + (st.inputShape || []).join(', ') + (build.k > 1 ? ']  (the output of layer ' + (build.k - 1) + ')' : ']  (the starting input)')),
            line('Comes out:', '[' + (st.outputShape || []).join(', ') + ']  average ' + Number(a.mean).toFixed(4) + ', spread ' + Number(a.std).toFixed(4) + ', range ' + Number(a.min).toFixed(3) + ' to ' + Number(a.max).toFixed(3))
          );
        } else if (act) {
          now.append(line('Output after it:', 'average ' + act.mean.toFixed(4) + ', spread ' + act.std.toFixed(4) + ' (from your forward pass)'));
        } else {
          now.append(line('Output after it:', build.traceNote || 'not available for this model'));
        }
      }
    }

    if (bars) {
      bars.textContent = '';
      const sizes = build.nodes.slice(0, build.k).map(paramsOf);
      const max = Math.max(1, ...sizes);
      sizes.forEach((v, i) => {
        const bar = document.createElement('div');
        bar.className = 'ml-build-bar' + (i === build.k - 1 ? ' latest' : '');
        bar.style.height = Math.max(4, Math.round((v / max) * 100)) + '%';
        bar.title = build.nodes[i].name + ': ' + v.toLocaleString() + ' parameters';
        bars.appendChild(bar);
      });
    }

    if (total > 0) setState(5, build.k + ' of ' + total, build.k >= total ? 'badge-green' : 'badge-cyan');
    renderReassemble();
  }

  function renderReassemble() {
    const total = build.nodes.length;
    const done = total > 0 && build.k >= total;
    const empty = document.getElementById('ml-reassemble-empty');
    const body = document.getElementById('ml-reassemble-body');
    if (empty) empty.style.display = done ? 'none' : '';
    if (body) body.style.display = done ? '' : 'none';
    setState(6, done ? 'complete' : 'waiting', done ? 'badge-green' : 'badge-purple');
    if (!done) return;

    const byKind = new Map();
    let sum = 0;
    build.nodes.forEach((n) => {
      const kind = n.semanticRole || n.functionalCategory || 'layer';
      const e = byKind.get(kind) || { count: 0, params: 0 };
      e.count += 1;
      e.params += paramsOf(n);
      sum += paramsOf(n);
      byKind.set(kind, e);
    });
    const rows = document.getElementById('ml-reassemble-rows');
    if (rows) {
      rows.textContent = '';
      [...byKind.entries()].sort((a, b) => b[1].params - a[1].params).forEach(([kind, e]) => {
        const tr = document.createElement('tr');
        [kind, String(e.count), fmtNum(e.params)].forEach((t) => { const td = document.createElement('td'); td.textContent = t; tr.appendChild(td); });
        rows.appendChild(tr);
      });
    }
    const fr = window.MLStateBus.model.forwardResults;
    const out = fr ? (fr.detections ? fr.detections.length + ' detections' : (fr.topClass ? 'top class ' + fr.topClass : 'a result')) : null;
    const summary = document.getElementById('ml-reassemble-summary');
    if (summary) summary.textContent = build.nodes.length + ' layers shown, holding ' + fmtNum(sum) + ' parameters in the tensors listed. ' + (out ? 'The forward pass you ran produced ' + out + '.' : 'Run a forward pass in step 1 to see what the whole model produces.');
    const steps = build.nodes.map((n) => build.trace.get(n.name)).filter(Boolean);
    const chain = document.getElementById('ml-reassemble-chain');
    if (chain) {
      if (steps.length === build.nodes.length && steps.length > 0) {
        const joined = steps.every((st, i) => i === 0 || (st.receivedFromPreviousLayer === true && JSON.stringify(st.inputShape) === JSON.stringify(steps[i - 1].outputShape)));
        const last = steps[steps.length - 1];
        const a = last.activationStats || {};
        chain.textContent = (joined ? 'Chain check passed: every layer took the previous layer\u2019s output as its input and the shapes line up.' : 'Chain check failed: at least one layer did not take the previous output, or the shapes do not line up.') + ' Final output [' + (last.outputShape || []).join(', ') + '], average ' + Number(a.mean).toFixed(4) + '.';
        chain.style.color = joined ? 'var(--accent-green)' : 'var(--accent-amber)';
      } else {
        chain.textContent = build.traceNote || 'No layer-by-layer trace is available for this model, so the chain was not checked.';
        chain.style.color = 'var(--text-muted)';
      }
    }
    const note = document.getElementById('ml-reassemble-note');
    if (note) note.textContent = 'The order is the order of tensors in the file, and large models show a sample of their layers. The chain check comes from the server running the model one layer at a time.';
  }

  function refreshBuild() {
    if (build.nodes.length === 0) return;
    applyBuild();
    renderBuild();
  }

  function moveBuild(delta, toEnd) {
    const total = build.nodes.length;
    if (total === 0) return;
    build.k = toEnd ? total : Math.max(0, Math.min(total, build.k + delta));
    applyBuild();
    if (build.k > 0) fitDagView();
    renderBuild();
  }

  function setupGuide() {
    const panel = document.getElementById('panel-ml-learning');
    if (!panel) return;
    const numeric = () => Array.from(panel.querySelectorAll('details.ml-step[data-step]')).filter((d) => d.dataset.step !== 'adv');
    const goTo = (n, collapseOthers) => {
      const el = stepEl(n);
      if (!el) return;
      if (collapseOthers) numeric().forEach((d) => { if (d !== el) d.open = false; });
      el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    panel.querySelectorAll('[data-ml-next]').forEach((btn) => btn.addEventListener('click', () => {
      const n = Number(btn.getAttribute('data-ml-next'));
      if (n === 1) setState(1, build.nodes.length ? 'loaded' : 'to do', build.nodes.length ? 'badge-green' : 'badge-purple');
      goTo(n + 1, true);
    }));
    panel.querySelectorAll('[data-ml-goto]').forEach((btn) => btn.addEventListener('click', () => goTo(Number(btn.getAttribute('data-ml-goto')), true)));
    document.getElementById('ml-expand-all')?.addEventListener('click', () => panel.querySelectorAll('details').forEach((d) => { d.open = true; }));
    document.getElementById('ml-collapse-all')?.addEventListener('click', () => panel.querySelectorAll('details').forEach((d) => { d.open = false; }));

    // A closed section has no size, so the graph is fitted when its step opens.
    stepEl(2)?.addEventListener('toggle', (e) => { if (e.target.open) setTimeout(() => { fitDagView(); }, 30); });

    document.getElementById('ml-build-next')?.addEventListener('click', () => moveBuild(1));
    document.getElementById('ml-build-back')?.addEventListener('click', () => moveBuild(-1));
    document.getElementById('ml-build-all')?.addEventListener('click', () => moveBuild(0, true));
    document.getElementById('ml-build-reset')?.addEventListener('click', () => moveBuild(-build.nodes.length));

    // Small touches that make the steps feel connected.
    document.getElementById('ml-dag-canvas')?.addEventListener('click', () => setState(3, 'viewing a layer', 'badge-cyan'));
    ['ml-dim-m', 'ml-dim-k', 'ml-dim-n'].forEach((id) => document.getElementById(id)?.addEventListener('input', () => setState(4, 'tried', 'badge-green')));
    renderBuild();
  }
  setupGuide();

  // ─── Initial Boot ────────────────────────────────────────────────
  recalculateMatrix();
  renderSvdBars();
  drawInversionPrototype([0.824, -0.412, 0.991, -0.105], 0);
  renderDepthMap();
  startDagLoop();
  loadModelGraph(window.MLStateBus.model.path);
})();
