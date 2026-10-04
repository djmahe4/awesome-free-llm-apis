'use strict';
// ─── Harness & Multi-Agent Telemetry Tab ────────────────────────
let harnessInitialized = false;
let currentHarnessRunId = null;

const harnessWorkspaceInput   = document.getElementById('harness-workspace-input');
const harnessRefreshBtn        = document.getElementById('harness-refresh-btn');
const harnessLeasesContainer   = document.getElementById('harness-leases-container');
const harnessLeaseCount        = document.getElementById('harness-lease-count');
const harnessReasoningContainer= document.getElementById('harness-reasoning-container');
const harnessReasoningCount    = document.getElementById('harness-reasoning-count');
const harnessRunsTbody         = document.getElementById('harness-runs-tbody');
const harnessRunsCount         = document.getElementById('harness-runs-count');
const harnessRunDetailPanel    = document.getElementById('harness-run-detail-panel');
const harnessDetailTitle       = document.getElementById('harness-detail-title');
const harnessDetailClose       = document.getElementById('harness-detail-close');
const harnessRerunRole         = document.getElementById('harness-rerun-role');
const harnessRerunContext      = document.getElementById('harness-rerun-context');
const harnessRerunSubmit       = document.getElementById('harness-rerun-submit');
const harnessRerunMsg          = document.getElementById('harness-rerun-msg');
const harnessTasksView         = document.getElementById('harness-tasks-view');
const harnessTraceView         = document.getElementById('harness-trace-view');
const harnessSessionMemoryView = document.getElementById('harness-session-memory-view');

function initHarnessTab() {
  if (!harnessInitialized) {
    harnessInitialized = true;
    const savedWs = localStorage.getItem('mcp-workspace') || (document.getElementById('pg-workspace')?.value || '').trim();
    if (savedWs && harnessWorkspaceInput) {
      harnessWorkspaceInput.value = savedWs;
    }
  }
  fetchHarnessTelemetry();
}

async function fetchHarnessTelemetry() {
  const ws = (harnessWorkspaceInput?.value || '').trim();
  const url = ws ? `/api/harness/runs?workspace=${encodeURIComponent(ws)}` : '/api/harness/runs';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderHarnessTelemetry(data);
  } catch (err) {
    console.warn('[Harness] Failed to fetch runs:', err);
    if (harnessRunsTbody) {
      harnessRunsTbody.innerHTML = `<tr><td colspan="6" class="conv-empty" style="color:var(--accent-red);padding:24px;text-align:center;">Failed to load harness data: ${esc(err.message)}</td></tr>`;
    }
  }
}

