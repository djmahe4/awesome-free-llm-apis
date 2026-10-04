'use strict';
// ─── Keyword & Prompt Steering Inspector Logic ───────────────────
const btnRunSteeringEval = document.getElementById('btn-run-steering-eval');
const steeringQueryInput = document.getElementById('steering-query-input');
const steeringKeywordsInput = document.getElementById('steering-keywords-input');
const steeringWorkspaceInput = document.getElementById('steering-workspace-input');
const steeringAgenticToggle = document.getElementById('steering-agentic-toggle');

const steeringSysTokens = document.getElementById('steering-sys-tokens');
const steeringSysDesc = document.getElementById('steering-sys-desc');
const steeringPayloadTokens = document.getElementById('steering-payload-tokens');
const steeringTokenSavings = document.getElementById('steering-token-savings');
const steeringSavingsLabel = document.getElementById('steering-savings-label');
const steeringSavingsDesc = document.getElementById('steering-savings-desc');
const steeringBloatStatus = document.getElementById('steering-bloat-status');

const steeringMatchedSections = document.getElementById('steering-matched-sections');
const steeringMemoryGates = document.getElementById('steering-memory-gates');
const steeringPersonaBadge = document.getElementById('steering-persona-badge');
const steeringSubtaskView = document.getElementById('steering-subtask-view');
const steeringRawPromptView = document.getElementById('steering-raw-prompt-view');

let _steeringEvalTimer = null;
let _latestSteeringTelemetry = null;
let _currentSteeringTab = 'prompt';

