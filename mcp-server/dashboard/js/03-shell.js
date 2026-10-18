'use strict';
// ─── Tab System ─────────────────────────────────────────────────
const tabBtns   = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

function activateTab(target) {
  const btn = [...tabBtns].find(b => b.dataset.tab === target);
  if (!btn) return false;
  tabBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
  tabPanels.forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  btn.setAttribute('aria-selected','true');
  document.getElementById(`panel-${target}`)?.classList.add('active');

  // Tab-specific actions
  if (target === 'memory')   { fetchSessions(); if (activeMemSid) startMemPoll(activeMemSid); }
  if (target === 'providers') { fetchStats(); fetchSearchData(); }
  if (target === 'playground') ensureModels();
  if (target === 'profile')  { fetchUserConfig(); fetchLeaderboard(); }
  if (target === 'wiki')     { initWikiTab(); }
  if (target === 'dagmemory') { initDagMemoryTab(); }
  if (target === 'harness')   { initHarnessTab(); }
  if (target === 'movie')     { window.initMovieTab?.(); }

  try { localStorage.setItem('flm.activeTab', target); } catch {}
  return true;
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// Status-quo: reopen the last visited tab (default stays Overview).
// Deferred to window load — tab-specific actions call functions defined in
// scripts that load after this one.
window.addEventListener('load', () => {
  try {
    const saved = localStorage.getItem('flm.activeTab');
    if (saved && saved !== 'overview') activateTab(saved);
  } catch {}
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
    const lifetimeEl = document.getElementById('stat-lifetime');
    lifetimeEl.textContent = fmt(totals.lifetimeRequests);
    // Lifetime totals reset in-memory on a small interval now, so the server prefers a
    // Firebase-synced read for this figure — surface which source it actually came from.
    lifetimeEl.title = data.lifetimeSource === 'firebase'
      ? `Synced from Firebase${data.lastSyncTime ? ' (last sync: ' + new Date(data.lastSyncTime).toLocaleString() + ')' : ''}`
      : 'Local count (Firebase sync unavailable/offline)';

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
}

// Delegated: bound once (not re-bound per render), since providersGrid.innerHTML
// gets fully replaced by fetchStats() every 5s — a per-render addEventListener
// binding is harmless here, but the button element itself can be swapped out
// from under an in-flight click, so verifyProvider() below re-queries the live
// node by data-pid at each step instead of trusting the one it started with.
providersGrid?.addEventListener('click', (e) => {
  const btn = e.target.closest('.verify-btn');
  if (btn) verifyProvider(btn.dataset.pid);
});

const VERIFY_BTN_MARKUP = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          Verify`;

function getVerifyBtn(providerId) {
  return providersGrid?.querySelector(`.verify-btn[data-pid="${CSS.escape(providerId)}"]`) || null;
}

async function verifyProvider(providerId) {
  const setState = (html, color, disabled) => {
    const live = getVerifyBtn(providerId); // periodic refresh may have replaced the node
    if (!live) return;
    live.innerHTML = html;
    live.style.color = color;
    live.disabled = disabled;
  };
  setState('<span class="spinner"></span> Verifying…', '', true);
  try {
    const r  = await fetch('/api/validate-provider', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ providerId }) });
    const d  = await r.json();
    setState(d.success ? '✓ OK' : '✗ Failed', d.success ? 'var(--accent-green)' : 'var(--accent-red)', true);
    setTimeout(() => { setState(VERIFY_BTN_MARKUP, '', false); fetchStats(); }, 2000);
  } catch {
    setState('✗ Error', 'var(--accent-red)', true);
    setTimeout(() => { setState(VERIFY_BTN_MARKUP, '', false); }, 2000);
  }
}

document.getElementById('refresh-btn').addEventListener('click', fetchStats);

// ─── Search Providers + Recent Search Logs (v1.0.9 SearchRouterMiddleware) ──
const searchProvidersGrid = document.getElementById('search-providers-grid');
const searchLogsTbody     = document.getElementById('search-logs-tbody');

function renderSearchProviders(providers) {
  if (!searchProvidersGrid) return;
  if (!providers.length) {
    searchProvidersGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:24px 0;color:var(--text-muted);">No search providers configured.</div>';
    return;
  }
  searchProvidersGrid.innerHTML = providers.map(p => {
    const badgeCls = p.available ? 'badge-green' : 'badge-red';
    const badgeTxt = p.available ? '● Online' : '✕ Unavailable';
    return `
    <div class="provider-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        <div>
          <div class="provider-name">${esc(p.name)}</div>
          <div class="provider-id">${esc(p.id)}${p.keyless ? ' · keyless' : ''}</div>
        </div>
        <span class="badge ${badgeCls}">${badgeTxt}</span>
      </div>
      ${p.consecutiveFailures > 0 ? `<div style="font-size:.72rem;color:var(--accent-red);margin-bottom:6px;">⚠ ${p.consecutiveFailures} failure${p.consecutiveFailures > 1 ? 's' : ''}</div>` : ''}
      <div class="provider-stat"><span>Penalty score</span><span>${p.penaltyScore.toFixed(2)}</span></div>
    </div>`;
  }).join('');
}

// Renders the full result list (all URLs + snippets, not a preview slice) inside a
// <details>/<summary> dropdown — same collapsed-by-default pattern as the Tool
// Playground's subtask "View Injected Context" cards (addSubtaskResponseBubble above).
function renderSearchResultsDropdown(results) {
  if (!Array.isArray(results) || results.length === 0) return '—';
  return `
    <details>
      <summary style="cursor:pointer; font-size:.72rem; color:var(--accent-cyan); outline:none; list-style:none;">
        📂 ${results.length} result${results.length > 1 ? 's' : ''}
      </summary>
      <ul style="margin-top:6px; padding-left:16px; font-size:.72rem; color:var(--text-muted); display:flex; flex-direction:column; gap:8px; list-style-type:circle; max-width:520px;">
        ${results.map(r => `
          <li>
            <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || r.url)}</a>
            ${r.snippet ? `<div style="margin-top:2px;">${esc(r.snippet)}</div>` : ''}
          </li>`).join('')}
      </ul>
    </details>`;
}

function renderSearchLogs(logs) {
  if (!searchLogsTbody) return;
  if (!logs.length) {
    searchLogsTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px;">No search activity yet.</td></tr>';
    return;
  }
  searchLogsTbody.innerHTML = logs.map(l => `
    <tr>
      <td style="white-space:nowrap;">${esc(new Date(l.timestamp).toLocaleString())}</td>
      <td>${esc(l.query)}</td>
      <td><span class="badge badge-cyan">${esc(l.provider)}</span></td>
      <td>${fmt(l.resultCount)}</td>
      <td>${renderSearchResultsDropdown(l.results)}</td>
    </tr>`).join('');
}

async function fetchSearchData() {
  try {
    const [provRes, logsRes] = await Promise.all([
      fetch('/api/search-provider-stats'),
      fetch('/api/search-logs'),
    ]);
    if (provRes.ok) renderSearchProviders(await provRes.json());
    if (logsRes.ok) renderSearchLogs(await logsRes.json());
  } catch (err) {
    console.error('[Dashboard] fetchSearchData error:', err);
  }
}

