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

let pomodoroSessionId = null;
let pomodoroEndTimestamp = null;
let pomodoroIntervalId = null;

const pomoStartBtn = document.getElementById('pomo-start-btn');
if (pomoStartBtn) pomoStartBtn.addEventListener('click', async () => {
  const el = document.getElementById('dagmem-workspace-input');
  if (!el) return;
  const workspacePath = el.value.trim();
  if (!workspacePath) return;

  const label = document.getElementById('pomo-label-input').value.trim() || 'Focus session';
  let durationMinutes = parseInt(document.getElementById('pomo-duration-input').value, 10);
  if (isNaN(durationMinutes) || durationMinutes <= 0) durationMinutes = 25;

  try {
    const response = await fetch('/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage_memory', params: { action: 'pomodoro_start', workspace_root: workspacePath, label, durationMinutes } })
    });
    const data = await response.json();
    pomodoroSessionId = data && data.result && data.result.session ? data.result.session.id : null;
    if (!pomodoroSessionId) return;
    pomodoroEndTimestamp = Date.now() + durationMinutes * 60000;

    document.getElementById('pomo-start-btn').style.display = 'none';
    document.getElementById('pomo-stop-btn').style.display = '';
    pomodoroIntervalId = setInterval(() => {
      const remainingSeconds = Math.max(0, Math.round((pomodoroEndTimestamp - Date.now()) / 1000));
      document.getElementById('pomo-display').textContent = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
      if (remainingSeconds === 0) {
        clearInterval(pomodoroIntervalId);
        document.getElementById('pomo-display').textContent = 'Done!';
      }
    }, 1000);
  } catch {}
});

const pomoStopBtn = document.getElementById('pomo-stop-btn');
if (pomoStopBtn) pomoStopBtn.addEventListener('click', async () => {
  clearInterval(pomodoroIntervalId);
  try {
    await fetch('/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage_memory', params: { action: 'pomodoro_stop', workspace_root: document.getElementById('dagmem-workspace-input').value.trim(), sessionRefId: pomodoroSessionId, aborted: true } })
    });
  } catch {}
  document.getElementById('pomo-start-btn').style.display = '';
  document.getElementById('pomo-stop-btn').style.display = 'none';
  document.getElementById('pomo-display').textContent = '';
  pomodoroSessionId = null;
  pomodoroEndTimestamp = null;
});

refreshEisenhower();