function switchSteeringInspectTab(tab) {
  _currentSteeringTab = tab;
  ['prompt', 'workspace', 'history'].forEach(t => {
    const btn = document.getElementById(`btn-inspect-tab-${t}`);
    if (btn) {
      if (t === tab) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  });
  renderSteeringInspectContent();
}
window.switchSteeringInspectTab = switchSteeringInspectTab;

document.getElementById('btn-inspect-tab-prompt')?.addEventListener('click', () => switchSteeringInspectTab('prompt'));
document.getElementById('btn-inspect-tab-workspace')?.addEventListener('click', () => switchSteeringInspectTab('workspace'));
document.getElementById('btn-inspect-tab-history')?.addEventListener('click', () => switchSteeringInspectTab('history'));

function renderSteeringInspectContent() {
  if (!steeringRawPromptView) return;
  if (!_latestSteeringTelemetry) {
    steeringRawPromptView.textContent = '(Click "Inspect Live Ingestion & Telemetry" or edit inputs to load assembled system prompt...)';
    return;
  }

  const st = _latestSteeringTelemetry;
  if (_currentSteeringTab === 'prompt') {
    steeringRawPromptView.textContent = st.fullAssembledSystemPrompt || '(No system prompt generated)';
  } else if (_currentSteeringTab === 'workspace') {
    const treeText = st.dirTree ? `=== 📂 WORKSPACE DIRECTORY TREE ===\n${st.dirTree}\n\n` : '';
    const codeText = `=== 🔍 EXTRACTED WORKSPACE CODE SNIPPETS & RELEVANT FILES ===\n${st.extractedWorkspaceContext || '(No code snippets matched query keywords)'}`;
    steeringRawPromptView.textContent = `${treeText}${codeText}`;
  } else if (_currentSteeringTab === 'history') {
    const histText = st.chatHistory && st.chatHistory.length > 0
      ? JSON.stringify(st.chatHistory, null, 2)
      : '(No previous chat history in this session)';
    steeringRawPromptView.textContent = `=== 💬 SESSION TURNS & CHAT HISTORY ===\n${histText}`;
  }
}

function debouncedSteeringEvaluation() {
  if (_steeringEvalTimer) clearTimeout(_steeringEvalTimer);
  _steeringEvalTimer = setTimeout(() => {
    runSteeringEvaluation();
  }, 350);
}

async function runSteeringEvaluation() {
  const query = (steeringQueryInput?.value || '').trim();
  const rawKeywordsStr = (steeringKeywordsInput?.value || '').trim();
  const workspaceRoot = (steeringWorkspaceInput?.value || '.').trim();
  const isAgentic = !!steeringAgenticToggle?.checked;

  let userKeywords = [];
  if (rawKeywordsStr) {
    // Sanitize bracketed array or quoted syntax: ["arxiv", "physics"] -> arxiv, physics
    const cleaned = rawKeywordsStr.replace(/[\[\]"'`]/g, '');
    userKeywords = cleaned.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  }

  if (btnRunSteeringEval) {
    btnRunSteeringEval.disabled = true;
    btnRunSteeringEval.innerHTML = '<span class="spinner" style="width:12px;height:12px;display:inline-block;border-width:2px;vertical-align:middle;margin-right:6px;"></span> Evaluating...';
  }
  if (steeringBloatStatus) {
    steeringBloatStatus.textContent = 'EVALUATING ⏳';
  }

  try {
    const response = await fetch('/api/steering_eval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        keywords: userKeywords,
        agentic: isAgentic,
        workspaceRoot
      })
    });

    const data = await response.json();
    if (!data.success || !data.telemetry) {
      if (steeringBloatStatus) steeringBloatStatus.textContent = 'ERROR ⚠️';
      return;
    }

    const st = data.telemetry;
    _latestSteeringTelemetry = st;
    const mem = st.memoryLayers || {};
    const matched = st.matchedSections || [];
    const memoryHierarchy = st.memoryHierarchy || [];

    // Persona & keywords badge
    if (steeringPersonaBadge) {
      const activeKw = (st.keywords && st.keywords.length > 0) ? st.keywords : userKeywords;
      const kwPreview = activeKw.length > 0 ? ` &bull; ${activeKw.length} keywords (<code>${esc(activeKw.slice(0, 3).join(', '))}${activeKw.length > 3 ? '...' : ''}</code>)` : ' &bull; 0 keywords';
      steeringPersonaBadge.innerHTML = `Persona: <code>${esc(st.persona || 'coder')}</code>${kwPreview}`;
    }

    // Stats — measured payload vs estimated agentic run (server-side comparison)
    const sysTokens = mem.sysPromptTokens || 0;
    const payloadTokens = mem.totalContextTokens || 0;
    const cmp = st.comparison || {};
    const singlePass = cmp.singlePassPayloadTokens || payloadTokens;
    const agenticRun = cmp.agenticRunTokens || 0;
    const subtaskCount = cmp.agenticSubtaskCount || 1;

    if (steeringSysTokens) steeringSysTokens.textContent = `${sysTokens.toLocaleString()} tok`;
    if (steeringSysDesc) steeringSysDesc.textContent = isAgentic ? 'Multi-Pass Agentic Subtask' : 'Single-Pass System Prompt';
    if (steeringPayloadTokens) steeringPayloadTokens.textContent = `${payloadTokens.toLocaleString()} tok`;

    if (isAgentic) {
      if (steeringSavingsLabel) steeringSavingsLabel.textContent = 'Estimated Agentic Run';
      if (steeringTokenSavings) steeringTokenSavings.textContent = agenticRun > 0 ? `${agenticRun.toLocaleString()} tok` : '—';
      if (steeringSavingsDesc) steeringSavingsDesc.textContent = agenticRun > 0
        ? `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'} × ~${Math.round(cmp.agenticFirstSubtaskTokens || 0).toLocaleString()} tok`
        : 'No agentic run estimate available';
    } else {
      if (steeringSavingsLabel) steeringSavingsLabel.textContent = 'Net Token Savings';
      const diff = agenticRun - singlePass; // positive = single-pass cheaper
      const savingsPct = agenticRun > 0 ? `${diff >= 0 ? '+' : ''}${((diff / agenticRun) * 100).toFixed(1)}%` : '—';
      if (steeringTokenSavings) steeringTokenSavings.textContent = savingsPct;
      if (steeringSavingsDesc) steeringSavingsDesc.textContent = agenticRun > 0
        ? `${diff >= 0 ? diff.toLocaleString() + ' tok cheaper than' : Math.abs(diff).toLocaleString() + ' tok over'} the ${subtaskCount}-subtask run (${agenticRun.toLocaleString()} tok)`
        : `Measured payload ${singlePass.toLocaleString()} tok (no run estimate)`;
    }

    if (steeringBloatStatus) {
      steeringBloatStatus.textContent = matched.length > 0 ? 'ACTIVE ⚡ (Live Targeted)' : 'CLEAN 🛡️ (0 External Bloat)';
    }

    // Matched prompt.json sections with expandable text
    if (steeringMatchedSections) {
      if (matched.length === 0) {
        steeringMatchedSections.innerHTML = '<div style="font-size:.78rem;color:var(--text-muted);padding:12px;background:rgba(255,255,255,.03);border-radius:6px;border:1px dashed var(--glass-border);display:flex;align-items:center;gap:8px;"><span style="font-size:1.1rem;">🛡️</span><span><strong>Zero External Bloat:</strong> No external prompt.json sections matched the query. Baseline system prompt active.</span></div>';
      } else {
        steeringMatchedSections.innerHTML = matched.map((sec, idx) => `
          <details class="qs-tool-card" style="margin:0;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.45);box-shadow:0 0 12px rgba(168,85,247,.12);border-radius:6px;" ${idx === 0 ? 'open' : ''}>
            <summary style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:10px 14px;">
              <div>
                <span class="qs-tool-name" style="color:var(--accent-purple);font-weight:700;font-size:.84rem;">${esc(sec.title || sec.id)}</span>
                <span class="qs-tool-desc" style="font-size:.74rem;margin-left:8px;">Keywords: <code>${esc((sec.keywords || []).join(', '))}</code> &bull; <span style="color:var(--accent-cyan);font-weight:700;">${sec.tokenCount || 0} tok</span></span>
              </div>
              <span class="badge badge-purple" style="font-size:.72rem;padding:3px 8px;box-shadow:0 0 8px rgba(168,85,247,.4);">⚡ Injected & Active</span>
            </summary>
            <div style="padding:10px 14px;border-top:1px solid rgba(168,85,247,.2);background:rgba(10,10,15,.7);">
              <div style="font-size:.72rem;color:var(--text-muted);margin-bottom:6px;font-weight:600;">Injected Prompt Content:</div>
              <pre style="font-size:.72rem;color:var(--text-secondary);white-space:pre-wrap;margin:0;font-family:monospace;max-height:160px;overflow-y:auto;background:rgba(0,0,0,.4);padding:8px 10px;border-radius:4px;border:1px solid rgba(255,255,255,.05);">${esc(sec.content || '(No content text available)')}</pre>
            </div>
          </details>
        `).join('');
      }
    }

    // 5-Layer Memory Priority Hierarchy Deck
    if (steeringMemoryGates) {
      const priorityColors = {
        1: { badge: 'badge-purple', color: 'var(--accent-purple)' },
        2: { badge: 'badge-cyan', color: 'var(--accent-cyan)' },
        3: { badge: 'badge-green', color: 'var(--accent-green)' },
        4: { badge: 'badge-amber', color: 'var(--accent-amber)' },
        5: { badge: 'badge-blue', color: 'var(--accent-blue)' }
      };

      steeringMemoryGates.innerHTML = memoryHierarchy.map((layer, idx) => {
        const pStyle = priorityColors[layer.priority] || { badge: 'badge-purple', color: 'var(--accent-purple)' };
        const isActive = layer.active && layer.tokens > 0;
        return `
          <details class="qs-tool-card" style="margin:0;background:rgba(255,255,255,.02);border:1px solid var(--glass-border);" ${idx === 0 ? 'open' : ''}>
            <summary style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:10px 14px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="badge ${pStyle.badge}" style="font-weight:700;font-size:.72rem;">Priority ${layer.priority} (${layer.level})</span>
                <div>
                  <span style="font-size:.82rem;font-weight:600;color:${pStyle.color};">${esc(layer.name)}</span>
                  <div style="font-size:.7rem;color:var(--text-muted);margin-top:2px;">${esc(layer.description)}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="badge ${isActive ? 'badge-green' : 'badge-gray'}" style="font-size:.68rem;">${isActive ? '⚡ Active' : '💤 Inactive / 0 tok'}</span>
                <span style="font-size:.76rem;font-weight:600;color:var(--text-primary);">${(layer.tokens || 0).toLocaleString()} tok</span>
              </div>
            </summary>
            <div style="padding:10px 14px;border-top:1px solid var(--glass-border);background:rgba(10,10,15,.5);">
              <div style="font-size:.72rem;color:var(--text-muted);margin-bottom:6px;font-weight:600;">Extracted Memory Content Preview:</div>
              <pre style="font-size:.72rem;color:var(--text-secondary);white-space:pre-wrap;margin:0;font-family:monospace;max-height:140px;overflow-y:auto;background:rgba(0,0,0,.3);padding:8px;border-radius:4px;">${esc(layer.content || '(Empty)')}</pre>
            </div>
          </details>
        `;
      }).join('');
    }

    // Subtask & Raw prompt inspector
    if (isAgentic || st.subtaskContext) {
      if (steeringSubtaskView) {
        steeringSubtaskView.style.display = 'block';
        const subId = st.subtaskContext?.id || 'subtask-1';
        const subTitle = st.subtaskContext?.title || (query ? `Execute task: ${query}` : 'System prompt steering subtask');
        const plan = st.planDetails;
        let planHtml = '';

        if (plan && plan.phases && plan.phases.length > 0) {
          const phasesList = plan.phases.map(p => `
            <div style="font-size:.72rem;color:var(--text-secondary);display:flex;align-items:center;gap:6px;padding:3px 0;">
              <span class="badge ${p.phase === 1 ? 'badge-purple' : 'badge-gray'}" style="font-size:.62rem;">Phase ${p.phase}</span>
              <span><strong>${esc(p.id)}:</strong> ${esc(p.task)}</span>
              <span class="badge badge-cyan" style="font-size:.6rem;margin-left:auto;">lane: ${esc(p.lane || 'sequential')}</span>
            </div>
          `).join('');

          planHtml = `
            <div style="margin-top:8px;padding-top:8px;border-top:1px dashed rgba(236,72,153,.3);">
              <div style="font-size:.7rem;font-weight:700;color:var(--text-muted);margin-bottom:4px;">DECOMPOSED TASK EXECUTION PLAN (${plan.phases.length} subtasks):</div>
              ${phasesList}
            </div>`;
        }

        steeringSubtaskView.innerHTML = `
          <div style="padding:10px 12px;background:rgba(236,72,153,.12);border:1px solid rgba(236,72,153,.35);border-radius:6px;font-size:.76rem;color:#f472b6;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="badge" style="background:#ec4899;color:#fff;font-weight:700;font-size:.68rem;">AGENTIC PLANNER ACTIVE</span>
              <span>Active Subtask: <code>${esc(subId)}</code> &bull; <strong>${esc(subTitle)}</strong></span>
            </div>
            ${planHtml}
          </div>`;
      }
    } else {
      if (steeringSubtaskView) steeringSubtaskView.style.display = 'none';
    }

    renderSteeringInspectContent();

  } catch (err) {
    if (steeringBloatStatus) steeringBloatStatus.textContent = 'ERROR ⚠️';
  } finally {
    if (btnRunSteeringEval) {
      btnRunSteeringEval.disabled = false;
      btnRunSteeringEval.innerHTML = 'Inspect Live Ingestion & Telemetry';
    }
  }
}

btnRunSteeringEval?.addEventListener('click', runSteeringEvaluation);
steeringQueryInput?.addEventListener('input', debouncedSteeringEvaluation);
steeringKeywordsInput?.addEventListener('input', debouncedSteeringEvaluation);
steeringWorkspaceInput?.addEventListener('input', debouncedSteeringEvaluation);
steeringAgenticToggle?.addEventListener('change', runSteeringEvaluation);

// Initial run on script load
runSteeringEvaluation();
setTimeout(runSteeringEvaluation, 500);

