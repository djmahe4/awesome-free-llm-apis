/* ============================================================
   Free LLM MCP Dashboard v2 — app.js
   ============================================================ */

'use strict';

// ─── Utility ────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function fmt(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

// JSON syntax highlighter
function highlightJSON(obj) {
  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return raw.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    match => {
      if (/^"/.test(match)) {
        if (/:$/.test(match)) return `<span class="json-key">${esc(match)}</span>`;
        return `<span class="json-str">${esc(match)}</span>`;
      }
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
      if (/null/.test(match))       return `<span class="json-null">${match}</span>`;
      return `<span class="json-num">${match}</span>`;
    }
  );
}

// ─── Tab System ─────────────────────────────────────────────────
const tabBtns   = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
    tabPanels.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected','true');
    document.getElementById(`panel-${target}`)?.classList.add('active');

    // Tab-specific actions
    if (target === 'memory')   { fetchSessions(); if (activeMemSid) startMemPoll(activeMemSid); }
    if (target === 'providers') fetchStats();
    if (target === 'playground') ensureModels();
    if (target === 'profile')  { fetchUserConfig(); fetchLeaderboard(); }
  });
});

// ─── SSE Connection ─────────────────────────────────────────────
const statusPill  = document.getElementById('status-pill');
const statusDot   = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
let sse;

function setOnline(on) {
  if (on) {
    statusPill.className  = 'status-pill online';
    statusDot.classList.add('pulse');
    statusLabel.textContent = 'Connected';
  } else {
    statusPill.className  = 'status-pill offline';
    statusDot.classList.remove('pulse');
    statusLabel.textContent = 'Disconnected';
  }
}

function connectSSE() {
  if (sse) { try { sse.close(); } catch {} }
  sse = new EventSource('/mcp?heartbeat=true');
  sse.onopen  = () => setOnline(true);
  sse.onerror = () => {
    setOnline(false);
    sse.close();
    sse = null;
    setTimeout(connectSSE, 3000);
  };
}

connectSSE();

// ─── Overview Stats ──────────────────────────────────────────────
async function fetchStats() {
  try {
    const [statsRes, provRes] = await Promise.all([
      fetch('/api/token-stats'),
      fetch('/api/provider-stats')
    ]);
    if (!statsRes.ok) return;

    const data      = await statsRes.json();
    const provStats = provRes.ok ? await provRes.json() : {};

    const totals = data.serverTotals || {};
    document.getElementById('stat-daily-req').textContent = fmt(totals.dailyRequests);
    document.getElementById('stat-daily-tok').textContent = fmt(totals.dailyTokens);
    document.getElementById('stat-lifetime').textContent  = fmt(totals.lifetimeRequests);

    renderProviders(data.stats || [], provStats);
  } catch (err) {
    console.error('[Dashboard] fetchStats error:', err);
  }
}

// ─── Providers Grid ──────────────────────────────────────────────
const providersGrid = document.getElementById('providers-grid');

