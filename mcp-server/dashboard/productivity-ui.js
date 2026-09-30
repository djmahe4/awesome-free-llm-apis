function escapeHtml(str) {
  const temp = document.createElement('div');
  temp.textContent = str;
  return temp.innerHTML;
}

async function refreshEisenhower() {
  const el = document.getElementById('dagmem-workspace-input');
  if (!el) return;
  const workspacePath = el.value.trim();
  if (!workspacePath) {
    document.getElementById('eis-matrix').innerHTML = '<div class="conv-empty">Set a workspace above, then click Refresh.</div>';
    return;
  }

  try {
    const response = await fetch('/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage_memory', params: { action: 'eisenhower_list', workspace_root: workspacePath } })
    });
    const data = await response.json();
    if (!data || !data.result || !data.result.tasks) {
      document.getElementById('eis-matrix').innerHTML = '<div class="conv-empty">Failed to load tasks.</div>';
      return;
    }

    const tasks = data.result.tasks;
    const quadrants = {
      do: { label: 'Do First', color: 'red' },
      schedule: { label: 'Schedule', color: 'blue' },
      delegate: { label: 'Delegate', color: 'amber' },
      delete: { label: 'Eliminate', color: 'gray' }
    };

    let matrixHTML = '';
    for (const quadrant in quadrants) {
      const count = tasks.filter(t => t.quadrant === quadrant).length;
      matrixHTML += `
        <div style="border: 1px solid ${quadrants[quadrant].color}; padding: 10px; border-radius: 5px;">
          <div style="font-weight: bold; color: ${quadrants[quadrant].color};">${quadrants[quadrant].label} (${count})</div>
          ${tasks
            .filter(t => t.quadrant === quadrant)
            .map(t => `<div>${escapeHtml(t.task)} <button data-task-id="${t.id}">Done</button></div>`)
            .join('')}
        </div>
      `;
    }

    document.getElementById('eis-matrix').innerHTML = matrixHTML;
  } catch {
    document.getElementById('eis-matrix').innerHTML = '<div class="conv-empty">Failed to load tasks.</div>';
  }
}

const eisMatrixEl = document.getElementById('eis-matrix');
if (eisMatrixEl) eisMatrixEl.addEventListener('click', async (e) => {
  if (e.target.tagName === 'BUTTON' && e.target.hasAttribute('data-task-id')) {
    const taskId = e.target.getAttribute('data-task-id');
    try {
      await fetch('/api/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'manage_memory', params: { action: 'eisenhower_complete', workspace_root: document.getElementById('dagmem-workspace-input').value.trim(), taskId } })
      });
      refreshEisenhower();
    } catch {}
  }
});

const eisAddBtn = document.getElementById('eis-add-btn');
if (eisAddBtn) eisAddBtn.addEventListener('click', async () => {
  const el = document.getElementById('eis-task-input');
  if (!el) return;
  const taskText = el.value.trim();
  if (!taskText) return;

  const urgent = document.getElementById('eis-urgent').checked;
  const important = document.getElementById('eis-important').checked;

  try {
    await fetch('/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage_memory', params: { action: 'eisenhower_add', workspace_root: document.getElementById('dagmem-workspace-input').value.trim(), task: taskText, urgent, important } })
    });
    el.value = '';
    document.getElementById('eis-urgent').checked = false;
    document.getElementById('eis-important').checked = false;
    refreshEisenhower();
  } catch {}
});

const eisRefreshBtn = document.getElementById('eis-refresh');
if (eisRefreshBtn) eisRefreshBtn.addEventListener('click', refreshEisenhower);

// ─── Pomodoro: work/break cycle, single global instance, overlay ─────────
const POMO_WORK_MINUTES_DEFAULT = 25;
const POMO_BREAK_MINUTES = 5;
const POMO_STORAGE_KEY = 'mcp-pomodoro-active';

let pomodoroIntervalId = null;

