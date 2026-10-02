/**
 * Interactive Multi-Lane Movie Studio & Timeline Visualizer
 * Supports:
 * - Sub-millisecond precision with magnetic grid/beat snapping (snapTimestamp)
 * - Pointer capture + RAF coalescing for zero-lag drag-to-shift and drag-to-trim
 * - Optimistic tri-state visual feedback (pending -> generating -> approved)
 * - External media drag-and-drop ingestion onto timeline tracks
 * - Interactive DSP Effect modifier modal with sonic/visual macro presets
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const LANES = [
    { id: 'video', label: 'Video Keyframes', color: '#06b6d4', icon: '🎬' },
    { id: 'vfx', label: 'VFX & Shaders', color: '#ec4899', icon: '✨' },
    { id: 'bgm', label: 'Background Music (BGM)', color: '#8b5cf6', icon: '🎵' },
    { id: 'vocal', label: 'Dialogue / Voiceover', color: '#10b981', icon: '🎙️' },
    { id: 'dialogue', label: 'Script / Cues', color: '#f59e0b', icon: '📜' }
  ];

  let currentProject = 'default';
  let timelineData = { tracks: {}, totalDuration_ms: 15000 };
  let currentPlayheadMs = 0;
  let zoomPixelsPerSecond = 80; // 80px = 1000ms
  let isPlaying = false;
  let playTimer = null;

  // Active Drag Tracking
  let activeBlockEl = null;
  let activeArtifact = null;
  let dragMode = null; // 'shift' | 'trim-start' | 'trim-end'
  let dragStartX = 0;
  let dragInitialStartMs = 0;
  let dragInitialEndMs = 0;
  let dragRafId = null;
  let pendingPos = null;

  // Audio Context preview
  let audioCtx = null;

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTimecode(ms) {
    const totalSec = Math.max(0, ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    const millis = Math.floor(ms % 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  // --- Sub-Millisecond Snapping (Performance Optimizer spec) ---
  function snapTimestamp(ms, config = { bpm: 120, fps: 24, division: 4, tolerance_ms: 15 }) {
    const candidates = [];
    if (config.bpm) {
      const stepMs = (60000 / config.bpm) / (config.division || 4);
      candidates.push(Math.round(ms / stepMs) * stepMs);
    }
    if (config.fps) {
      const frameMs = 1000 / config.fps;
      candidates.push(Math.round(ms / frameMs) * frameMs);
    }
    const tol = config.tolerance_ms ?? 15;
    for (const snap of candidates) {
      if (Math.abs(ms - snap) <= tol) return Number(snap.toFixed(3));
    }
    return Math.max(0, Number(ms.toFixed(3)));
  }

  // --- API Calls ---
  async function callMovieTool(params) {
    const res = await fetch('/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'movie_tool', params })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !data.result?.success) {
      throw new Error(data.result?.error || data.error || 'Movie tool operation failed');
    }
    return data.result.data;
  }

  // --- Timeline Rendering ---
  function renderTimeline() {
    const lanesContainer = document.getElementById('movie-timeline-lanes');
    const rulerContainer = document.getElementById('movie-timeline-ruler');
    if (!lanesContainer || !rulerContainer) return;

    // Dynamic duration: find farthest artifact end or selected duration
    const durationSelect = document.getElementById('movie-max-duration-select');
    const selectedMaxDuration = durationSelect ? parseInt(durationSelect.value, 10) : 60000;

    let maxArtifactEnd = 0;
    for (const lane of Object.values(timelineData.tracks || {})) {
      lane.forEach(a => {
        if (a.end_ms > maxArtifactEnd) maxArtifactEnd = a.end_ms;
      });
    }

    const effectiveDurationMs = Math.max(selectedMaxDuration, maxArtifactEnd + 5000);
    timelineData.totalDuration_ms = effectiveDurationMs;
    const totalSec = Math.ceil(effectiveDurationMs / 1000);
    const timelineWidth = totalSec * zoomPixelsPerSecond;

    // Render Ruler
    let rulerHtml = '';
    for (let sec = 0; sec <= totalSec; sec++) {
      const left = sec * zoomPixelsPerSecond;
      rulerHtml += `
        <div class="ruler-tick" style="left:${left}px;">
          <span class="ruler-label">${sec}s</span>
        </div>
      `;
    }
    rulerContainer.style.width = `${timelineWidth}px`;
    rulerContainer.innerHTML = rulerHtml;

    // Render Lanes
    lanesContainer.style.width = `${timelineWidth}px`;
    lanesContainer.innerHTML = LANES.map(lane => {
      const artifacts = (timelineData.tracks && timelineData.tracks[lane.id]) || [];
      const blocksHtml = artifacts.map(art => {
        const startSec = art.start_ms / 1000;
        const durationSec = Math.max(0.2, (art.end_ms - art.start_ms) / 1000);
        const left = startSec * zoomPixelsPerSecond;
        const width = durationSec * zoomPixelsPerSecond;

        // Tri-state visual styling (Marketing Psychology Lead recommendation)
        let statusClass = 'status-pending';
        let statusBadge = 'Pending';
        if (art.status === 'approved') {
          statusClass = 'status-approved';
          statusBadge = '✓ Approved';
        } else if (art.status === 'generating') {
          statusClass = 'status-generating candy-stripe';
          statusBadge = '⚡ Generating...';
        }

        const fxCount = art.effects?.length || 0;
        const fxBadge = fxCount > 0 ? `<span class="badge badge-purple" style="font-size:10px;padding:1px 4px;">${fxCount} FX</span>` : '';

        return `
          <div class="timeline-block ${statusClass}" 
               data-id="${esc(art.artifactId)}" 
               data-lane="${lane.id}"
               data-start="${art.start_ms}"
               data-end="${art.end_ms}"
               style="left:${left}px; width:${width}px; border-color:${lane.color};">
            <div class="block-trim-handle start-handle" title="Trim Start"></div>
            <div class="block-content">
              <span class="block-title" title="${esc(art.label || art.name)}">${esc(art.label || art.name)}</span>
              <div class="block-meta">
                <span class="block-time">${(art.start_ms / 1000).toFixed(1)}s - ${(art.end_ms / 1000).toFixed(1)}s</span>
                ${fxBadge}
              </div>
            </div>
            <div class="block-actions">
              <button class="block-btn btn-approve" data-id="${esc(art.artifactId)}" title="Approve & Lock">✓</button>
              <button class="block-btn btn-fx" data-id="${esc(art.artifactId)}" title="DSP Effects">🎛️</button>
              <button class="block-btn btn-reroll" data-id="${esc(art.artifactId)}" title="Re-roll Slot">↺</button>
            </div>
            <div class="block-trim-handle end-handle" title="Trim End"></div>
          </div>
        `;
      }).join('');

      return `
        <div class="timeline-track" data-lane="${lane.id}">
          <div class="track-header" style="border-left: 3px solid ${lane.color};">
            <span class="track-icon">${lane.icon}</span>
            <span class="track-name">${lane.label}</span>
          </div>
          <div class="track-lane-body" data-lane="${lane.id}" style="width:${timelineWidth}px;">
            ${blocksHtml}
          </div>
        </div>
      `;
    }).join('');

    updatePlayheadPosition();
    attachTimelineEventHandlers();
  }

  function updatePlayheadPosition() {
    const playhead = document.getElementById('movie-playhead');
    const readout = document.getElementById('movie-timecode-display');
    if (!playhead) return;
    const x = (currentPlayheadMs / 1000) * zoomPixelsPerSecond;
    playhead.style.transform = `translateX(${x}px)`;
    if (readout) readout.textContent = formatTimecode(currentPlayheadMs);

    // Sync Live Video / Audio Preview Stage
    syncLivePreview(currentPlayheadMs);
  }

  function syncLivePreview(timeMs) {
    const videoEl = document.getElementById('movie-preview-video');
    const placeholder = document.getElementById('movie-preview-placeholder');
    const cueEl = document.getElementById('movie-active-cue');
    const statusBadge = document.getElementById('movie-preview-status');

    let activeVideoArt = null;
    let activeAudioArt = null;

    for (const lane of Object.values(timelineData.tracks || {})) {
      for (const art of lane) {
        if (timeMs >= art.start_ms && timeMs <= art.end_ms) {
          if (art.track === 'video' || art.artifact_path?.match(/\.(mp4|webm|mkv|mov)$/i)) {
            activeVideoArt = art;
          }
          if (art.track === 'bgm' || art.track === 'vocal' || art.artifact_path?.match(/\.(wav|mp3|ogg|aac)$/i)) {
            activeAudioArt = art;
          }
        }
      }
    }

    if (activeVideoArt && activeVideoArt.artifact_path) {
      if (placeholder) placeholder.style.display = 'none';
      if (videoEl) {
        videoEl.style.display = 'block';
        if (videoEl.dataset.path !== activeVideoArt.artifact_path) {
          videoEl.dataset.path = activeVideoArt.artifact_path;
          videoEl.src = activeVideoArt.artifact_path.startsWith('http') 
            ? activeVideoArt.artifact_path 
            : `/api/media/preview?file=${encodeURIComponent(activeVideoArt.artifact_path)}`;
        }
        const offsetSec = (timeMs - activeVideoArt.start_ms) / 1000;
        if (!isNaN(videoEl.duration) && Math.abs(videoEl.currentTime - offsetSec) > 0.15) {
          videoEl.currentTime = offsetSec;
        }
      }
      if (statusBadge) { statusBadge.textContent = 'Rendering'; statusBadge.className = 'badge badge-green'; }
    } else {
      if (videoEl) videoEl.style.display = 'none';
      if (placeholder) {
        placeholder.style.display = 'block';
        if (cueEl) cueEl.textContent = activeAudioArt ? `Audio: ${activeAudioArt.label} (${activeAudioArt.track})` : 'Timeline idle';
      }
      if (statusBadge) { statusBadge.textContent = 'Idle'; statusBadge.className = 'badge badge-gray'; }
    }

    drawWaveform(activeAudioArt);
  }

  function drawWaveform(audioArt) {
    const canvas = document.getElementById('movie-waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.parentElement.clientWidth || 400;
    const h = canvas.height = canvas.parentElement.clientHeight || 180;

    ctx.fillStyle = '#070712';
    ctx.fillRect(0, 0, w, h);

    // Center baseline
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const meterEl = document.getElementById('movie-audio-meter');
    if (audioArt) {
      const db = isPlaying ? (-6 + Math.sin(Date.now() / 60) * 3).toFixed(1) : '-inf';
      if (meterEl) meterEl.textContent = `${db} dB`;

      // Draw dynamic reactive sine wave
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#8b5cf6';
      ctx.beginPath();
      const sliceWidth = w / 64;
      let curX = 0;
      for (let i = 0; i < 64; i++) {
        const v = Math.sin((i * 0.2) + (Date.now() * 0.008)) * (isPlaying ? 35 : 6);
        const y = (h / 2) + v;
        if (i === 0) ctx.moveTo(curX, y);
        else ctx.lineTo(curX, y);
        curX += sliceWidth;
      }
      ctx.stroke();

      // Secondary frequency harmonic
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.6)';
      ctx.beginPath();
      curX = 0;
      for (let i = 0; i < 64; i++) {
        const v = Math.cos((i * 0.3) + (Date.now() * 0.012)) * (isPlaying ? 20 : 3);
        const y = (h / 2) + v;
        if (i === 0) ctx.moveTo(curX, y);
        else ctx.lineTo(curX, y);
        curX += sliceWidth;
      }
      ctx.stroke();
    } else {
      if (meterEl) meterEl.textContent = 'Muted';
    }
  }

  // --- Zero-Lag Drag Handling (RAF Coalescing + Pointer Capture) ---
  function attachTimelineEventHandlers() {
    const blocks = document.querySelectorAll('.timeline-block');
    blocks.forEach(block => {
      block.addEventListener('pointerdown', onBlockPointerDown);
    });

    // Ruler click scrubbing
    const ruler = document.getElementById('movie-timeline-ruler');
    if (ruler) {
      ruler.onpointerdown = (e) => {
        const rect = ruler.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        currentPlayheadMs = snapTimestamp((clickX / zoomPixelsPerSecond) * 1000);
        updatePlayheadPosition();

        const onScrubMove = (ev) => {
          const moveX = ev.clientX - rect.left;
          currentPlayheadMs = snapTimestamp(Math.max(0, (moveX / zoomPixelsPerSecond) * 1000));
          updatePlayheadPosition();
        };

        const onScrubUp = () => {
          window.removeEventListener('pointermove', onScrubMove);
          window.removeEventListener('pointerup', onScrubUp);
        };

        window.addEventListener('pointermove', onScrubMove);
        window.addEventListener('pointerup', onScrubUp);
      };
    }

    // Delegated Block Action Buttons
    document.querySelectorAll('.btn-approve').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          btn.textContent = '⏳';
          await callMovieTool({ action: 'approve_artifact', artifactId: id, projectId: currentProject });
          await loadTimeline();
        } catch (err) {
          alert('Approval error: ' + err.message);
          btn.textContent = '✓';
        }
      });
    });

    document.querySelectorAll('.btn-reroll').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          btn.textContent = '⏳';
          await callMovieTool({ action: 'reroll_artifact', artifactId: id, projectId: currentProject });
          await loadTimeline();
        } catch (err) {
          alert('Reroll error: ' + err.message);
          btn.textContent = '↺';
        }
      });
    });

    document.querySelectorAll('.btn-fx').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEffectModal(btn.dataset.id);
      });
    });

    // Native Drag and Drop for External Local Media Files
    const laneBodies = document.querySelectorAll('.track-lane-body');
    laneBodies.forEach(laneEl => {
      laneEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        laneEl.classList.add('drag-over');
      });
      laneEl.addEventListener('dragleave', () => laneEl.classList.remove('drag-over'));
      laneEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        laneEl.classList.remove('drag-over');
        const lane = laneEl.dataset.lane;
        const rect = laneEl.getBoundingClientRect();
        const dropX = e.clientX - rect.left;
        const dropMs = snapTimestamp((dropX / zoomPixelsPerSecond) * 1000);

        const files = Array.from(e.dataTransfer.files || []);
        if (files.length > 0) {
          for (const file of files) {
            const artifactPath = file.path || file.name;
            await callMovieTool({
              action: 'add_artifact',
              projectId: currentProject,
              track: lane,
              start_ms: dropMs,
              end_ms: dropMs + 5000,
              label: file.name,
              name: file.name.replace(/\.[^/.]+$/, ''),
              artifact_path: artifactPath
            });
          }
          await loadTimeline();
        }
      });
    });
  }

  function onBlockPointerDown(e) {
    if (e.target.closest('.block-btn')) return;
    activeBlockEl = e.currentTarget;
    const artId = activeBlockEl.dataset.id;
    activeArtifact = findArtifactById(artId);
    if (!activeArtifact) return;

    if (e.target.classList.contains('start-handle')) {
      dragMode = 'trim-start';
    } else if (e.target.classList.contains('end-handle')) {
      dragMode = 'trim-end';
    } else {
      dragMode = 'shift';
    }

    dragStartX = e.clientX;
    dragInitialStartMs = activeArtifact.start_ms;
    dragInitialEndMs = activeArtifact.end_ms;

    activeBlockEl.setPointerCapture(e.pointerId);
    activeBlockEl.addEventListener('pointermove', onBlockPointerMove);
    activeBlockEl.addEventListener('pointerup', onBlockPointerUp);
    activeBlockEl.addEventListener('pointercancel', onBlockPointerUp);
  }

  function onBlockPointerMove(e) {
    if (!activeBlockEl || !dragMode) return;
    pendingPos = { clientX: e.clientX };

    if (!dragRafId) {
      dragRafId = requestAnimationFrame(() => {
        dragRafId = null;
        if (!activeBlockEl || !pendingPos) return;

        const deltaPx = pendingPos.clientX - dragStartX;
        const deltaMs = (deltaPx / zoomPixelsPerSecond) * 1000;

        if (dragMode === 'shift') {
          const duration = dragInitialEndMs - dragInitialStartMs;
          const newStart = snapTimestamp(Math.max(0, dragInitialStartMs + deltaMs));
          const newEnd = newStart + duration;
          activeBlockEl.style.left = `${(newStart / 1000) * zoomPixelsPerSecond}px`;
          activeBlockEl.dataset.start = newStart;
          activeBlockEl.dataset.end = newEnd;
          activeBlockEl.querySelector('.block-time').textContent = `${(newStart / 1000).toFixed(1)}s - ${(newEnd / 1000).toFixed(1)}s`;
        } else if (dragMode === 'trim-start') {
          const newStart = snapTimestamp(Math.max(0, Math.min(dragInitialEndMs - 200, dragInitialStartMs + deltaMs)));
          const width = ((dragInitialEndMs - newStart) / 1000) * zoomPixelsPerSecond;
          activeBlockEl.style.left = `${(newStart / 1000) * zoomPixelsPerSecond}px`;
          activeBlockEl.style.width = `${width}px`;
          activeBlockEl.dataset.start = newStart;
          activeBlockEl.querySelector('.block-time').textContent = `${(newStart / 1000).toFixed(1)}s - ${(dragInitialEndMs / 1000).toFixed(1)}s`;
        } else if (dragMode === 'trim-end') {
          const newEnd = snapTimestamp(Math.max(dragInitialStartMs + 200, dragInitialEndMs + deltaMs));
          const width = ((newEnd - dragInitialStartMs) / 1000) * zoomPixelsPerSecond;
          activeBlockEl.style.width = `${width}px`;
          activeBlockEl.dataset.end = newEnd;
          activeBlockEl.querySelector('.block-time').textContent = `${(dragInitialStartMs / 1000).toFixed(1)}s - ${(newEnd / 1000).toFixed(1)}s`;
        }
      });
    }
  }

  async function onBlockPointerUp(e) {
    if (!activeBlockEl) return;
    activeBlockEl.removeEventListener('pointermove', onBlockPointerMove);
    activeBlockEl.removeEventListener('pointerup', onBlockPointerUp);
    activeBlockEl.removeEventListener('pointercancel', onBlockPointerUp);

    const artId = activeBlockEl.dataset.id;
    const finalStart = parseFloat(activeBlockEl.dataset.start);
    const finalEnd = parseFloat(activeBlockEl.dataset.end);

    activeBlockEl = null;
    dragMode = null;

    if (activeArtifact && (finalStart !== activeArtifact.start_ms || finalEnd !== activeArtifact.end_ms)) {
      activeArtifact.start_ms = finalStart;
      activeArtifact.end_ms = finalEnd;
      // Persist artifact position change to server
      try {
        await callMovieTool({
          action: 'update_artifact_bounds',
          projectId: currentProject,
          artifactId: activeArtifact.artifactId,
          start_ms: finalStart,
          end_ms: finalEnd
        });
        await loadTimeline();
      } catch (err) {
        console.warn('Failed to update artifact bounds:', err);
      }
    }
  }

  function findArtifactById(id) {
    for (const lane of Object.values(timelineData.tracks || {})) {
      const found = lane.find(a => a.artifactId === id);
      if (found) return found;
    }
    return null;
  }

  // --- DSP Effect Modal (Macro Presets - Marketing Psychology Lead) ---
  let selectedArtifactForFx = null;

  function openEffectModal(artId) {
    const art = findArtifactById(artId);
    if (!art) return;
    selectedArtifactForFx = art;

    const modal = document.getElementById('movie-fx-modal');
    if (!modal) return;

    document.getElementById('fx-artifact-title').textContent = `${art.label || art.name} (${art.track})`;
    modal.style.display = 'flex';
  }

  function closeEffectModal() {
    const modal = document.getElementById('movie-fx-modal');
    if (modal) modal.style.display = 'none';
    selectedArtifactForFx = null;
  }

  // --- Timeline Loading & Control ---
  async function loadTimeline() {
    const projInput = document.getElementById('movie-project-input');
    if (projInput) currentProject = projInput.value.trim() || 'default';

    try {
      const data = await callMovieTool({ action: 'get_timeline', projectId: currentProject });
      timelineData = data || { tracks: {}, totalDuration_ms: 15000 };
      renderTimeline();
    } catch (err) {
      console.warn('[Movie] Could not load timeline, initializing project:', err);
      try {
        await callMovieTool({ action: 'init_project', projectId: currentProject, premise: 'Default Project' });
        const data = await callMovieTool({ action: 'get_timeline', projectId: currentProject });
        timelineData = data || { tracks: {}, totalDuration_ms: 15000 };
        renderTimeline();
      } catch (e2) {
        console.error('[Movie] Init failed:', e2);
      }
    }
  }

  // --- Public Interface ---
  window.initMovieTab = function () {
    const initBtn = document.getElementById('movie-init-btn');
    const loadBtn = document.getElementById('movie-load-btn');
    const proposeBtn = document.getElementById('movie-propose-btn');
    const compileBtn = document.getElementById('movie-compile-btn');
    const playBtn = document.getElementById('movie-play-btn');
    const zoomInBtn = document.getElementById('movie-zoom-in');
    const zoomOutBtn = document.getElementById('movie-zoom-out');
    const fxCloseBtn = document.getElementById('movie-fx-close-btn');
    const fxApplyBtn = document.getElementById('movie-fx-apply-btn');
    const fxUndoBtn = document.getElementById('movie-fx-undo-btn');

    if (initBtn) {
      initBtn.addEventListener('click', async () => {
        const premise = (document.getElementById('movie-premise-input')?.value || '').trim() || 'Cinematic Sci-Fi Odyssey';
        const projId = (document.getElementById('movie-project-input')?.value || '').trim() || 'project_' + Date.now();
        currentProject = projId;
        await callMovieTool({ action: 'init_project', projectId: projId, premise });
        await loadTimeline();
      });
    }

    if (loadBtn) loadBtn.addEventListener('click', loadTimeline);

    if (proposeBtn) {
      proposeBtn.addEventListener('click', async () => {
        const premise = (document.getElementById('movie-premise-input')?.value || '').trim() || 'Action scene with car chase';
        await callMovieTool({ action: 'propose_slots', projectId: currentProject, premise, duration_ms: 20000 });
        await loadTimeline();
      });
    }

    if (compileBtn) {
      compileBtn.addEventListener('click', async () => {
        compileBtn.textContent = '⏳ Compiling…';
        try {
          const res = await callMovieTool({ action: 'compile_timeline', projectId: currentProject });
          alert(`Timeline Compiled!\nTotal Duration: ${(res.totalDuration_ms / 1000).toFixed(1)}s\nOutput File: ${res.compiledPath}`);
        } catch (err) {
          alert('Compile error: ' + err.message);
        } finally {
          compileBtn.textContent = '⚡ Compile Final Movie';
        }
      });
    }

    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        zoomPixelsPerSecond = Math.min(250, zoomPixelsPerSecond + 20);
        renderTimeline();
      });
    }

    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        zoomPixelsPerSecond = Math.max(30, zoomPixelsPerSecond - 20);
        renderTimeline();
      });
    }

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        isPlaying = !isPlaying;
        playBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
        if (isPlaying) {
          const startReal = performance.now();
          const startPlayhead = currentPlayheadMs;
          playTimer = setInterval(() => {
            currentPlayheadMs = startPlayhead + (performance.now() - startReal);
            if (currentPlayheadMs > (timelineData.totalDuration_ms || 15000)) {
              currentPlayheadMs = 0;
            }
            updatePlayheadPosition();
          }, 33);
        } else {
          clearInterval(playTimer);
        }
      });
    }

    // FX Controls Mode Switching & Slider Readouts
    const fxTypeSelect = document.getElementById('fx-type-select');
    const fxWetSlider = document.getElementById('fx-wet-slider');
    const fxDecaySlider = document.getElementById('fx-decay-slider');
    const fxSemitoneSlider = document.getElementById('fx-semitone-slider');
    const fxBassSlider = document.getElementById('fx-bass-slider');
    const fxMidSlider = document.getElementById('fx-mid-slider');
    const fxTrebleSlider = document.getElementById('fx-treble-slider');

    const fxTempoSlider = document.getElementById('fx-tempo-slider');
    const fxContrastSlider = document.getElementById('fx-contrast-slider');
    const fxSaturationSlider = document.getElementById('fx-saturation-slider');

    if (fxTypeSelect) {
      fxTypeSelect.addEventListener('change', () => {
        const val = fxTypeSelect.value;
        const revWrap = document.getElementById('fx-reverb-controls');
        const pitchWrap = document.getElementById('fx-pitch-controls');
        const eqWrap = document.getElementById('fx-eq-controls');
        const tempoWrap = document.getElementById('fx-tempo-controls');
        const lutWrap = document.getElementById('fx-lut-controls');
        if (revWrap) revWrap.style.display = val === 'reverb' ? 'block' : 'none';
        if (pitchWrap) pitchWrap.style.display = val === 'pitch' ? 'block' : 'none';
        if (eqWrap) eqWrap.style.display = val === 'eq' ? 'block' : 'none';
        if (tempoWrap) tempoWrap.style.display = val === 'tempo' ? 'block' : 'none';
        if (lutWrap) lutWrap.style.display = val === 'lut' ? 'block' : 'none';
      });
    }

    if (fxWetSlider) fxWetSlider.oninput = () => { document.getElementById('fx-wet-val').textContent = `${fxWetSlider.value}%`; };
    if (fxDecaySlider) fxDecaySlider.oninput = () => { document.getElementById('fx-decay-val').textContent = `${(fxDecaySlider.value / 10).toFixed(1)}s`; };
    if (fxSemitoneSlider) fxSemitoneSlider.oninput = () => { document.getElementById('fx-semitone-val').textContent = `${fxSemitoneSlider.value} semitones`; };
    if (fxBassSlider) fxBassSlider.oninput = () => { document.getElementById('fx-bass-val').textContent = `${fxBassSlider.value}dB`; };
    if (fxMidSlider) fxMidSlider.oninput = () => { document.getElementById('fx-mid-val').textContent = `${fxMidSlider.value}dB`; };
    if (fxTrebleSlider) fxTrebleSlider.oninput = () => { document.getElementById('fx-treble-val').textContent = `${fxTrebleSlider.value}dB`; };
    if (fxTempoSlider) fxTempoSlider.oninput = () => { document.getElementById('fx-tempo-val').textContent = `${(fxTempoSlider.value / 10).toFixed(1)}x`; };
    if (fxContrastSlider) fxContrastSlider.oninput = () => { document.getElementById('fx-contrast-val').textContent = `${(fxContrastSlider.value / 10).toFixed(2)}`; };
    if (fxSaturationSlider) fxSaturationSlider.oninput = () => { document.getElementById('fx-saturation-val').textContent = `${(fxSaturationSlider.value / 10).toFixed(2)}`; };

    const durationSelect = document.getElementById('movie-max-duration-select');
    if (durationSelect) {
      durationSelect.addEventListener('change', () => {
        renderTimeline();
      });
    }

    if (fxCloseBtn) fxCloseBtn.addEventListener('click', closeEffectModal);

    if (fxApplyBtn) {
      fxApplyBtn.addEventListener('click', async () => {
        if (!selectedArtifactForFx) return;
        const fxType = document.getElementById('fx-type-select')?.value || 'reverb';
        let params = {};

        if (fxType === 'reverb') {
          const wetRatio = (parseInt(fxWetSlider?.value || '80', 10)) / 100;
          const decaySec = (parseInt(fxDecaySlider?.value || '4', 10)) / 10;
          const preset = document.getElementById('fx-preset-select')?.value || 'studio';
          const baseDelay = preset === 'cathedral' ? 120 : preset === 'canyon' ? 240 : 60;
          params = {
            inGain: 0.8,
            outGain: Number(wetRatio.toFixed(2)),
            delays: String(baseDelay),
            decays: String(Math.min(0.9, decaySec * 0.2))
          };
        } else if (fxType === 'pitch') {
          const st = parseInt(fxSemitoneSlider?.value || '0', 10);
          params = { semitones: st };
        } else if (fxType === 'tempo') {
          const factor = (parseInt(fxTempoSlider?.value || '10', 10)) / 10;
          params = { factor };
        } else if (fxType === 'eq') {
          params = {
            bass: parseInt(fxBassSlider?.value || '0', 10),
            mid: parseInt(fxMidSlider?.value || '0', 10),
            treble: parseInt(fxTrebleSlider?.value || '0', 10)
          };
        } else if (fxType === 'lut') {
          const contrast = (parseInt(fxContrastSlider?.value || '12', 10)) / 10;
          const saturation = (parseInt(fxSaturationSlider?.value || '13', 10)) / 10;
          params = { contrast, saturation, brightness: 0.05 };
        }

        try {
          await callMovieTool({
            action: 'apply_effect',
            projectId: currentProject,
            artifactId: selectedArtifactForFx.artifactId,
            effect: { id: `fx_${Date.now()}`, type: fxType, params }
          });
          closeEffectModal();
          await loadTimeline();
        } catch (err) {
          alert('Apply effect error: ' + err.message);
        }
      });
    }

    if (fxUndoBtn) {
      fxUndoBtn.addEventListener('click', async () => {
        if (!selectedArtifactForFx) return;
        try {
          await callMovieTool({
            action: 'undo_effect',
            projectId: currentProject,
            artifactId: selectedArtifactForFx.artifactId
          });
          closeEffectModal();
          await loadTimeline();
        } catch (err) {
          alert('Undo effect error: ' + err.message);
        }
      });
    }

    loadTimeline();
  };
})();