function renderHarnessTelemetry(data) {
  const { runs = [], activeScopes = [], reasoningScopes = [], wikiPages = [] } = data;

  // Render Wiki Nexus Card
  const wikiCount = document.getElementById('harness-wiki-count');
  const wikiList = document.getElementById('harness-wiki-list');
  if (wikiCount) wikiCount.textContent = `${wikiPages.length} pages indexed`;
  if (wikiList) {
    if (wikiPages.length === 0) {
      wikiList.innerHTML = '<span style="font-size:.75rem;color:var(--text-muted);font-style:italic;">No wiki documents linked to current session.</span>';
    } else {
      wikiList.innerHTML = wikiPages.map(wp => `
        <div class="wiki-tag" style="display:inline-flex;align-items:center;gap:6px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);padding:4px 10px;border-radius:20px;font-size:.75rem;cursor:pointer;transition:background .2s;" 
             onclick="const wb = document.querySelector('[data-tab=\\'wiki\\']'); if (wb) { wb.click(); }">
          <span style="color:#60a5fa;">📄</span>
          <span style="font-weight:600;color:var(--text-primary);">${esc(wp.title)}</span>
          <span style="font-size:.65rem;color:var(--text-muted);">${(wp.size / 1024).toFixed(1)}KB</span>
        </div>
      `).join('');
    }
  }

  // Render File Leases
  if (harnessLeaseCount) harnessLeaseCount.textContent = `${activeScopes.length} active`;
  if (harnessLeasesContainer) {
    if (activeScopes.length === 0) {
      harnessLeasesContainer.innerHTML = '<div class="conv-empty" style="padding:16px;">No active file claims in scopes.json</div>';
    } else {
      harnessLeasesContainer.innerHTML = activeScopes.map(scope => `
        <div style="padding:10px 14px;border-bottom:1px solid var(--glass-border);display:flex;flex-direction:column;gap:4px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-weight:600;font-size:.78rem;color:var(--accent-cyan);font-family:'JetBrains Mono',monospace;">Agent: ${esc(scope.agentId)}</span>
            <span style="font-size:.7rem;color:var(--text-muted);">${new Date(scope.claimedAt).toLocaleTimeString()}</span>
          </div>
          <div style="font-size:.73rem;color:var(--text-secondary);word-break:break-all;">
            <strong>Files:</strong> ${(scope.files || []).map(f => `<code style="background:rgba(255,255,255,0.06);padding:2px 4px;border-radius:3px;margin-right:4px;">${esc(f)}</code>`).join(' ')}
          </div>
        </div>
      `).join('');
    }
  }

  // Render Reasoning Scopes
  if (harnessReasoningCount) harnessReasoningCount.textContent = `${reasoningScopes.length} scopes`;
  if (harnessReasoningContainer) {
    if (reasoningScopes.length === 0) {
      harnessReasoningContainer.innerHTML = '<div class="conv-empty" style="padding:16px;">No reasoning scopes registered</div>';
    } else {
      harnessReasoningContainer.innerHTML = reasoningScopes.map(r => `
        <div style="padding:10px 14px;border-bottom:1px solid var(--glass-border);display:flex;flex-direction:column;gap:4px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-weight:600;font-size:.78rem;color:var(--accent-purple);">Role: ${esc(r.role)} (${esc(r.agentId)})</span>
            <span style="font-size:.7rem;color:var(--text-muted);">${new Date(r.timestamp).toLocaleTimeString()}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;">
            ${(r.keywords || []).map(k => `<span class="badge badge-purple" style="font-size:.62rem;">${esc(k)}</span>`).join('')}
          </div>
          ${r.findingsText ? `<div style="font-size:.7rem;color:var(--text-muted);max-height:48px;overflow:hidden;text-overflow:ellipsis;margin-top:4px;">${esc(r.findingsText)}</div>` : ''}
        </div>
      `).join('');
    }
  }

  // Render Runs Table
  if (harnessRunsCount) harnessRunsCount.textContent = `${runs.length} runs`;
  if (harnessRunsTbody) {
    if (runs.length === 0) {
      harnessRunsTbody.innerHTML = '<tr><td colspan="6" class="conv-empty" style="padding:24px;text-align:center;">No harness runs found.</td></tr>';
    } else {
      harnessRunsTbody.innerHTML = runs.map(run => {
        let badgeCls = 'badge-gray';
        if (run.status === 'completed') badgeCls = 'badge-green';
        else if (run.status === 'running') badgeCls = 'badge-cyan pulse';
        else if (run.status === 'failed') badgeCls = 'badge-red';
        else if (run.status === 'paused') badgeCls = 'badge-amber';

        const started = run.startedAt ? new Date(run.startedAt).toLocaleString() : '--';
        return `
          <tr style="border-bottom:1px solid var(--glass-border);">
            <td style="padding:10px 14px;font-family:'JetBrains Mono',monospace;font-size:.75rem;color:var(--accent-cyan);">${esc(run.runId.slice(0, 8))}…</td>
            <td style="padding:10px 14px;font-weight:500;">${esc(run.declarationName || 'unknown')}</td>
            <td style="padding:10px 14px;"><span class="badge ${badgeCls}">${esc(run.status)}</span></td>
            <td style="padding:10px 14px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(run.goal)}">${esc(run.goal)}</td>
            <td style="padding:10px 14px;color:var(--text-muted);font-size:.75rem;">${esc(started)}</td>
            <td style="padding:10px 14px;text-align:right;">
              <button class="btn btn-secondary btn-sm" onclick="inspectHarnessRun('${esc(run.runId)}')" style="cursor:pointer;padding:4px 8px;font-size:.75rem;">Inspect</button>
            </td>
          </tr>
        `;
      }).join('');
    }
  }
}

