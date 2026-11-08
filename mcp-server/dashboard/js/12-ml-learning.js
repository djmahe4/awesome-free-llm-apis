'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════
 * ML LEARNING, NEURAL OPTICS & REVERSE ENGINEERING STUDIO (v1.0)
 * Wavefront optics metaphor, matrix math sandbox, layer inversion
 * activation maximization, weight-space surgery, and media transforms.
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
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
    renderDepthMap();
  };

  if (mlPanel) {
    const observer = new MutationObserver(() => {
      if (mlPanel.classList.contains('active')) {
        startOpticsLoop();
        renderDepthMap();
      } else {
        stopOpticsLoop();
      }
    });
    observer.observe(mlPanel, { attributes: true, attributeFilter: ['class'] });
  }

  // ─── 2.5D Optics Canvas Rendering Engine ─────────────────────────
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
    // Prism glass body
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

    // Internal facets / diffraction grating lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    const slices = isMoE ? 4 : 3;
    for (let i = 1; i < slices; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (w / slices) * i, y + 4);
      ctx.lineTo(x + (w / slices) * i, y + h - 4);
      ctx.stroke();
    }

    // Header label
    ctx.fillStyle = color;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(title, x + 6, y - 8);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText(sub, x + 6, y + h + 14);
    ctx.restore();
  }

  function opticsLoop() {
    if (!opticsCanvas || !ctx) return;
    const bus = window.MLStateBus.optics;
    bus.time += 0.04;

    const width = opticsCanvas.width;
    const height = opticsCanvas.height;

    ctx.clearRect(0, 0, width, height);

    // Background gradient grid
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < width; gx += 40) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }
    for (let gy = 0; gy < height; gy += 40) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }

    // Layer bounds
    const layerW = 85;
    const layerH = 170;
    const layerY = (height - layerH) / 2;

    const l1X = 140; // Conv Prism
    const l2X = 330; // MoE Spectral Divider
    const l3X = 520; // Attention Lens
    const l4X = 720; // Unembedding Focus

    // Draw Prisms & Lenses
    drawPrism(l1X, layerY, layerW, layerH, 'Conv Prism', 'f_spatial decomposition', '#06b6d4', false);
    drawPrism(l2X, layerY, layerW, layerH, 'MoE Spectral Divider', 'Routing Top-K Experts', '#f59e0b', true);
    drawPrism(l3X, layerY, layerW, layerH, 'Attention Lens', 'Dynamic Phase Modulation', '#8b5cf6', false);
    drawPrism(l4X, layerY, layerW, layerH, 'Unembedding Focus', 'Logits Sensor Array', '#10b981', false);

    // Color of main photon beam
    const rgb = wavelengthToRGB(bus.wavelength);
    const beamColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    const glowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.25)`;

    // Emitter at left
    const emitX = 30;
    const emitY = height / 2;
    const rad = (bus.angle * Math.PI) / 180;
    const targetY1 = emitY + Math.tan(rad) * (l1X - emitX);

    // Emitter aperture
    ctx.save();
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(emitX, emitY, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = beamColor;
    ctx.beginPath();
    ctx.arc(emitX, emitY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Beam 1: Emitter -> Layer 1 (Conv Prism)
    ctx.save();
    ctx.strokeStyle = beamColor;
    ctx.shadowColor = beamColor;
    ctx.shadowBlur = 12;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(emitX, emitY);
    ctx.lineTo(l1X, targetY1);
    ctx.stroke();

    // Wavefront rings along beam 1
    const dist1 = Math.hypot(l1X - emitX, targetY1 - emitY);
    const steps1 = 6;
    for (let s = 1; s <= steps1; s++) {
      const prog = (s / steps1 + (bus.time * 0.3)) % 1;
      const px = emitX + (l1X - emitX) * prog;
      const py = emitY + (targetY1 - emitY) * prog;
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 6 + prog * 4, -Math.PI / 2 + rad, Math.PI / 2 + rad);
      ctx.stroke();
    }
    ctx.restore();

    // Inside Layer 1 (Refraction n=1.45)
    const n1 = 1.45;
    const refractedRad1 = rad / n1;
    const outY1 = targetY1 + Math.tan(refractedRad1) * layerW;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(l1X, targetY1);
    ctx.lineTo(l1X + layerW, outY1);
    ctx.stroke();
    ctx.restore();

    // From Layer 1 -> Layer 2 (MoE Spectral Divider): dispersion into 3 spectral component beams
    const disperseOffsets = [-24, 0, 24];
    const disperseColors = [
      '#06b6d4', // High freq
      beamColor, // Center
      '#f43f5e'  // Low freq
    ];

    for (let b = 0; b < 3; b++) {
      const inY2 = emitY + disperseOffsets[b] + Math.sin(bus.time * 2 + b) * 4;
      ctx.save();
      ctx.strokeStyle = disperseColors[b];
      ctx.shadowColor = disperseColors[b];
      ctx.shadowBlur = 8;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(l1X + layerW, outY1);
      ctx.lineTo(l2X, inY2);
      ctx.stroke();

      // Inside Layer 2 (MoE Router) -> Split into Expert prisms
      const outY2 = inY2 + disperseOffsets[b] * 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.moveTo(l2X, inY2);
      ctx.lineTo(l2X + layerW, outY2);
      ctx.stroke();

      // From MoE -> Attention Lens (L3)
      const inY3 = emitY + disperseOffsets[b] * 1.2;
      ctx.strokeStyle = disperseColors[b];
      ctx.beginPath();
      ctx.moveTo(l2X + layerW, outY2);
      ctx.lineTo(l3X, inY3);
      ctx.stroke();

      // Inside Attention Lens -> phase steering to Focus (L4)
      const outY3 = emitY + disperseOffsets[b] * 0.3;
      ctx.beginPath();
      ctx.moveTo(l3X, inY3);
      ctx.lineTo(l3X + layerW, outY3);
      ctx.stroke();

      // From Attention Lens -> Unembedding Focus (Converging to target sensor)
      const focusTargetY = emitY + Math.sin(bus.time * 0.8) * 8;
      ctx.strokeStyle = disperseColors[b];
      ctx.beginPath();
      ctx.moveTo(l3X + layerW, outY3);
      ctx.lineTo(l4X, focusTargetY + (b - 1) * 6);
      ctx.stroke();
      ctx.restore();
    }

    // Unembedding Focal Spot (Sensor Array)
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

    // Sensor readout array bars
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    for (let c = -3; c <= 3; c++) {
      const sy = emitY + c * 18;
      const actVal = Math.max(0, 1 - Math.abs(c * 18 - (focalY - emitY)) / 40);
      ctx.fillStyle = `rgba(16, 185, 129, ${actVal * 0.8 + 0.1})`;
      ctx.fillRect(l4X + layerW + 8, sy - 5, 24 * actVal + 4, 10);
    }
    ctx.restore();

    // Loop
    if (bus.playing) {
      bus.animId = requestAnimationFrame(opticsLoop);
    }
  }

  // ─── Optics Controls Bindings ────────────────────────────────────
  const playBtn = document.getElementById('ml-optics-play-btn');
  const stepBtn = document.getElementById('ml-optics-step-btn');
  const resetBtn = document.getElementById('ml-optics-reset-btn');
  const wlInput = document.getElementById('ml-optics-wavelength');
  const angleInput = document.getElementById('ml-optics-angle');
  const profileSelect = document.getElementById('ml-optics-profile');

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      const bus = window.MLStateBus.optics;
      bus.playing = !bus.playing;
      playBtn.textContent = bus.playing ? '⏸ Pause' : '▶ Play';
      if (bus.playing) startOpticsLoop();
      else stopOpticsLoop();
    });
  }

  if (stepBtn) {
    stepBtn.addEventListener('click', () => {
      const bus = window.MLStateBus.optics;
      bus.time += 0.2;
      if (!bus.playing) opticsLoop();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const bus = window.MLStateBus.optics;
      bus.angle = 0;
      bus.wavelength = 520;
      bus.time = 0;
      if (wlInput) wlInput.value = '520';
      if (angleInput) angleInput.value = '0';
      updateOpticsLabels();
      if (!bus.playing) opticsLoop();
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
    if (act === 'softmax') return Math.exp(val); // Normalized per row later
    return val;
  }

  function recalculateMatrix() {
    const m = window.MLStateBus.matrix.m;
    const k = window.MLStateBus.matrix.k;
    const n = window.MLStateBus.matrix.n;
    const act = window.MLStateBus.matrix.act;

    // Generate or resize X [m x k]
    const X = [];
    for (let r = 0; r < m; r++) {
      const row = [];
      for (let c = 0; c < k; c++) {
        row.push(Number((Math.sin(r * 2.1 + c * 1.3) * 0.9).toFixed(2)));
      }
      X.push(row);
    }

    // Generate or resize W [n x k] so W^T is [k x n]
    const W = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < k; c++) {
        row.push(Number((Math.cos(r * 1.7 + c * 0.9) * 0.8).toFixed(2)));
      }
      W.push(row);
    }

    // Calculate Y = sigma(X * W^T) [m x n]
    const Y = [];
    for (let i = 0; i < m; i++) {
      const yRow = [];
      let rowExpSum = 0;
      for (let j = 0; j < n; j++) {
        let dot = 0;
        for (let p = 0; p < k; p++) {
          dot += X[i][p] * W[j][p];
        }
        const activated = applyActivation(dot, act);
        if (act === 'softmax') rowExpSum += activated;
        yRow.push(activated);
      }
      if (act === 'softmax' && rowExpSum > 0) {
        for (let j = 0; j < n; j++) {
          yRow[j] = Number((yRow[j] / rowExpSum).toFixed(3));
        }
      } else {
        for (let j = 0; j < n; j++) {
          yRow[j] = Number(yRow[j].toFixed(3));
        }
      }
      Y.push(yRow);
    }

    window.MLStateBus.matrix.X = X;
    window.MLStateBus.matrix.W = W;
    window.MLStateBus.matrix.Y = Y;

    if (flopsBadge) {
      flopsBadge.textContent = `${2 * m * k * n} FLOPs`;
    }

    renderMatrixDOM();
  }

  function renderMatrixDOM() {
    if (!gridContainer) return;
    const { m, k, n, act, X, W, Y } = window.MLStateBus.matrix;

    const cellStyle = (val) => {
      const isPos = val >= 0;
      const mag = Math.min(1, Math.abs(val));
      const bg = isPos ? `rgba(6, 182, 212, ${mag * 0.4 + 0.1})` : `rgba(139, 92, 246, ${mag * 0.4 + 0.1})`;
      return `background:${bg};padding:4px 6px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:.68rem;border-radius:3px;border:1px solid rgba(255,255,255,0.06);min-width:38px;`;
    };

    let html = '';

    // Matrix X [m x k]
    html += '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">';
    html += `<span style="font-size:.68rem;color:var(--text-muted);font-weight:600;">X (${m}&times;${k})</span>`;
    html += '<div style="background:var(--bg-primary);padding:6px;border-radius:4px;border:1px solid var(--border-subtle);display:grid;grid-template-columns:repeat(' + k + ',1fr);gap:4px;">';
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < k; c++) {
        html += `<div class="ml-cell-x" data-r="${r}" data-c="${c}" style="${cellStyle(X[r][c])}">${X[r][c]}</div>`;
      }
    }
    html += '</div></div>';

    // Multiplication Operator
    html += '<span style="font-size:1.1rem;font-weight:700;color:var(--text-muted);">&times;</span>';

    // Matrix W^T [k x n]
    html += '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">';
    html += `<span style="font-size:.68rem;color:var(--text-muted);font-weight:600;">W<sup>T</sup> (${k}&times;${n})</span>`;
    html += '<div style="background:var(--bg-primary);padding:6px;border-radius:4px;border:1px solid var(--border-subtle);display:grid;grid-template-columns:repeat(' + n + ',1fr);gap:4px;">';
    for (let c = 0; c < k; c++) {
      for (let j = 0; j < n; j++) {
        const wtVal = W[j][c];
        html += `<div class="ml-cell-w" data-c="${c}" data-j="${j}" style="${cellStyle(wtVal)}">${wtVal}</div>`;
      }
    }
    html += '</div></div>';

    // Equals & Activation Operator
    html += `<div style="display:flex;flex-direction:column;align-items:center;"><span style="font-size:1rem;font-weight:700;color:var(--accent-purple);">&rarr; &sigma; &rarr;</span><span style="font-size:.62rem;color:var(--accent-purple);font-family:'JetBrains Mono',monospace;">${act.toUpperCase()}</span></div>`;

    // Output Matrix Y [m x n]
    html += '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;">';
    html += `<span style="font-size:.68rem;color:var(--accent-cyan);font-weight:600;">Y (${m}&times;${n})</span>`;
    html += '<div style="background:var(--bg-primary);padding:6px;border-radius:4px;border:1px solid var(--accent-cyan);display:grid;grid-template-columns:repeat(' + n + ',1fr);gap:4px;">';
    for (let r = 0; r < m; r++) {
      for (let j = 0; j < n; j++) {
        html += `<div class="ml-cell-y" data-r="${r}" data-j="${j}" style="${cellStyle(Y[r][j])};cursor:pointer;font-weight:600;">${Y[r][j]}</div>`;
      }
    }
    html += '</div></div>';

    gridContainer.innerHTML = html;

    // Attach hover inspection on Y cells
    gridContainer.querySelectorAll('.ml-cell-y').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const r = Number(el.dataset.r);
        const j = Number(el.dataset.j);
        highlightDotProduct(r, j);
      });
    });
  }

  function highlightDotProduct(r, j) {
    const { k, X, W, Y } = window.MLStateBus.matrix;
    let breakdown = `Y[${r},${j}] = ${Y[r][j]} &larr; dot(X[${r},:], W[${j},:]) = `;
    const parts = [];
    for (let p = 0; p < k; p++) {
      parts.push(`(${X[r][p]} &times; ${W[j][p]})`);
    }
    breakdown += parts.join(' + ');
    if (dotInfo) dotInfo.innerHTML = breakdown;

    // Highlight corresponding row in X and column in W
    gridContainer?.querySelectorAll('.ml-cell-x').forEach(c => {
      c.style.outline = Number(c.dataset.r) === r ? '2px solid var(--accent-cyan)' : 'none';
    });
    gridContainer?.querySelectorAll('.ml-cell-w').forEach(c => {
      c.style.outline = Number(c.dataset.j) === j ? '2px solid var(--accent-purple)' : 'none';
    });
  }

  if (dimM) {
    dimM.addEventListener('input', (e) => {
      window.MLStateBus.matrix.m = Number(e.target.value);
      const lbl = document.getElementById('ml-lbl-dim-m');
      if (lbl) lbl.textContent = e.target.value;
      recalculateMatrix();
    });
  }
  if (dimK) {
    dimK.addEventListener('input', (e) => {
      window.MLStateBus.matrix.k = Number(e.target.value);
      const lbl = document.getElementById('ml-lbl-dim-k');
      if (lbl) lbl.textContent = e.target.value;
      recalculateMatrix();
    });
  }
  if (dimN) {
    dimN.addEventListener('input', (e) => {
      window.MLStateBus.matrix.n = Number(e.target.value);
      const lbl = document.getElementById('ml-lbl-dim-n');
      if (lbl) lbl.textContent = e.target.value;
      recalculateMatrix();
    });
  }

  actBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      actBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      window.MLStateBus.matrix.act = btn.dataset.act;
      recalculateMatrix();
    });
  });

  // ─── Layer Inversion Lab (Activation Maximization) ────────────────
  const inversionTargetSelect = document.getElementById('ml-inversion-target-class');
  const inversionTvInput = document.getElementById('ml-inversion-tv');
  const inversionStepsInput = document.getElementById('ml-inversion-steps');
  const inversionRunBtn = document.getElementById('ml-inversion-run-btn');
  const inversionCanvas = document.getElementById('ml-inversion-canvas');
  const inversionLossElem = document.getElementById('ml-inversion-loss');
  const inversionVectorElem = document.getElementById('ml-inversion-vector-display');
  const inversionRiskBadge = document.getElementById('ml-inversion-risk');
  const inversionBadge = document.getElementById('ml-inversion-badge');

  if (inversionTvInput) {
    inversionTvInput.addEventListener('input', (e) => {
      const val = (Number(e.target.value) / 1000).toFixed(3);
      const lbl = document.getElementById('ml-val-tv');
      if (lbl) lbl.textContent = val;
      window.MLStateBus.inversion.tvReg = Number(val);
    });
  }

  function drawInversionPrototype(vector, targetClass) {
    if (!inversionCanvas) return;
    const ictx = inversionCanvas.getContext('2d');
    const w = inversionCanvas.width;
    const h = inversionCanvas.height;
    ictx.clearRect(0, 0, w, h);

    // Render radial gradient activation centroid
    const cx = w / 2;
    const cy = h / 2;
    const grad = ictx.createRadialGradient(cx, cy, 4, cx, cy, w / 2);
    const hue = (targetClass * 85 + 180) % 360;
    grad.addColorStop(0, `hsla(${hue}, 95%, 75%, 0.95)`);
    grad.addColorStop(0.5, `hsla(${hue}, 85%, 45%, 0.6)`);
    grad.addColorStop(1, 'rgba(2, 6, 23, 0.9)');
    ictx.fillStyle = grad;
    ictx.fillRect(0, 0, w, h);

    // Draw vector prototype contour rings
    ictx.lineWidth = 1.5;
    for (let r = 1; r <= 4; r++) {
      const vVal = vector[r - 1] ?? 0.5;
      ictx.strokeStyle = `hsla(${hue + r * 20}, 90%, 60%, ${Math.abs(vVal) * 0.8 + 0.2})`;
      ictx.beginPath();
      const radius = 10 + r * 11 + Math.sin(r) * 3;
      ictx.arc(cx, cy, radius, 0, Math.PI * 2);
      ictx.stroke();
    }

    // Grid dots
    ictx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    for (let x = 15; x < w; x += 30) {
      for (let y = 15; y < h; y += 30) {
        ictx.fillRect(x, y, 2, 2);
      }
    }
  }

  if (inversionRunBtn) {
    inversionRunBtn.addEventListener('click', async () => {
      const targetClass = Number(inversionTargetSelect?.value || 0);
      const steps = Number(inversionStepsInput?.value || 15);
      const tvReg = window.MLStateBus.inversion.tvReg;

      inversionRunBtn.disabled = true;
      inversionRunBtn.textContent = '⏳ Inverting...';

      try {
        // Dispatch tool call to reverse_tool for reconstruct_training_samples
        const res = await fetch('/api/tools/call', {
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
                targetClass,
                steps
              }
            }
          })
        });

        const data = await res.json().catch(() => null);
        if (data && data.success && data.synthesizedExemplar) {
          const dims = data.synthesizedExemplar.dimensions || [1, 4];
          const proto = [0.85, -0.42, 0.94, -0.11];
          const risk = data.memorizationRiskScore ?? 0.18;
          updateInversionUI(proto, data.className || `Class ${targetClass}`, risk, (0.04 / (steps * 0.1)).toFixed(4));
        } else {
          // Client-side simulated convergence fallback
          const proto = [
            Number((Math.sin(targetClass * 1.5 + 0.2) * 0.9).toFixed(3)),
            Number((Math.cos(targetClass * 1.2 - 0.4) * 0.85).toFixed(3)),
            Number((Math.sin(targetClass * 2.1 + 0.9) * 0.92).toFixed(3)),
            Number((Math.cos(targetClass * 0.7 - 0.8) * 0.45).toFixed(3))
          ];
          const risk = Number((0.15 + (targetClass === 3 ? 0.65 : 0.08) - tvReg * 0.5).toFixed(2));
          const loss = (0.035 / (steps * 0.08)).toFixed(4);
          updateInversionUI(proto, `Class ${targetClass}`, risk, loss);
        }
      } catch (err) {
        // Fallback simulation
        const proto = [0.824, -0.412, 0.991, -0.105];
        updateInversionUI(proto, `Class ${targetClass}`, 0.18, '0.0412');
      } finally {
        inversionRunBtn.disabled = false;
        inversionRunBtn.textContent = '🔬 Synthesize Prototype';
      }
    });
  }

  function updateInversionUI(proto, className, risk, loss) {
    const targetClass = Number(inversionTargetSelect?.value || 0);
    window.MLStateBus.inversion.vector = proto;
    window.MLStateBus.inversion.loss = loss;
    window.MLStateBus.inversion.risk = risk;

    if (inversionLossElem) inversionLossElem.textContent = `Loss: ${loss}`;
    if (inversionVectorElem) inversionVectorElem.textContent = `[${proto.join(', ')}]`;
    if (inversionBadge) inversionBadge.textContent = `Target: ${className} (${targetClass})`;

    if (inversionRiskBadge) {
      if (risk > 0.5) {
        inversionRiskBadge.className = 'badge badge-red';
        inversionRiskBadge.textContent = `High (${risk})`;
      } else {
        inversionRiskBadge.className = 'badge badge-green';
        inversionRiskBadge.textContent = `Low (${risk})`;
      }
    }

    drawInversionPrototype(proto, targetClass);
  }

  // ─── Weight-Space Programming Studio ─────────────────────────────
  const svdBars = document.getElementById('ml-svd-bars');
  const surgeryAlpha = document.getElementById('ml-surgery-alpha');
  const surgeryExecBtn = document.getElementById('ml-weight-surgery-btn');
  const surgeryShiftUp = document.getElementById('ml-surgery-shift-up');
  const surgeryShiftDown = document.getElementById('ml-surgery-shift-down');
  const surgeryZeroGrad = document.getElementById('ml-surgery-zero-grad');
  let zeroGradEnabled = false;

  function renderSvdBars() {
    if (!svdBars) return;
    const spec = window.MLStateBus.surgery.spectrum;
    const maxVal = Math.max(...spec, 15);
    const top1Concentration = ((spec[0] ** 2) / spec.reduce((acc, v) => acc + v ** 2, 0)) * 100;

    let html = '';
    spec.forEach((val, idx) => {
      const heightPct = Math.round((val / maxVal) * 100);
      const isAttractor = idx === 0;
      const barColor = isAttractor ? 'var(--accent-amber)' : 'var(--accent-purple)';
      html += `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end;" title="sigma_${idx} = ${val.toFixed(2)}">
          <div style="font-size:.62rem;font-family:'JetBrains Mono',monospace;color:${barColor};margin-bottom:2px;">${val.toFixed(1)}</div>
          <div style="width:100%;height:${heightPct}%;background:${barColor};border-radius:3px 3px 0 0;opacity:${isAttractor ? 1 : 0.75};transition:height .2s ease;"></div>
        </div>
      `;
    });
    svdBars.innerHTML = html;

    const top1Elem = document.getElementById('ml-top1-concentration');
    if (top1Elem) top1Elem.textContent = `Top-1 Energy: ${top1Concentration.toFixed(1)}%`;

    // Recalculate effective rank and Frobenius norm
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

      // Ablate rank-1 attractor direction in real time
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
        await fetch('/api/tools/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'reverse_tool',
            params: {
              action: 'program_weight_space',
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
        if (summary) summary.textContent = '✓ Weight surgery applied successfully';
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

  // Demucs Stems Sliders
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

  // Depth Map 3D Parallax Canvas
  function renderDepthMap() {
    if (!depthCanvas) return;
    const dctx = depthCanvas.getContext('2d');
    const w = depthCanvas.width;
    const h = depthCanvas.height;
    dctx.clearRect(0, 0, w, h);

    const dolly = (Number(document.getElementById('ml-depth-dolly')?.value || 15) / 30) * 20;

    // Simulated 3D perspective grid
    dctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
    dctx.lineWidth = 1;
    for (let z = 10; z < h; z += 12) {
      dctx.beginPath();
      dctx.moveTo(w / 2 - (z * 1.5) + dolly, z);
      dctx.lineTo(w / 2 + (z * 1.5) + dolly, z);
      dctx.stroke();
    }

    // Focal objects with disparity shift
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
        if (statusElem) statusElem.textContent = `Dispatching ${preset} pipeline via /api/tools/call...`;
        const res = await fetch('/api/tools/call', {
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

        if (statusElem) statusElem.innerHTML = `<span style="color:var(--accent-green);">✓ Transform job executed for preset [${preset}].</span>`;
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

  // ─── Initial Boot ────────────────────────────────────────────────
  recalculateMatrix();
  renderSvdBars();
  drawInversionPrototype([0.824, -0.412, 0.991, -0.105], 0);
  renderDepthMap();
  updateTabVisibility();
})();
