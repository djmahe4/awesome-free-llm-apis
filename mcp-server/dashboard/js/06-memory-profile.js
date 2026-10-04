'use strict';
// ─── MEMORY TAB ──────────────────────────────────────────────────
const memSessionInput  = document.getElementById('mem-session-input');
const memSessionSelect = document.getElementById('mem-session-select');
const memLoadBtn       = document.getElementById('mem-load-btn');
const memRefreshBtn    = document.getElementById('mem-refresh-btn');
const memKnowledge     = document.getElementById('mem-knowledge');
const memUpdated       = document.getElementById('mem-updated');
const memSessionLabel  = document.getElementById('mem-session-label');

let activeMemSid     = '';
let memPollInterval  = null;

async function fetchSessions() {
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) return;
    const d = await r.json();
    const sessions = d.sessions || [];
    while (memSessionSelect.options.length > 1) memSessionSelect.remove(1);
    sessions.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.id === '__no_ws__' ? '⚡ One-shot' : s.id;
      memSessionSelect.appendChild(o);
    });
  } catch {}
}

async function fetchMemory(sid) {
  if (!sid) return;
  try {
    const r = await fetch(`/api/memory/${encodeURIComponent(sid)}`);
    if (!r.ok) { memKnowledge.value = `Error ${r.status}: ${r.statusText}`; return; }
    const d = await r.json();
    memKnowledge.value = d.knowledge || '';
    memSessionLabel.textContent = ` — ${sid}`;
    const resolvedContext = d.queues?.resolvedContext || {};
    renderQueue('queue-now',     d.queues?.nowQueue,     resolvedContext);
    renderQueue('queue-next',    d.queues?.nextQueue,    resolvedContext);
    renderQueue('queue-blocked', d.queues?.blockedQueue, resolvedContext);
    renderQueue('queue-improve', d.queues?.improveQueue, resolvedContext);
    renderHistory(d.queues?.history);
    renderPausedBanner(d.queues?.paused, d.queues?.promptId);
    memUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    memKnowledge.value = `Fetch error: ${err.message}`;
  }
}

function renderQueue(id, items, resolvedContext) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!items?.length) {
    el.innerHTML = '<div class="queue-empty">—</div>';
    return;
  }
  el.innerHTML = items.map(item => {
    // Queue entries are {id, task} objects; the `typeof` check keeps this working against
    // state.json files persisted before this shape existed.
    let text = typeof item === 'string' ? item : (item?.task ?? String(item));
    // Task text may still contain unresolved protected_ref_N placeholders
    // (lazy-resolution design) — swap in the actual content from
    // resolvedContext at display time so raw placeholder tokens aren't shown.
    if (resolvedContext) {
      text = text.replace(/protected_ref_[A-Za-z0-9_]+/g, m => resolvedContext[m] ?? m);
    }
    return `
    <div class="queue-item">
      <span class="queue-chevron">›</span>
      <span>${esc(text)}</span>
    </div>`;
  }).join('');
}