function renderProviders(providers, provStats) {
  if (!providers.length) {
    providersGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:48px 0;color:var(--text-muted);">No providers configured.</div>';
    document.getElementById('stat-providers').textContent = '0';
    return;
  }

  let activeCount = 0;

  providersGrid.innerHTML = providers.map(p => {
    const ps      = provStats[p.id] || { errors: 0, circuitOpen: false };
    const online  = p.isAvailable && !ps.circuitOpen;
    if (online) activeCount++;

    const quota   = p.rateLimits?.tokensPerMonth || p.rateLimits?.rpd || p.rateLimits?.rpm || 'Free';
    const daily   = p.usage ? `${fmt(p.usage.dailyTotalRequests)} reqs / ${fmt(p.usage.dailyTotalTokens)} tokens` : '0 reqs / 0 tokens';
    const life    = p.usage ? `${fmt(p.usage.localTotalRequests)} reqs / ${fmt(p.usage.localTotalTokens)} tokens` : '0 reqs / 0 tokens';

    let badgeCls = ps.circuitOpen ? 'badge-amber' : (p.isAvailable ? 'badge-green' : 'badge-red');
    let badgeTxt = ps.circuitOpen ? '⏸ Circuit Open' : (p.isAvailable ? '● Online' : '✕ Offline');

    return `
    <div class="provider-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        <div>
          <div class="provider-name">${esc(p.name)}</div>
          <div class="provider-id">${esc(p.id)}</div>
        </div>
        <span class="badge ${badgeCls}">${badgeTxt}</span>
      </div>

      ${ps.errors > 0 ? `<div style="font-size:.72rem;color:var(--accent-red);margin-bottom:6px;">⚠ ${ps.errors} error${ps.errors > 1 ? 's' : ''}</div>` : ''}
      ${ps.circuitOpen ? `<div style="font-size:.72rem;color:var(--accent-amber);margin-bottom:6px;">⏱ ${Math.ceil((ps.cooldownRemaining||0)/1000)}s cooldown</div>` : ''}

      <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>

      <div class="provider-stat"><span>Quota</span><span>${esc(String(quota))}</span></div>
      <div class="provider-stat" style="color:var(--accent-cyan);"><span>📅 Daily</span><span>${esc(daily)}</span></div>
      <div class="provider-stat"><span>🕒 Lifetime</span><span>${esc(life)}</span></div>

      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--glass-border);display:flex;justify-content:flex-end;">
        <button class="btn btn-outline btn-sm verify-btn" data-pid="${esc(p.id)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          Verify
        </button>
      </div>
    </div>`;
  }).join('');

  document.getElementById('stat-providers').textContent = activeCount;

  // Bind verify buttons
  providersGrid.querySelectorAll('.verify-btn').forEach(btn => {
    btn.addEventListener('click', () => verifyProvider(btn.dataset.pid, btn));
  });
}

async function verifyProvider(providerId, btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Verifying…';
  try {
    const r  = await fetch('/api/validate-provider', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ providerId }) });
    const d  = await r.json();
    btn.innerHTML = d.success ? '✓ OK' : '✗ Failed';
    btn.style.color = d.success ? 'var(--accent-green)' : 'var(--accent-red)';
    setTimeout(() => { btn.innerHTML = orig; btn.style.color=''; btn.disabled=false; fetchStats(); }, 2000);
  } catch {
    btn.innerHTML = '✗ Error';
    btn.style.color = 'var(--accent-red)';
    setTimeout(() => { btn.innerHTML = orig; btn.style.color=''; btn.disabled=false; }, 2000);
  }
}

document.getElementById('refresh-btn').addEventListener('click', fetchStats);

// ─── TOOL PLAYGROUND ─────────────────────────────────────────────

