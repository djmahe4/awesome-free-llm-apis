const statusEl = document.getElementById('connection-status');
const containerEl = document.getElementById('provider-cards-container');
const refreshBtn = document.getElementById('refresh-btn');
const toastEl = document.getElementById('liveToast');
const toast = new bootstrap.Toast(toastEl);

function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(title, message, isError = false) {
    const titleEl = document.getElementById('toast-title');
    const bodyEl = document.getElementById('toast-body');
    const iconEl = document.getElementById('toast-icon');

    titleEl.innerText = title;
    bodyEl.innerText = message;
    iconEl.className = isError ? 'bi bi-exclamation-triangle me-2 text-danger' : 'bi bi-check-circle me-2 text-success';

    toast.show();
}

let stats = [];

async function fetchStats() {
    try {
        const response = await fetch('/api/token-stats');
        if (!response.ok) throw new Error('API Unavailable');

        const data = await response.json();
        stats = data.stats;

        renderStats(stats);
    } catch (err) {
        console.error('Fetch failed:', err);
    }
}

function renderStats(providers) {
    if (!providers || providers.length === 0) {
        containerEl.innerHTML = '<div class="col-12 text-center py-5">No providers configured</div>';
        return;
    }

    let activeCount = 0;
    containerEl.innerHTML = providers.map(p => {
        if (p.isAvailable) activeCount++;

        const tokensLimit = p.rateLimits.tokensPerMonth || p.rateLimits.rpd || p.rateLimits.rpm || 'Free';
        const usageStr = p.usage
            ? `${p.usage.requests} reqs / ${p.usage.tokens} tokens`
            : 'No usage yet';

        return `
        <div class="col-md-6 col-lg-4">
            <div class="card h-100">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start mb-2">
                        <h6 class="card-title mb-0">${escapeHTML(p.name)}</h6>
                        <span class="badge ${p.isAvailable ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'} rounded-pill">
                            <i class="bi bi-circle-fill me-1 small"></i>${p.isAvailable ? 'Online' : 'Offline'}
                        </span>
                    </div>
                    <div class="provider-id mb-3">${escapeHTML(p.id)}</div>
                    
                    <div class="mb-3">
                        <div class="d-flex justify-content-between small text-muted mb-1">
                            <span>Quota</span>
                            <span>${escapeHTML(String(tokensLimit))}</span>
                        </div>
                        <div class="progress">
                            <div class="progress-bar" role="progressbar" style="width: 100%"></div>
                        </div>
                    </div>

                    <div class="small">
                        <div class="d-flex justify-content-between text-muted mb-1">
                            <span>Current Usage</span>
                            <span class="text-light">${escapeHTML(usageStr)}</span>
                        </div>
                    </div>
                    <div class="mt-3 pt-2 border-top border-secondary-subtle d-flex justify-content-end">
                        <button class="btn btn-xs btn-link text-primary p-0 text-decoration-none" onclick="verifyProvider('${p.id}', event)">
                            <i class="bi bi-shield-check me-1"></i>Verify Credential
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    }).join('');

    document.getElementById('active-providers').innerText = activeCount;
}

// Make verifyProvider globally available for inline onclick handlers, 
// though attaching event listeners is better practice for CSP.
window.verifyProvider = async function (providerId, event) {
    const btn = event.target.closest('button');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Verifying...';

    try {
        const response = await fetch('/api/validate-provider', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerId })
        });
        const result = await response.json();

        if (result.success) {
            showToast('Verification Success', result.message + (result.latencyMs ? ` (Latency: ${result.latencyMs}ms)` : ''));
        } else {
            showToast('Verification Failed', result.message, true);
        }
    } catch (err) {
        showToast('Error', err.message, true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
        fetchStats(); // Update UI
    }
};

function updateConnectionStatus(online) {
    if (online) {
        statusEl.classList.remove('border-danger', 'text-danger');
        statusEl.classList.add('border-success', 'text-success');
        statusEl.innerHTML = '<i class="bi bi-broadcast me-2 pulse"></i>Connected';
    } else {
        statusEl.classList.remove('border-success', 'text-success');
        statusEl.classList.add('border-danger', 'text-danger');
        statusEl.innerHTML = '<i class="bi bi-exclamation-triangle me-2"></i>Disconnected';
    }
}

refreshBtn.addEventListener('click', fetchStats);

// Initial fetch and poll
fetchStats();
setInterval(fetchStats, 5000);

// ─── Short-Term Memory Buffers (Tab 4) ───────────────────────────────────────

const memorySessionInput = document.getElementById('memory-session-input');
const memorySessionSelect = document.getElementById('memory-session-select');
const memoryLoadBtn = document.getElementById('memory-load-btn');
const memoryRefreshBtn = document.getElementById('memory-refresh-btn');
const memoryKnowledge = document.getElementById('memory-knowledge');
const memoryLastUpdated = document.getElementById('memory-last-updated');
const memorySessionLabel = document.getElementById('memory-session-label');

let activeMemorySession = '';
let memoryPollInterval = null;

async function fetchSessions() {
    try {
        const res = await fetch('/api/sessions');
        if (!res.ok) return;
        const data = await res.json();
        const sessions = data.sessions || [];
        // Repopulate dropdown, keeping the blank first option
        while (memorySessionSelect.options.length > 1) memorySessionSelect.remove(1);
        sessions.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            memorySessionSelect.appendChild(opt);
        });
    } catch { /* server may not be running, ignore */ }
}

async function fetchMemory(sessionId) {
    if (!sessionId) return;
    try {
        const res = await fetch(`/api/memory/${encodeURIComponent(sessionId)}`);
        if (!res.ok) {
            memoryKnowledge.value = `Error: ${res.status} – ${res.statusText}`;
            return;
        }
        const data = await res.json();
        memoryKnowledge.value = data.knowledge || '';
        memorySessionLabel.textContent = ` — ${escapeHTML(data.sessionId)}`;
        renderQueue('queue-now', data.queues?.nowQueue);
        renderQueue('queue-next', data.queues?.nextQueue);
        renderQueue('queue-blocked', data.queues?.blockedQueue);
        memoryLastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
        memoryKnowledge.value = `Fetch error: ${err.message}`;
    }
}

function renderQueue(elementId, items) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (!items || items.length === 0) {
        el.innerHTML = '<li class="text-muted fst-italic">—</li>';
        return;
    }
    el.innerHTML = items.map(item =>
        `<li class="mb-1 d-flex align-items-start gap-1">
            <i class="bi bi-chevron-right text-secondary mt-1" style="font-size:0.7rem"></i>
            <span>${escapeHTML(String(item))}</span>
        </li>`
    ).join('');
}

function startMemoryPoll(sessionId) {
    stopMemoryPoll();
    activeMemorySession = sessionId;
    fetchMemory(sessionId);
    memoryPollInterval = setInterval(() => fetchMemory(sessionId), 3000);
}

function stopMemoryPoll() {
    if (memoryPollInterval) {
        clearInterval(memoryPollInterval);
        memoryPollInterval = null;
    }
}

memoryLoadBtn.addEventListener('click', () => {
    const sid = memorySessionInput.value.trim();
    if (sid) startMemoryPoll(sid);
});

memorySessionSelect.addEventListener('change', () => {
    const sid = memorySessionSelect.value;
    if (sid) {
        memorySessionInput.value = sid;
        startMemoryPoll(sid);
    }
});

memoryRefreshBtn.addEventListener('click', () => {
    if (activeMemorySession) fetchMemory(activeMemorySession);
});

// Only poll when the Cache & Memory tab is visible to avoid wasted requests
document.getElementById('cache-tab').addEventListener('shown.bs.tab', () => {
    fetchSessions();
    if (activeMemorySession) startMemoryPoll(activeMemorySession);
});
document.getElementById('cache-tab').addEventListener('hidden.bs.tab', stopMemoryPoll);

// Refresh session list periodically so newly-started sessions appear automatically
setInterval(() => {
    const cacheTabActive = document.getElementById('cache')?.classList.contains('active');
    if (cacheTabActive) fetchSessions();
}, 10000);

// Setup SSE connection to the new unified endpoint for real-time status
let eventSource;
function connectSSE() {
    if (eventSource) {
        eventSource.close();
    }

    eventSource = new EventSource('/mcp?heartbeat=true');

    eventSource.onopen = () => {
        updateConnectionStatus(true);
    };

    eventSource.onerror = (err) => {
        console.error('SSE Connection Error:', err);
        updateConnectionStatus(false);
        eventSource.close();
        eventSource = null;
        // Attempt to reconnect after 3 seconds
        setTimeout(connectSSE, 3000);
    };
}

// Initialize SSE connection
connectSSE();