function renderPausedBanner(paused, promptId) {
  const banner = document.getElementById('mem-paused-banner');
  if (!banner) return;
  if (paused) {
    const idEl = document.getElementById('mem-paused-promptid');
    if (idEl) idEl.textContent = `continue ${promptId || ''}`;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

let _historyData = [];
let _historyExpanded = false; // drives the "Expand All / Collapse All" button label
let _expandedIndices = new Set(); // per-entry state, since the Memory tab polls every 3s and
                                   // used to fully rebuild the list from a single shared flag —
                                   // discarding whatever the user had just manually expanded on
                                   // the very next poll tick, making the dropdown look broken.

function renderHistory(history) {
  const el = document.getElementById('queue-history');
  if (!el) return;
  _historyData = history || [];
  _applyHistoryFilter(document.getElementById('history-filter')?.value || '');
}

function _applyHistoryFilter(q) {
  const el = document.getElementById('queue-history');
  if (!el) return;
  if (!_historyData.length) {
    el.innerHTML = '<div class="queue-empty">No subtask history recorded yet.</div>';
    return;
  }
  const filtered = q
    ? _historyData.filter(h => h.task?.toLowerCase().includes(q.toLowerCase()))
    : _historyData;
  if (!filtered.length) {
    el.innerHTML = `<div class="queue-empty">No history entries match "${esc(q)}".</div>`;
    return;
  }

  // Render timeline entries (synchronously, then async-patch mermaid)
  el.innerHTML = filtered.map((h, idx) => {
    const globalIdx = _historyData.indexOf(h);
    const dateStr = h.timestamp ? new Date(h.timestamp).toLocaleTimeString() : '';
    const isError = /error|failed|exception/i.test(h.output || '');
    const borderColor = isError ? 'var(--accent-red)' : 'var(--accent-green)';
    const filesStr = h.filesModified?.length
      ? `<div style="font-size:.7rem;color:var(--accent-cyan);margin-top:4px;">Files: ${h.filesModified.map(f => `<code style="font-size:.7rem;">${esc(f)}</code>`).join(', ')}</div>`
      : '';
    const expanded = _expandedIndices.has(globalIdx);
    return `
      <div class="queue-item hist-entry" data-idx="${globalIdx}" style="flex-direction:column;align-items:stretch;gap:0;border-left:3px solid ${borderColor};padding-left:10px;border-radius:0 var(--radius-sm) var(--radius-sm) 0;">
        <div class="hist-entry-toggle" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:6px 0;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:${isError ? 'var(--accent-red)' : 'var(--accent-purple)'};color:#fff;font-size:.65rem;font-weight:700;flex-shrink:0;">${globalIdx + 1}</span>
            <span style="font-weight:600;color:var(--text-primary);font-size:.82rem;">${esc(h.task || 'Untitled step')}</span>
            ${h.taskId ? `<code style="font-size:.65rem;color:var(--text-muted);">${esc(h.taskId)}</code>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            ${h.provider ? `<span style="font-size:.68rem;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--accent-cyan);">${esc(h.provider)}</span>` : ''}
            ${h.model ? `<span style="font-size:.68rem;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--text-muted);">${esc(h.model)}</span>` : ''}
            ${dateStr ? `<span style="font-size:.68rem;color:var(--text-muted);">${dateStr}</span>` : ''}
            <span id="hist-chevron-${globalIdx}" style="color:var(--text-muted);transition:transform .2s;transform:${expanded ? 'rotate(90deg)' : 'rotate(0deg)'};">&rsaquo;</span>
          </div>
        </div>
        ${filesStr}
        <div id="hist-out-${globalIdx}" class="hist-body" style="display:${expanded ? 'block' : 'none'};margin-top:6px;padding:10px;font-size:.78rem;background:rgba(0,0,0,.3);border-radius:var(--radius-sm);border:1px solid var(--glass-border);">
          <span style="color:var(--text-muted);font-style:italic;">Rendering…</span>
        </div>
      </div>
    `;
  }).join('');

  // Async render markdown/mermaid for each visible body
  filtered.forEach((h, idx) => {
    const globalIdx = _historyData.indexOf(h);
    const bodyEl = document.getElementById(`hist-out-${globalIdx}`);
    if (!bodyEl) return;
    renderMarkdown(h.output || '').then(html => { bodyEl.innerHTML = html || '<em style="color:var(--text-muted);">No output</em>'; });
  });
}

function toggleHistEntry(idx) {
  const body = document.getElementById(`hist-out-${idx}`);
  const chevron = document.getElementById(`hist-chevron-${idx}`);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (chevron) chevron.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
  // Persist so the next 3s poll's full re-render doesn't silently collapse this again.
  if (open) _expandedIndices.delete(idx);
  else _expandedIndices.add(idx);
}

// Delegated click for individual subtask rows — the CSP's `script-src-attr: 'none'`
// (Helmet default) silently blocks inline onclick="..." attributes, so this can't be
// bound inline; delegate from the container instead (same fix as the copy buttons above).
document.getElementById('queue-history')?.addEventListener('click', (e) => {
  const row = e.target.closest('.hist-entry-toggle');
  if (!row) return;
  const entry = row.closest('.hist-entry');
  if (!entry) return;
  toggleHistEntry(parseInt(entry.dataset.idx, 10));
});

// History filter input
document.getElementById('history-filter')?.addEventListener('input', e => {
  _applyHistoryFilter(e.target.value);
});

// Expand / Collapse All
document.getElementById('history-toggle-all')?.addEventListener('click', function() {
  _historyExpanded = !_historyExpanded;
  this.textContent = _historyExpanded ? 'Collapse All' : 'Expand All';
  if (_historyExpanded) {
    _historyData.forEach((_, i) => _expandedIndices.add(i));
  } else {
    _expandedIndices.clear();
  }
  _applyHistoryFilter(document.getElementById('history-filter')?.value || '');
});


function startMemPoll(sid) {
  stopMemPoll();
  activeMemSid = sid;
  fetchMemory(sid);
  memPollInterval = setInterval(() => fetchMemory(sid), 3000);
}

function stopMemPoll() {
  if (memPollInterval) { clearInterval(memPollInterval); memPollInterval = null; }
}

memLoadBtn.addEventListener('click', () => {
  const sid = memSessionInput.value.trim();
  if (sid) startMemPoll(sid);
});

memSessionSelect.addEventListener('change', () => {
  const sid = memSessionSelect.value;
  if (sid) { memSessionInput.value = sid; startMemPoll(sid); }
});

memRefreshBtn.addEventListener('click', () => {
  if (activeMemSid) fetchMemory(activeMemSid);
});

// ─── PROFILE & LEADERBOARD TAB ────────────────────────────────────
let currentUserId = '';

async function fetchUserConfig() {
  try {
    const r = await fetch('/api/user-config');
    if (!r.ok) return;
    const d = await r.json();
    currentUserId = d.userId;
    document.getElementById('profile-username').value = d.username || '';
    document.getElementById('profile-telemetry').checked = !d.optOutTelemetry;
  } catch (err) {
    console.error('[Dashboard] Failed to fetch user config:', err);
  }
}

async function fetchLeaderboard() {
  try {
    const r = await fetch('/api/leaderboard');
    if (!r.ok) return;
    const list = await r.json();
    const el = document.getElementById('leaderboard-list');
    if (!list.length) {
      el.innerHTML = '<div style="text-align:center;padding:20px 0;color:var(--text-muted);">No users on the leaderboard yet.</div>';
      return;
    }

    el.innerHTML = list.map((u, idx) => {
      const isCurrent = u.isCurrentUser;
      const rankBadge = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : `#${idx + 1}`));
      const highlightCls = isCurrent ? 'style="border-color:var(--accent-purple);background:rgba(124,58,237,.08);"' : '';
      return `
        <div class="feature-row" ${highlightCls} style="padding:10px 12px;border-radius:var(--radius-sm);margin-bottom:4px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-weight:700;font-family:\'JetBrains Mono\',monospace;width:24px;">${rankBadge}</span>
            <div>
              <span style="font-weight:600;color:${isCurrent ? 'var(--accent-purple)' : 'var(--text-primary)'};">${esc(u.username)}</span>
              ${isCurrent ? '<span class="badge badge-purple" style="margin-left:6px;font-size:.65rem;">You</span>' : ''}
              <div class="stat-sub" style="margin:0;font-size:.7rem;">Active ${new Date(u.lastSyncTime).toLocaleDateString()}</div>
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:700;color:var(--accent-cyan);font-size:.85rem;">${fmt(u.lifetimeTokens)} tokens</div>
            <div class="stat-sub" style="margin:0;font-size:.7rem;">${fmt(u.lifetimeRequests)} requests</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('[Dashboard] Failed to fetch leaderboard:', err);
  }
}

document.getElementById('profile-save-btn').addEventListener('click', async () => {
  const username = document.getElementById('profile-username').value.trim();
  const optOutTelemetry = !document.getElementById('profile-telemetry').checked;
  const statusEl = document.getElementById('profile-status');

  statusEl.textContent = 'Saving…';
  statusEl.className = 'c-cyan';

  try {
    const r = await fetch('/api/user-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, optOutTelemetry })
    });
    const d = await r.json();

    if (d.error) {
      statusEl.textContent = `Error: ${d.error}`;
      statusEl.className = 'c-red';
    } else {
      statusEl.textContent = '✓ Settings saved successfully!';
      statusEl.className = 'c-green';
      fetchLeaderboard();
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = 'c-red';
  }
});

// Stop polling when memory tab is hidden
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab !== 'memory') stopMemPoll();
  });
});

// ─── Quick Start Copy Buttons ────────────────────────────────────
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    navigator.clipboard.writeText(target.innerText).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });
});

// ─── Initialise ──────────────────────────────────────────────────
fetchStats();
setInterval(fetchStats, 5000);

// Auto-refresh session list periodically when memory tab is active
setInterval(() => {
  const memActive = document.getElementById('panel-memory')?.classList.contains('active');
  if (memActive) fetchSessions();
}, 10000);

// Auto-refresh search providers/logs periodically when Providers tab is active
setInterval(() => {
  const providersActive = document.getElementById('panel-providers')?.classList.contains('active');
  if (providersActive) fetchSearchData();
}, 10000);