// Tool definitions
const TOOLS = [
  {
    id: 'use_free_llm', label: 'use_free_llm', icon: '💬',
    tag: 'Chat / Coding',
    fields: [
      { id: 'prompt', label: 'User Message', type: 'textarea', placeholder: 'Write a Hello World in Go' },
      { id: 'model',  label: 'Model Override', type: 'model-picker' },
      { id: 'keywords', label: 'Keywords (comma-separated)', type: 'text', placeholder: 'e.g. jwt, security' },
      { id: 'agentic', label: 'Agentic Mode', type: 'toggle', hint: 'Enable subtask decomposition' },
    ]
  },
  {
    id: 'vision_tool', label: 'vision_tool', icon: '👁',
    tag: 'Vision / VLM',
    fields: [
      { id: 'image_path', label: 'Image Path', type: 'text', placeholder: 'file:///C:/path/to/screenshot.png' },
      { id: 'prompt',     label: 'Analysis Prompt', type: 'textarea', placeholder: 'Describe the UI layout' },
      { id: 'model',      label: 'Model Override', type: 'model-picker' },
    ]
  },
  {
    id: 'execute_skill', label: 'execute_skill', icon: '⚡',
    tag: 'Skill Execution',
    fields: [
      { id: 'skill', label: 'Skill Name', type: 'text', placeholder: 'ab-test-setup' },
      { id: 'input', label: 'Task Input', type: 'textarea', placeholder: 'Design an A/B test for the checkout button' },
      { id: 'model', label: 'Model Override', type: 'model-picker' },
    ]
  },
  {
    id: 'manage_memory', label: 'manage_memory', icon: '🧠',
    tag: 'Memory',
    fields: [
      { id: 'action', label: 'Action', type: 'select', options: ['search','list','stats','clear'] },
      { id: 'query',  label: 'Query (for search)', type: 'text', placeholder: 'authentication patterns' },
      { id: 'limit',  label: 'Limit (results)', type: 'number', placeholder: '5' },
    ]
  },
  {
    id: 'index_workspace', label: 'index_workspace', icon: '🗂',
    tag: 'Indexing',
    fields: [
      { id: 'force', label: 'Force Re-index', type: 'toggle', hint: 'Re-index even if already indexed' },
    ]
  },
  {
    id: 'store_workspace_skill', label: 'store_workspace_skill', icon: '💾',
    tag: 'Skill Storage',
    fields: [
      { id: 'name',        label: 'Skill Name', type: 'text', placeholder: 'db-migration-helper' },
      { id: 'description', label: 'Description', type: 'text', placeholder: 'Database migration verification utility' },
      { id: 'what',        label: 'What was done (one item per line)', type: 'textarea', placeholder: 'Added verify-migrations.sh\nIntegrated schema diff checks' },
      { id: 'why',         label: 'Why', type: 'text', placeholder: 'Prevent schema drift during deployments' },
      { id: 'files',       label: 'Files (comma-separated)', type: 'text', placeholder: 'scripts/verify-migrations.sh' },
    ]
  },
  {
    id: 'get_token_stats', label: 'get_token_stats', icon: '📊',
    tag: 'Monitoring',
    fields: []
  },
  {
    id: 'validate_provider', label: 'validate_provider', icon: '🛡',
    tag: 'Health Check',
    fields: [
      { id: 'providerId', label: 'Provider ID', type: 'text', placeholder: 'groq' },
    ]
  },
];

let activeTool = TOOLS[0];
let availableModels = [];

const toolList      = document.getElementById('tool-list');
const pgForm        = document.getElementById('pg-form');
const pgToolTitle   = document.getElementById('pg-tool-title');
const pgRunBtn      = document.getElementById('pg-run-btn');
const pgClearBtn    = document.getElementById('pg-clear-btn');
const pgCopyBtn     = document.getElementById('pg-copy-btn');
const pgResponseBody = document.getElementById('pg-response-body');
const pgLatency     = document.getElementById('pg-latency');
const pgStatus      = document.getElementById('pg-status');
const pgWorkspace   = document.getElementById('pg-workspace');

// Persist workspace root
pgWorkspace.value = localStorage.getItem('mcp-workspace') || '';
pgWorkspace.addEventListener('change', () => localStorage.setItem('mcp-workspace', pgWorkspace.value.trim()));

// Build tool list sidebar
toolList.innerHTML = TOOLS.map((t, i) => `
  <div class="tool-item${i === 0 ? ' active' : ''}" data-tool="${t.id}">
    <span class="tool-item-icon">${t.icon}</span>
    <div>
      <div class="tool-item-name">${t.label}</div>
      <div class="tool-item-tag">${t.tag}</div>
    </div>
  </div>
`).join('');