async function inspectHarnessRun(runId) {
  currentHarnessRunId = runId;
  const ws = (harnessWorkspaceInput?.value || '').trim();
  const url = `/api/harness/runs/${encodeURIComponent(runId)}${ws ? `?workspace=${encodeURIComponent(ws)}` : ''}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (harnessRunDetailPanel) harnessRunDetailPanel.style.display = 'block';
    if (harnessDetailTitle) harnessDetailTitle.innerHTML = `Run Inspector — <span style="font-family:'JetBrains Mono',monospace;color:var(--accent-cyan);">${esc(runId)}</span>`;
    if (harnessTasksView) harnessTasksView.textContent = data.tasks || 'No tasks.md content available.';
    if (harnessTraceView) {
      if (!data.trace || data.trace.length === 0) {
        harnessTraceView.textContent = 'No trace events recorded.';
      } else {
        harnessTraceView.textContent = data.trace.map(t => {
          const time = new Date(t.ts || t.timestamp || Date.now()).toLocaleTimeString();
          const payload = t.data !== undefined ? t.data : t.payload;
          return `[${time}] [${t.type}] ${JSON.stringify(payload)}`;
        }).join('\n');
      }
    }
    if (harnessSessionMemoryView) {
      const mem = data.sessionMemory || [];
      if (mem.length === 0) {
        harnessSessionMemoryView.textContent = 'No session memory entries yet';
      } else {
        harnessSessionMemoryView.textContent = mem.map(e => `[${e.type}] (${e.role}) ${e.text}`).join('\n');
      }
    }
    if (harnessRerunRole && data.run?.roles && data.run.roles.length > 0) {
      harnessRerunRole.value = data.run.roles[data.run.roles.length - 1];
    }
  } catch (err) {
    console.warn('[Harness] Error inspecting run:', err);
  }
}

window.inspectHarnessRun = inspectHarnessRun;

if (harnessRefreshBtn) {
  harnessRefreshBtn.addEventListener('click', fetchHarnessTelemetry);
}

if (harnessDetailClose) {
  harnessDetailClose.addEventListener('click', () => {
    if (harnessRunDetailPanel) harnessRunDetailPanel.style.display = 'none';
    currentHarnessRunId = null;
  });
}

if (harnessRerunSubmit) {
  harnessRerunSubmit.addEventListener('click', async () => {
    if (!currentHarnessRunId) {
      alert('Please select and inspect a run first.');
      return;
    }
    const role = (harnessRerunRole?.value || '').trim();
    if (!role) {
      alert('Please enter a role name to rerun.');
      return;
    }
    const followupContext = (harnessRerunContext?.value || '').trim();
    const ws = (harnessWorkspaceInput?.value || '').trim();

    harnessRerunSubmit.disabled = true;
    if (harnessRerunMsg) {
      harnessRerunMsg.style.display = 'block';
      harnessRerunMsg.style.color = 'var(--accent-cyan)';
      harnessRerunMsg.textContent = `Re-orchestrating role '${role}'…`;
    }

    try {
      const res = await fetch('/api/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'agent_harness',
          params: {
            action: 'rerun',
            runId: currentHarnessRunId,
            role,
            followupContext,
            workspace_root: ws || undefined
          }
        })
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || 'Re-run failed');
      if (harnessRerunMsg) {
        harnessRerunMsg.style.color = 'var(--accent-green)';
        harnessRerunMsg.textContent = `Successfully re-orchestrated role '${role}'.`;
      }
      await inspectHarnessRun(currentHarnessRunId);
      await fetchHarnessTelemetry();
    } catch (err) {
      if (harnessRerunMsg) {
        harnessRerunMsg.style.color = 'var(--accent-red)';
        harnessRerunMsg.textContent = `Error: ${err.message}`;
      }
    } finally {
      harnessRerunSubmit.disabled = false;
    }
  });
}