// Persisted to localStorage so "only one instance globally" holds across
// tabs/reloads too, not just within one page's JS state: a second tab
// checks this before allowing its own Start click, and a reload resumes
// the running countdown instead of silently losing it (or worse, letting
// a refresh spawn a second concurrent session).
function savePomodoroState(state) {
  try {
    if (state) localStorage.setItem(POMO_STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(POMO_STORAGE_KEY);
  } catch { /* private-mode/quota — degrade to in-tab-only tracking */ }
}
function loadPomodoroState() {
  try {
    const raw = localStorage.getItem(POMO_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function showPomodoroOverlay(message, actionLabel, onAction) {
  const existing = document.getElementById('pomo-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'pomo-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--bg-secondary,#1a1a2e);color:var(--text-primary,#fff);padding:28px 32px;border-radius:12px;max-width:360px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4);';
  const msg = document.createElement('div');
  msg.style.cssText = 'font-size:1rem;margin-bottom:18px;';
  msg.textContent = message;
  card.appendChild(msg);
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.textContent = actionLabel;
  btn.addEventListener('click', () => {
    overlay.remove();
    if (onAction) onAction();
  });
  card.appendChild(btn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function updatePomoDisplay(remainingSeconds, phase) {
  const el = document.getElementById('pomo-display');
  if (!el) return;
  const mm = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
  const ss = String(remainingSeconds % 60).padStart(2, '0');
  el.textContent = `${phase === 'break' ? 'Break ' : ''}${mm}:${ss}`;
}

function setPomodoroRunningUI(running) {
  const startBtn = document.getElementById('pomo-start-btn');
  const stopBtn = document.getElementById('pomo-stop-btn');
  if (startBtn) startBtn.style.display = running ? 'none' : '';
  if (stopBtn) stopBtn.style.display = running ? '' : 'none';
}

async function callPomodoro(action, extra) {
  const workspacePath = document.getElementById('dagmem-workspace-input');
  const ws = workspacePath ? workspacePath.value.trim() : '';
  try {
    const response = await fetch('/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage_memory', params: Object.assign({ action, workspace_root: ws }, extra) })
    });
    return await response.json();
  } catch {
    return null;
  }
}

function stopPomodoroTicking() {
  if (pomodoroIntervalId) {
    clearInterval(pomodoroIntervalId);
    pomodoroIntervalId = null;
  }
}

// Starts (or resumes, on page load) the countdown for a given phase/session,
// and wires its natural-completion transition (work -> break -> idle).
function runPomodoroPhase(state) {
  stopPomodoroTicking();
  savePomodoroState(state);
  setPomodoroRunningUI(true);

  const tick = () => {
    const remainingSeconds = Math.max(0, Math.round((state.endTimestamp - Date.now()) / 1000));
    updatePomoDisplay(remainingSeconds, state.phase);
    if (remainingSeconds === 0) {
      stopPomodoroTicking();
      onPomodoroPhaseComplete(state);
    }
  };
  tick();
  pomodoroIntervalId = setInterval(tick, 1000);
}

async function onPomodoroPhaseComplete(state) {
  await callPomodoro('pomodoro_stop', { sessionRefId: state.sessionId, aborted: false });

  if (state.phase === 'work') {
    const breakInput = document.getElementById('pomo-break-duration-input');
    let breakMinutes = breakInput ? parseInt(breakInput.value, 10) : NaN;
    if (isNaN(breakMinutes) || breakMinutes <= 0) breakMinutes = POMO_BREAK_MINUTES;
    showPomodoroOverlay(`Work session complete! Time for a ${breakMinutes}-minute break.`, 'Start Break', async () => {
      const data = await callPomodoro('pomodoro_start', { label: 'Break', durationMinutes: breakMinutes });
      const sessionId = data && data.result && data.result.session ? data.result.session.id : null;
      if (!sessionId) {
        savePomodoroState(null);
        setPomodoroRunningUI(false);
        showPomoStatus('Failed to start break session.');
        return;
      }
      runPomodoroPhase({ phase: 'break', sessionId, endTimestamp: Date.now() + breakMinutes * 60000 });
    });
    // Leave the running-UI/overlay up rather than resetting to idle — the
    // user explicitly starts the break via the overlay button, so a second
    // Start click on the main button can't race a session into existence
    // while the overlay is the only valid next action.
  } else {
    savePomodoroState(null);
    setPomodoroRunningUI(false);
    updatePomoDisplay(0, 'work');
    document.getElementById('pomo-display').textContent = '';
    showPomodoroOverlay('Break over! Ready for another focus session?', 'Done', () => {});
  }
}

// Every early-return below used to be silent — no countdown starts, no
// button changes, nothing — which is indistinguishable from the click not
// registering at all. Each now leaves a visible reason in #pomo-display,
// since that's this card's existing status-text spot.
function showPomoStatus(message) {
  const el = document.getElementById('pomo-display');
  if (el) el.textContent = message;
}

const pomoStartBtn = document.getElementById('pomo-start-btn');
if (pomoStartBtn) pomoStartBtn.addEventListener('click', async () => {
  // Global single-instance guard: re-read localStorage (not just in-tab
  // state) so a second tab/window can't start a concurrent session either.
  if (loadPomodoroState()) {
    showPomoStatus('A pomodoro is already running.');
    return;
  }

  const el = document.getElementById('dagmem-workspace-input');
  if (!el) return;
  const workspacePath = el.value.trim();
  if (!workspacePath) {
    showPomoStatus('Set a workspace path above first.');
    return;
  }

  const label = document.getElementById('pomo-label-input').value.trim() || 'Focus session';
  let durationMinutes = parseInt(document.getElementById('pomo-duration-input').value, 10);
  if (isNaN(durationMinutes) || durationMinutes <= 0) durationMinutes = POMO_WORK_MINUTES_DEFAULT;

  showPomoStatus('Starting…');
  const data = await callPomodoro('pomodoro_start', { label, durationMinutes });
  const sessionId = data && data.result && data.result.session ? data.result.session.id : null;
  if (!sessionId) {
    const errMsg = data && data.error ? data.error : 'no response from server';
    showPomoStatus(`Failed to start: ${errMsg}`);
    return;
  }
  runPomodoroPhase({ phase: 'work', sessionId, endTimestamp: Date.now() + durationMinutes * 60000 });
});

const pomoStopBtn = document.getElementById('pomo-stop-btn');
if (pomoStopBtn) pomoStopBtn.addEventListener('click', async () => {
  stopPomodoroTicking();
  const state = loadPomodoroState();
  if (state) {
    await callPomodoro('pomodoro_stop', { sessionRefId: state.sessionId, aborted: true });
  }
  savePomodoroState(null);
  setPomodoroRunningUI(false);
  const display = document.getElementById('pomo-display');
  if (display) display.textContent = '';
});

// Resume an in-progress session across page reloads (still the "one global
// instance" — this is the SAME session continuing, not a new one starting).
(function resumePomodoroOnLoad() {
  const state = loadPomodoroState();
  if (!state || !state.endTimestamp) return;
  if (state.endTimestamp <= Date.now()) {
    // Expired while the page was closed/reloaded — clean up rather than
    // resuming a phantom session or auto-firing the completion overlay
    // for a gap the user wasn't present for.
    savePomodoroState(null);
    return;
  }
  runPomodoroPhase(state);
})();

refreshEisenhower();