toolList.querySelectorAll('.tool-item').forEach(item => {
  item.addEventListener('click', () => {
    toolList.querySelectorAll('.tool-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    activeTool = TOOLS.find(t => t.id === item.dataset.tool);
    renderToolForm(activeTool);
  });
});

async function ensureModels() {
  if (availableModels.length) return;
  try {
    const r = await fetch('/api/models');
    if (!r.ok) return;
    const d = await r.json();
    availableModels = d.models || [];
  } catch {}
}

function renderToolForm(tool) {
  pgToolTitle.textContent = tool.label;
  pgForm.innerHTML = '';

  if (!tool.fields.length) {
    pgForm.innerHTML = '<p style="color:var(--text-muted);font-size:.8rem;">No parameters required — just click Run Tool.</p>';
    return;
  }

  tool.fields.forEach(f => {
    const wrap = document.createElement('div');
    wrap.id = `field-wrap-${f.id}`;

    const lbl = document.createElement('label');
    lbl.className = 'field-label';
    lbl.setAttribute('for', `pg-field-${f.id}`);
    lbl.textContent = f.label;
    wrap.appendChild(lbl);

    if (f.type === 'toggle') {
      lbl.className = '';
      const row = document.createElement('div');
      row.className = 'toggle-row';

      const tog = document.createElement('label');
      tog.className = 'toggle';
      const inp = document.createElement('input');
      inp.type = 'checkbox'; inp.id = `pg-field-${f.id}`;
      const slider = document.createElement('span');
      slider.className = 'toggle-slider';
      tog.appendChild(inp); tog.appendChild(slider);

      const hint = document.createElement('span');
      hint.style.cssText = 'font-size:.8rem;color:var(--text-secondary);';
      hint.textContent = f.hint || f.label;

      row.appendChild(tog); row.appendChild(hint);
      wrap.innerHTML = '';
      wrap.appendChild(row);

    } else if (f.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.id = `pg-field-${f.id}`;
      ta.placeholder = f.placeholder || '';
      wrap.appendChild(ta);

    } else if (f.type === 'select') {
      const sel = document.createElement('select');
      sel.id = `pg-field-${f.id}`;
      (f.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        sel.appendChild(o);
      });
      wrap.appendChild(sel);

    } else if (f.type === 'model-picker') {
      const container = document.createElement('div');
      container.style.cssText = 'display:flex;gap:8px;align-items:center;';

      const sel = document.createElement('select');
      sel.id = `pg-field-${f.id}`;
      sel.style.flex = '1';

      const optAuto = document.createElement('option');
      optAuto.value = '';
      optAuto.textContent = '— auto-route (recommended) —';
      sel.appendChild(optAuto);

      const populate = () => {
        while (sel.options.length > 1) sel.remove(1);
        availableModels.forEach(m => {
          const o = document.createElement('option');
          o.value = m.modelId;
          o.textContent = `${m.modelName} (${m.providerName})`;
          sel.appendChild(o);
        });
      };

      populate();

      // Load on focus
      sel.addEventListener('focus', async () => {
        await ensureModels();
        populate();
      });

      const customInp = document.createElement('input');
      customInp.type = 'text'; customInp.placeholder = 'or type custom model ID…';
      customInp.id = `pg-field-${f.id}-custom`; customInp.style.flex = '1';
      customInp.addEventListener('input', () => { if (customInp.value) sel.value = ''; });
      sel.addEventListener('change', () => { if (sel.value) customInp.value = ''; });

      container.appendChild(sel); container.appendChild(customInp);
      wrap.appendChild(container);

    } else if (f.type === 'number') {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.id = `pg-field-${f.id}`;
      inp.placeholder = f.placeholder || ''; inp.min = 1; inp.max = 100;
      wrap.appendChild(inp);

    } else {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.id = `pg-field-${f.id}`;
      inp.placeholder = f.placeholder || '';
      wrap.appendChild(inp);
    }

    pgForm.appendChild(wrap);
  });
}

function collectParams(tool) {
  const params = {};
  const ws = pgWorkspace.value.trim();
  if (ws) params.workspace_root = ws;

  tool.fields.forEach(f => {
    const el = document.getElementById(`pg-field-${f.id}`);
    if (!el) return;

    if (f.type === 'toggle')       params[f.id] = el.checked;
    else if (f.type === 'number')  params[f.id] = el.value ? parseInt(el.value, 10) : undefined;
    else if (f.type === 'model-picker') {
      const custom = document.getElementById(`pg-field-${f.id}-custom`)?.value.trim();
      params[f.id] = custom || el.value || undefined;
    } else if (f.type === 'textarea' && f.id === 'what') {
      params[f.id] = el.value.split('\n').map(l => l.trim()).filter(Boolean);
    } else if (f.id === 'keywords') {
      params[f.id] = el.value ? el.value.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    } else if (f.id === 'files') {
      params[f.id] = el.value ? el.value.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    } else {
      const v = el.value.trim();
      if (v) params[f.id] = v;
    }
  });

  return params;
}

pgRunBtn.addEventListener('click', async () => {
  await ensureModels();
  const params = collectParams(activeTool);

  pgRunBtn.disabled = true;
  pgRunBtn.innerHTML = '<span class="spinner"></span> Running…';
  pgStatus.textContent = '';
  pgLatency.style.display = 'none';
  pgResponseBody.innerHTML = '<span style="color:var(--text-muted);font-style:italic;">Executing…</span>';

  try {
    const r = await fetch('/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: activeTool.id, params })
    });
    const data = await r.json();

    // Show latency
    if (data.latencyMs != null) {
      pgLatency.textContent = `${data.latencyMs}ms`;
      pgLatency.className   = `latency-badge${data.latencyMs > 3000 ? ' slow' : ''}`;
      pgLatency.style.display = 'inline-flex';
    }

    if (data.ok === false || !r.ok) {
      pgResponseBody.innerHTML = `<span class="json-err">Error: ${esc(data.error || 'Unknown error')}</span>`;
      pgStatus.textContent = '✗ Failed';
      pgStatus.style.color = 'var(--accent-red)';
    } else {
      pgResponseBody.innerHTML = highlightJSON(data.result ?? data);
      pgStatus.textContent = '✓ Success';
      pgStatus.style.color = 'var(--accent-green)';
    }
  } catch (err) {
    pgResponseBody.innerHTML = `<span class="json-err">Network error: ${esc(err.message)}</span>`;
    pgStatus.textContent = '✗ Error';
    pgStatus.style.color = 'var(--accent-red)';
  } finally {
    pgRunBtn.disabled = false;
    pgRunBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Tool`;
  }
});

pgClearBtn.addEventListener('click', () => {
  pgResponseBody.innerHTML = '<span style="color:var(--text-muted);font-style:italic;">Run a tool to see the response here…</span>';
  pgLatency.style.display = 'none';
  pgStatus.textContent = '';
});

pgCopyBtn.addEventListener('click', () => {
  const text = pgResponseBody.innerText;
  navigator.clipboard.writeText(text).then(() => {
    pgCopyBtn.textContent = 'Copied!';
    setTimeout(() => { pgCopyBtn.textContent = 'Copy'; }, 1500);
  });
});

// Render initial form
renderToolForm(activeTool);

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
      o.value = s; o.textContent = s;
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
    renderQueue('queue-now',     d.queues?.nowQueue);
    renderQueue('queue-next',    d.queues?.nextQueue);
    renderQueue('queue-blocked', d.queues?.blockedQueue);
    renderHistory(d.queues?.history);
    memUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    memKnowledge.value = `Fetch error: ${err.message}`;
  }
}

function renderQueue(id, items) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!items?.length) {
    el.innerHTML = '<div class="queue-empty">—</div>';
    return;
  }
  el.innerHTML = items.map(item => `
    <div class="queue-item">
      <span class="queue-chevron">›</span>
      <span>${esc(String(item))}</span>
    </div>`).join('');
}

function renderHistory(history) {
  const el = document.getElementById('queue-history');
  if (!el) return;
  if (!history || history.length === 0) {
    el.innerHTML = '<div class="queue-empty">No subtask history recorded yet.</div>';
    return;
  }

  el.innerHTML = history.map((h, idx) => {
    const dateStr = new Date(h.timestamp).toLocaleTimeString();
    const filesStr = h.filesModified && h.filesModified.length > 0
      ? `<div style="font-size:.7rem;color:var(--accent-cyan);margin-top:4px;">Files: ${h.filesModified.map(f => `<code>${esc(f)}</code>`).join(', ')}</div>`
      : '';
    return `
      <div class="queue-item" style="flex-direction:column;align-items:stretch;gap:4px;">
        <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="const out = document.getElementById('hist-out-${idx}'); out.style.display = out.style.display === 'none' ? 'block' : 'none';">
          <span style="font-weight:600;color:var(--text-primary);">[${idx + 1}] ${esc(h.task)}</span>
          <span style="font-size:.7rem;color:var(--text-muted);margin-left:auto;">${dateStr}</span>
        </div>
        ${filesStr}
        <pre id="hist-out-${idx}" style="display:none;margin-top:8px;padding:8px;font-size:.72rem;background:rgba(0,0,0,.3);border-color:var(--glass-border);color:var(--text-secondary);white-space:pre-wrap;word-break:break-all;">${esc(h.output)}</pre>
      </div>
    `;
  }).join('');
}

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
