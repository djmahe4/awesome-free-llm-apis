'use strict';
// ─── CHAT ENGINE ────────────────────────────────────────────────

const chatLog       = document.getElementById('pg-chat-log');
const chatEmpty     = document.getElementById('pg-chat-empty');
const chatLabel     = document.getElementById('pg-chat-session-label');
const chatBadge     = document.getElementById('pg-chat-mode-badge');
const pgRunBtn      = document.getElementById('pg-run-btn');
const pgClearBtn    = document.getElementById('pg-clear-btn');
const pgStatus      = document.getElementById('pg-status');
const pgLatency     = document.getElementById('pg-latency');
const pgWorkspace   = document.getElementById('pg-workspace');
const pgAgenticToggle = document.getElementById('pg-agentic-toggle');
const convList      = document.getElementById('pg-conv-list');
const convSearch    = document.getElementById('pg-conv-search');

// Delegated click handling for buttons rendered into chat bubbles (Copy / Copy Raw).
// The dashboard's CSP sets `script-src-attr: 'none'` (Helmet default, never overridden),
// which silently blocks inline onclick="..." attributes — these buttons used to rely on
// that and simply did nothing when clicked. Delegating from the container (loaded via the
// external, CSP-allowed /app.js) works correctly.
chatLog?.addEventListener('click', (e) => {
  const copyRaw = e.target.closest('.copy-raw-btn');
  if (copyRaw) {
    navigator.clipboard.writeText(copyRaw.dataset.v || '');
    copyRaw.textContent = 'Copied!';
    return;
  }
  const copyChat = e.target.closest('.chat-copy-btn');
  if (copyChat) {
    const text = copyChat.closest('.chat-msg')?.querySelector('.chat-bubble')?.innerText || '';
    navigator.clipboard.writeText(text);
    copyChat.textContent = 'Copied!';
    setTimeout(() => { copyChat.textContent = 'Copy'; }, 1500);
  }
});

// In-memory cache of current conversation (avoids re-fetching for every append)
let chatHistory = [];
let activeSessionId = '__no_ws__';

// ─── FILE ATTACHMENTS ───────────────────────────────────────────
const pgAttachBtn   = document.getElementById('pg-attach-btn');
const pgFileInput   = document.getElementById('pg-file-input');
const pgAttachments = document.getElementById('pg-attachments');

let attachments = []; // { id, kind, fileUri, relativePath, filename, page, targetFieldId }
let attachIdSeq = 0;

function getPrimaryTextFieldId(tool) {
  const f = tool?.fields?.find(f => f.type === 'textarea');
  return f ? f.id : null;
}

function insertTokenIntoField(fieldId, token) {
  const el = document.getElementById(`pg-field-${fieldId}`);
  if (!el) return;
  const sep = el.value && !el.value.endsWith('\n') && !el.value.endsWith(' ') ? ' ' : '';
  el.value = `${el.value}${sep}${token}`;
}

function replaceTokenInField(fieldId, oldToken, newToken) {
  const el = document.getElementById(`pg-field-${fieldId}`);
  if (!el) return;
  el.value = el.value.replace(oldToken, newToken);
}

function removeTokenFromField(fieldId, token) {
  const el = document.getElementById(`pg-field-${fieldId}`);
  if (!el) return;
  el.value = el.value.replace(token, '').replace(/\s{2,}/g, ' ').trim();
}

function renderAttachments() {
  pgAttachments.innerHTML = attachments.map(a => `
    <span class="attach-chip" data-attach-id="${a.id}">
      📎 ${esc(a.filename)}
      ${a.kind === 'pdf' ? `<input type="number" min="1" value="${a.page}" class="attach-page-input" data-attach-id="${a.id}" title="PDF page number">` : ''}
      <span class="attach-remove" data-attach-id="${a.id}">×</span>
    </span>
  `).join('');

  pgAttachments.querySelectorAll('.attach-remove').forEach(btn => {
    btn.addEventListener('click', () => removeAttachment(btn.dataset.attachId));
  });
  pgAttachments.querySelectorAll('.attach-page-input').forEach(inp => {
    inp.addEventListener('change', () => updateAttachmentPage(inp.dataset.attachId, inp.value));
  });
}

function updateAttachmentPage(id, newPageStr) {
  const a = attachments.find(a => a.id === id);
  if (!a) return;
  const newPage = Math.max(1, parseInt(newPageStr, 10) || 1);
  const oldToken = a.token;
  a.token = a.token.replace(/:\d+$/, `:${newPage}`);
  a.page = newPage;
  if (a.targetFieldId) replaceTokenInField(a.targetFieldId, oldToken, a.token);
}

function removeAttachment(id) {
  const a = attachments.find(a => a.id === id);
  if (!a) return;
  if (a.targetFieldId) {
    if (a.isDirectFieldValue) {
      const el = document.getElementById(`pg-field-${a.targetFieldId}`);
      if (el && el.value === a.token) el.value = '';
    } else {
      removeTokenFromField(a.targetFieldId, a.token);
    }
  }
  attachments = attachments.filter(x => x.id !== id);
  renderAttachments();
}

async function handleFileSelected(file) {
  if (!file) return;
  const ws = pgWorkspace.value.trim();
  const formData = new FormData();
  formData.append('file', file);
  if (ws) formData.append('workspace_root', ws);

  pgAttachBtn.disabled = true;
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: formData });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Upload failed');

    const id = `att-${++attachIdSeq}`;
    const isVisionTool = activeTool.id === 'vision_tool';

    if (d.kind === 'image' && isVisionTool) {
      // Fill image_path directly — that field already exists on vision_tool
      const el = document.getElementById('pg-field-image_path');
      if (el) el.value = d.fileUri;
      attachments.push({ id, kind: 'image', filename: file.name, token: d.fileUri, targetFieldId: 'image_path', isDirectFieldValue: true });
    } else if (d.kind === 'image') {
      const fieldId = getPrimaryTextFieldId(activeTool);
      if (fieldId) insertTokenIntoField(fieldId, d.fileUri);
      attachments.push({ id, kind: 'image', filename: file.name, token: d.fileUri, targetFieldId: fieldId });
    } else {
      // PDF — embed as pdf://<relativePath>:<page>, page editable via the chip
      const ref = d.relativePath || d.absPath.replace(/\\/g, '/');
      const token = `pdf://${ref}:1`;
      const fieldId = getPrimaryTextFieldId(activeTool);
      if (fieldId) insertTokenIntoField(fieldId, token);
      attachments.push({ id, kind: 'pdf', filename: file.name, token, page: 1, targetFieldId: fieldId });
    }
    renderAttachments();
  } catch (err) {
    alert(`Upload failed: ${err.message}`);
  } finally {
    pgAttachBtn.disabled = false;
    pgFileInput.value = '';
  }
}

pgAttachBtn?.addEventListener('click', () => pgFileInput.click());
pgFileInput?.addEventListener('change', () => handleFileSelected(pgFileInput.files[0]));

// ─── Session ID resolution (server-side, so all instances agree) ──
async function resolveSessionId(ws) {
  if (!ws) return '__no_ws__';
  try {
    const r = await fetch('/api/chat-log/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws })
    });
    if (!r.ok) return '__no_ws__';
    const { sessionId } = await r.json();
    return sessionId || '__no_ws__';
  } catch { return '__no_ws__'; }
}

// ─── Load history from server ─────────────────────────────────────
async function loadChatHistory(sid) {
  try {
    const r = await fetch(`/api/chat-log/${encodeURIComponent(sid)}`);
    if (!r.ok) return [];
    const { log, workspace } = await r.json();

    if (workspace && workspace !== 'unknown') {
      pgWorkspace.value = workspace;
      localStorage.setItem('mcp-workspace', workspace);
    } else {
      pgWorkspace.value = '';
      localStorage.setItem('mcp-workspace', '');
    }
    updateWorkspaceUI();

    return Array.isArray(log) ? log : [];
  } catch { return []; }
}

// ─── Append one turn to server (fire-and-forget, non-blocking) ───
function saveTurn(sid, turn) {
  fetch(`/api/chat-log/${encodeURIComponent(sid)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(turn)
  }).catch(() => {}); // silent — dashboard still works if server is briefly unavailable
}

// ─── Clear server log + rebuild UI ────────────────────────────────
async function clearServerLog(sid) {
  try {
    await fetch(`/api/chat-log/${encodeURIComponent(sid)}`, { method: 'DELETE' });
  } catch {}
}

// ─── Rebuild DOM from history array ───────────────────────────────
function rebuildChatLog() {
  chatLog.innerHTML = '';
  if (!chatHistory.length) {
    chatLog.appendChild(chatEmpty);
    chatEmpty.style.display = 'flex';
    return;
  }
  chatEmpty.style.display = 'none';
  chatHistory.forEach(msg => appendBubbleFromRecord(msg));
  scrollChatBottom();
}

function scrollChatBottom() {
  requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; });
}

function appendBubbleFromRecord(msg) {
  const item = (msg && msg.payload && typeof msg.payload === 'object')
    ? { ts: msg.timestamp || msg.payload.ts, sessionId: msg.sessionId, ...msg.payload }
    : msg;

  if (!item || typeof item !== 'object') return;

  if (item.role === 'user') {
    addUserBubbleEl(item.content, item.tool, item.ts);
  } else if (item.role === 'assistant') {
    const el = addSpinnerBubble(item.tool);
    renderMarkdown(item.content).then(html => {
      if (!el.isConnected) return;
      replaceSpinnerWithResponse(el, html, item.latencyMs, item.tool, item.ts, false, item.model, item.provider, item.contextInjected);
    });
  } else if (item.role === 'error') {
    addErrorBubbleEl(item.content, item.tool, item.ts);
  } else if (item.role === 'subtask_start') {
    addSubtaskStartBubble(item.content, item.ts);
  } else if (item.role === 'subtask_response') {
    addSubtaskResponseBubble(item.content, item.output, item.ts, item.contextInjected, item.model, item.provider);
  } else if (item.role === 'tool_call') {
    addToolCallBubble(item.tool, item.args, item.result, item.ts, item.latencyMs, item.isError);
  }
}

function addSubtaskStartBubble(taskText, ts) {
  chatEmpty.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'chat-spinner-bubble subtask-active-spinner';
  div.innerHTML = `
    <div class="spin-header">
      <div class="spin-dots">
        <span class="spin-dot"></span><span class="spin-dot"></span><span class="spin-dot"></span>
      </div>
      <span>Subagent Executing:</span>
      <span class="spin-tool-tag">${esc(taskText)}</span>
    </div>
    <span class="chat-meta-timestamp">${new Date(ts || Date.now()).toLocaleTimeString()}</span>`;
  chatLog.appendChild(div);
  scrollChatBottom();
  return div;
}

function addSubtaskResponseBubble(taskText, outputText, ts, contextInjected, model, provider) {
  chatEmpty.style.display = 'none';

  // Remove any active spinner for this subtask to keep the flow clean
  const activeSpinners = chatLog.querySelectorAll('.subtask-active-spinner');
  activeSpinners.forEach(s => {
    const tag = s.querySelector('.spin-tool-tag');
    if (tag && tag.textContent === taskText) {
      s.remove();
    }
  });

  const div = document.createElement('div');
  div.className = 'chat-msg assistant subtask-collapse-card';
  div.style.margin = '8px 0 8px 16px';
  div.style.opacity = '0.85';

  const uniqueId = 'subtask-' + Math.random().toString(36).substring(2, 9);
  const outputContainerId = 'subtask-out-' + Math.random().toString(36).substring(2, 9);

  const contextHtml = Array.isArray(contextInjected) && contextInjected.length > 0
    ? `<details style="margin-top:8px; padding-top:8px; border-top:1px dashed rgba(255,255,255,0.04);">
        <summary style="cursor:pointer; font-size:.7rem; color:var(--accent-cyan); display:flex; align-items:center; gap:4px; outline:none; list-style:none;">
          <span>📂</span> <span>View Injected Context (${contextInjected.length})</span>
        </summary>
        <ul style="margin-top:6px; padding-left:16px; font-size:.7rem; color:var(--text-muted); display:flex; flex-direction:column; gap:4px; list-style-type:circle;">
          ${contextInjected.map(renderContextEntry).join('')}
        </ul>
       </details>`
    : '';

  div.innerHTML = `
    <div class="chat-bubble" style="padding:10px 14px; background:rgba(255,255,255,0.02); border-left: 3px solid var(--accent-purple);">
      <details id="${uniqueId}">
        <summary style="cursor:pointer; font-size:.78rem; font-weight:600; color:var(--text-secondary); display:flex; justify-content:space-between; align-items:center; outline:none; list-style:none;">
          <span style="display:flex; align-items:center; gap:6px;">
            <span style="color:var(--accent-green)">✓</span>
            <span>Subtask: ${esc(taskText.replace('Completed: ', ''))}</span>
          </span>
          <span style="font-size:.7rem; color:var(--text-muted);">click to view output</span>
        </summary>
        <div id="${outputContainerId}" style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.05); font-size:.75rem; font-family:'JetBrains Mono', monospace; overflow-x:auto; max-height:350px; white-space:pre-wrap; color:var(--text-muted);">
          <pre style="margin:0; font-family:inherit; white-space:pre-wrap;">${esc(outputText || 'No output details recorded.')}</pre>
        </div>
      </details>
      ${contextHtml}
    </div>
    <div class="chat-meta" style="margin-left: 16px;">
      ${modelBadge(model, provider)}<span>Subagent Execution</span>
      <span>${new Date(ts || Date.now()).toLocaleTimeString()}</span>
    </div>`;

  if (outputText) {
    renderMarkdown(outputText).then(html => {
      const container = div.querySelector(`#${outputContainerId}`);
      if (container) {
        container.innerHTML = html;
        container.style.whiteSpace = 'normal';
      }
    }).catch(() => {});
  }

  chatLog.appendChild(div);
  scrollChatBottom();
  return div;
}

/**
 * Renders a collapsed tool-call bubble for retrospect rendering.
 * Follows the same <details>/<summary> pattern as addSubtaskResponseBubble.
 * Called from appendBubbleFromRecord when role === 'tool_call'.
 */
function addToolCallBubble(tool, args, result, ts, latencyMs, isError) {
  chatEmpty.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'chat-msg assistant subtask-collapse-card';
  div.style.margin = '4px 0 4px 16px';
  div.style.opacity = '0.80';

  let parsedArgs = args;
  let parsedResult = result;
  try { if (typeof args === 'string') parsedArgs = JSON.parse(args); } catch {}
  try { if (typeof result === 'string') parsedResult = JSON.parse(result); } catch {}

  // Recover inner content if result was saved as a truncated JSON string
  if (typeof parsedResult === 'string') {
    const trimmed = parsedResult.trim();
    if (trimmed.includes('"text":"') || trimmed.includes('"content":')) {
      const match = trimmed.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)/);
      if (match && match[1]) {
        try {
          parsedResult = { content: [{ type: 'text', text: JSON.parse(`"${match[1]}"`) }] };
        } catch {
          parsedResult = { content: [{ type: 'text', text: match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') }] };
        }
      }
    }
  }

  const resultText = (() => {
    if (parsedResult && typeof parsedResult === 'object') {
      if (Array.isArray(parsedResult.content) && parsedResult.content[0]?.text) {
        return parsedResult.content[0].text;
      }
      if (typeof parsedResult.content === 'string') return parsedResult.content;
      if (typeof parsedResult.response === 'string') return parsedResult.response;
      if (typeof parsedResult.markdown === 'string') return parsedResult.markdown;
      if (typeof parsedResult.patch === 'string') return parsedResult.patch;
      if (typeof parsedResult.patchSummary === 'string') return parsedResult.patchSummary;
    }
    return typeof result === 'string' ? result : '';
  })();

  const resultPreview = (() => {
    let s = resultText || (typeof result === 'string' ? result : JSON.stringify(result ?? ''));
    s = s.replace(/\s+/g, ' ').trim();
    return s.slice(0, 140) + (s.length > 140 ? '…' : '');
  })();

  const borderColor = isError ? 'var(--accent-red, #ef4444)' : 'var(--accent-cyan)';
  const icon = isError ? '⚠️' : '🔧';

  const outputContainerId = `tool-out-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  let resultBodyHtml = '';
  if (parsedResult && typeof parsedResult === 'object' && Array.isArray(parsedResult.patchPlan) && parsedResult.patchPlan.length) {
    resultBodyHtml = parsedResult.patchPlan.map(p => {
      const diffText = p.unifiedDiff || p.diff || (p.replacementSnippet ? `@@ -${p.startLine} +${p.startLine} @@\n${p.replacementSnippet}` : '');
      const diffLines = diffText ? diffText.split('\n') : [];
      return `<div style="margin-bottom:8px; border:1px solid var(--glass-border); border-radius:4px; padding:6px;">
        <div style="font-weight:600; color:var(--text-primary); margin-bottom:4px;">📝 ${esc(p.filePath || p.file || 'file')}</div>
        <pre class="code-block diff-viewer" style="font-family:'JetBrains Mono',monospace; white-space:pre-wrap; overflow-x:auto; max-height:450px; font-size:.72rem; padding:6px; margin:0;"><code>` +
        diffLines.map(l => {
          if (l.startsWith('+')) return `<span style="color:#4ade80">${esc(l)}</span>`;
          if (l.startsWith('-')) return `<span style="color:#f87171">${esc(l)}</span>`;
          if (l.startsWith('@@')) return `<span style="color:#38bdf8">${esc(l)}</span>`;
          return esc(l);
        }).join('\n') + `</code></pre>
      </div>`;
    }).join('');
  } else if (resultText) {
    resultBodyHtml = `<div id="${outputContainerId}" class="tool-call-rendered-md" style="max-height:800px; overflow-y:auto;">` +
      `<pre style="font-family:'JetBrains Mono',monospace; white-space:pre-wrap; overflow-x:auto; font-size:.73rem; margin:0;">${esc(resultText)}</pre>` +
      `</div>`;
    renderMarkdown(resultText).then(mdHtml => {
      const el = div.querySelector(`#${outputContainerId}`);
      if (el) el.innerHTML = mdHtml;
    }).catch(() => {});
  } else {
    resultBodyHtml = `<pre style="font-family:'JetBrains Mono',monospace; white-space:pre-wrap; overflow-x:auto; max-height:800px; font-size:.73rem; margin:0;">${esc(JSON.stringify(parsedResult, null, 2))}</pre>`;
  }

  div.innerHTML = `
    <div class="chat-bubble" style="padding:8px 12px; background:rgba(255,255,255,0.02); border-left:3px solid ${borderColor};">
      <details>
        <summary style="cursor:pointer; font-size:.76rem; font-weight:600; color:var(--text-secondary); display:flex; justify-content:space-between; align-items:center; outline:none; list-style:none;">
          <span style="display:flex; align-items:center; gap:6px;">
            <span>${icon}</span>
            <span style="color:var(--accent-cyan); font-family:'JetBrains Mono',monospace;">${esc(tool || '?')}</span>
            <span style="color:var(--text-muted); font-size:.7rem;">${esc(resultPreview)}</span>
          </span>
          <span style="font-size:.68rem; color:var(--text-muted); white-space:nowrap; margin-left:8px;">${latencyMs != null ? latencyMs + 'ms' : ''} · ${new Date(ts || Date.now()).toLocaleTimeString()}</span>
        </summary>
        <div style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.05); font-size:.73rem;">
          <div style="margin-bottom:6px; color:var(--text-muted);"><strong>Args:</strong><br>
            <pre style="font-family:'JetBrains Mono',monospace; white-space:pre-wrap; overflow-x:auto; max-height:200px; margin:4px 0;">${esc(JSON.stringify(parsedArgs, null, 2))}</pre>
          </div>
          <div style="color:var(--text-muted);"><strong>Output:</strong><br>
            ${resultBodyHtml}
          </div>
        </div>
      </details>
    </div>
    <div class="chat-meta" style="margin-left:16px;">
      <span>Tool Call</span>
      <span>${new Date(ts || Date.now()).toLocaleTimeString()}</span>
    </div>`;

  chatLog.appendChild(div);
  scrollChatBottom();
  return div;
}

function addUserBubbleEl(text, tool, ts) {
  chatEmpty.style.display = 'none';
  const div = document.createElement('div');
  div.className = 'chat-msg user';
  div.innerHTML = `
    <div class="chat-bubble">${esc(text)}</div>
    <div class="chat-meta">
      <span>${esc(tool || activeTool.id)}</span>
      <span>${new Date(ts || Date.now()).toLocaleTimeString()}</span>
    </div>`;
  chatLog.appendChild(div);
  return div;
}

function addErrorBubbleEl(text, tool, ts) {
  const div = document.createElement('div');
  div.className = 'chat-msg error';
  div.innerHTML = `
    <div class="chat-bubble">✗ ${esc(text)}</div>
    <div class="chat-meta"><span>${esc(tool || '')}</span><span>${new Date(ts || Date.now()).toLocaleTimeString()}</span></div>`;
  chatLog.appendChild(div);
  return div;
}

function addSpinnerBubble(tool) {
  chatEmpty.style.display = 'none';
  const isAgentic = !!pgWorkspace.value.trim();
  const div = document.createElement('div');
  div.className = 'chat-spinner-bubble';
  div.innerHTML = `
    <div class="spin-header">
      <div class="spin-dots">
        <span class="spin-dot"></span><span class="spin-dot"></span><span class="spin-dot"></span>
      </div>
      <span>${isAgentic ? 'Running agentic subtasks…' : 'Executing…'}</span>
      <span class="spin-tool-tag">${esc(tool)}</span>
    </div>
    ${isAgentic ? '<span class="chat-meta-timestamp">Decomposing into subtasks — this may take a moment</span>' : ''}`;
  chatLog.appendChild(div);
  scrollChatBottom();
  return div;
}

function replaceSpinnerWithResponse(spinnerEl, html, latencyMs, tool, ts, save = true, model, provider, contextInjected) {
  const div = document.createElement('div');
  div.className = 'chat-msg assistant';
  const latBadge = latencyMs != null
    ? `<span class="latency-badge${latencyMs > 3000 ? ' slow' : ''}" style="display:inline-flex;">${latencyMs}ms</span>`
    : '';
  // Same <details>/<summary> pattern as addSubtaskResponseBubble's "View Injected Context" —
  // QUESTION/CONFUSED-routed turns (which never went through subtask decomposition) can also
  // have resolved references / memory / wiki context injected, and it shouldn't be a blind spot.
  const contextHtml = Array.isArray(contextInjected) && contextInjected.length > 0
    ? `<details style="margin-top:8px; padding-top:8px; border-top:1px dashed rgba(255,255,255,0.06);">
        <summary style="cursor:pointer; font-size:.7rem; color:var(--accent-cyan); display:flex; align-items:center; gap:4px; outline:none; list-style:none;">
          <span>📂</span> <span>View Injected Context (${contextInjected.length})</span>
        </summary>
        <ul style="margin-top:6px; padding-left:16px; font-size:.7rem; color:var(--text-muted); display:flex; flex-direction:column; gap:4px; list-style-type:circle;">
          ${contextInjected.map(renderContextEntry).join('')}
        </ul>
       </details>`
    : '';
  div.innerHTML = `
    <div class="chat-bubble">${html}${contextHtml}</div>
    <div class="chat-meta">${latBadge}${modelBadge(model, provider)}<span>${esc(tool)}</span><span>${new Date(ts || Date.now()).toLocaleTimeString()}</span>
      <button class="chat-copy-btn">Copy</button>
    </div>`;
  spinnerEl.replaceWith(div);
  if (save) scrollChatBottom();
}

// ─── Update workspace header badges ──────────────────────────────
function updateWorkspaceUI() {
  const ws = pgWorkspace.value.trim();
  const agentic = !!pgAgenticToggle?.checked;
  if (ws) {
    chatLabel.textContent = ws.split(/[\\\/]/).pop() || ws;
    if (agentic) {
      chatBadge.textContent = '🧠 Agentic';
      chatBadge.className = 'badge badge-purple';
    } else {
      chatBadge.textContent = '📂 Grounded';
      chatBadge.className = 'badge badge-cyan';
    }
  } else {
    chatLabel.textContent = 'No workspace — one-shot mode';
    chatBadge.textContent = '⚡ One-shot';
    chatBadge.className = 'badge badge-amber';
  }
}
pgAgenticToggle?.addEventListener('change', updateWorkspaceUI);

// ─── Conversation list panel ──────────────────────────────────────
let _convSearchTimer = null;
const pgNewConvBtn = document.getElementById('pg-new-conv-btn');

async function refreshConvList(filter = '') {
  if (!convList) return;
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) return;
    const { sessions } = await r.json();
    const list = Array.isArray(sessions) ? sessions : [];
    const q = filter.toLowerCase().trim();
    const filtered = q ? list.filter(s =>
      s.id.toLowerCase().includes(q) ||
      (s.name && s.name.toLowerCase().includes(q)) ||
      (s.workspace && s.workspace.toLowerCase().includes(q))
    ) : list;
    renderConvList(filtered);
  } catch {}
}

function renderConvList(sessions) {
  if (!convList) return;
  if (!sessions.length) {
    convList.innerHTML = '<div class="conv-empty">No conversations yet</div>';
    return;
  }
  convList.innerHTML = sessions.map(s => {
    const isActive = s.id === activeSessionId;
    const displayName = s.name || (s.id === '__no_ws__' ? '⚡ One-shot [none]' : s.id);
    const sub = s.msgCount ? `${s.msgCount} msgs` : 'empty';
    const ago = s.lastTs ? timeAgo(s.lastTs) : '';
    return `<div class="conv-item${isActive ? ' active' : ''}" data-sid="${esc(s.id)}" title="${esc(s.id)} — ${esc(displayName)}">
      <div class="conv-item-label" style="font-weight:500; font-size:.78rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(displayName)}</div>
      <div class="conv-item-meta" style="font-size:.68rem; opacity:.75;"><span>${sub}</span><span>${ago}</span></div>
    </div>`;
  }).join('');

  convList.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', async () => {
      const sid = el.dataset.sid;
      if (sid === activeSessionId) return;

      activeSessionId = sid;
      if (sid === '__no_ws__') {
        pgWorkspace.value = '';
        localStorage.setItem('mcp-workspace', '');
        updateWorkspaceUI();
      }

      chatHistory = await loadChatHistory(sid);
      rebuildChatLog();
      refreshConvList(convSearch?.value || '');
    });
  });
}

// ─── + New Conversation Handler ──────────────────────────────────
pgNewConvBtn?.addEventListener('click', async () => {
  const ws = pgWorkspace.value.trim();
  try {
    const r = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws })
    });
    if (r.ok) {
      const d = await r.json();
      activeSessionId = d.sessionId;
      chatHistory = [];
      rebuildChatLog();
      refreshConvList();
      pgStatus.textContent = '✓ New chat ready';
      pgStatus.style.color = 'var(--accent-green)';
      setTimeout(() => { pgStatus.textContent = ''; }, 2000);
    }
  } catch (err) {
    console.error('Failed to create new session:', err);
  }
});

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return `${Math.floor(diff/86400000)}d ago`;
}

if (convSearch) {
  convSearch.addEventListener('input', () => {
    clearTimeout(_convSearchTimer);
    _convSearchTimer = setTimeout(() => refreshConvList(convSearch.value), 200);
  });
}

// ─── Workspace persistence + session switch ───────────────────────
pgWorkspace.value = localStorage.getItem('mcp-workspace') || '';
updateWorkspaceUI();

// Switch session when workspace changes
pgWorkspace.addEventListener('change', async () => {
  const ws = pgWorkspace.value.trim();
  localStorage.setItem('mcp-workspace', ws);
  updateWorkspaceUI();
  activeSessionId = await resolveSessionId(ws);
  chatHistory = await loadChatHistory(activeSessionId);
  rebuildChatLog();
  refreshConvList();
});

// Initial load
(async () => {
  activeSessionId = await resolveSessionId(pgWorkspace.value.trim());
  chatHistory = await loadChatHistory(activeSessionId);
  rebuildChatLog();
  refreshConvList();
})();

// ─── Folder picker ────────────────────────────────────────────────
document.getElementById('pg-folder-btn').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    alert('Your browser does not support the Folder Picker API. Please type the path manually.');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const current = pgWorkspace.value.trim();
    if (!current) {
      pgWorkspace.value = handle.name;
    } else {
      const sep = current.includes('\\') ? '\\' : '/';
      const parts = current.split(sep);
      parts[parts.length - 1] = handle.name;
      pgWorkspace.value = parts.join(sep);
    }
    pgWorkspace.dispatchEvent(new Event('change'));
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[FolderPicker]', e);
  }
});

// ─── Params panel collapse ────────────────────────────────────────
const pgParamsToggle  = document.getElementById('pg-params-toggle');
const pgParamsBody    = document.getElementById('pg-params-body');
const pgParamsChevron = document.getElementById('pg-params-chevron');
let paramsOpen = true;

pgParamsToggle.addEventListener('click', () => {
  paramsOpen = !paramsOpen;
  pgParamsBody.style.display = paramsOpen ? '' : 'none';
  pgParamsChevron.style.transform = paramsOpen ? '' : 'rotate(-90deg)';
});

// Background sync for external MCP client tool invocations
let isRunActive = false;
setInterval(async () => {
  if (isRunActive || document.hidden || !activeSessionId || activeSessionId === '__no_ws__') return;
  try {
    const log = await loadChatHistory(activeSessionId);
    if (log.length !== chatHistory.length) {
      chatHistory = log;
      rebuildChatLog();
      refreshConvList(convSearch?.value || '');
    }
  } catch {}
}, 2500);

// ─── Run / Send ───────────────────────────────────────────────────
pgRunBtn.addEventListener('click', async () => {
  await ensureModels();
  const params = collectParams(activeTool);

  const ws = pgWorkspace.value.trim();
  if (ws) {
    params.workspace_root = ws;
    params.sessionId = activeSessionId;
    if (activeTool.id === 'use_free_llm' && pgAgenticToggle?.checked) {
      params.agentic = true;
    }
  } else {
    // Unify multi-tool retrospective session tracking even in one-shot / standalone sessions
    params.sessionId = activeSessionId;
  }

  function extractHumanReadableUserText(toolId, p) {
    if (p.prompt) return p.prompt;
    if (p.goal) return `🎯 ${p.goal}`;
    if (p.instruction) return `🩹 ${p.instruction}`;
    if (p.input) return p.input;
    if (p.query) return `🔍 ${p.query}`;
    if (p.userInstructions) return `🌐 ${p.userInstructions}${p.url ? ` (${p.url})` : ''}`;
    if (p.url) return `🌐 [${p.action || 'browse'}] ${p.url}`;
    if (p.observation) return `🛡️ [Observation] ${p.observation}`;
    if (p.action) return `⚡ Action: ${p.action}${p.toolName ? ` (${p.toolName})` : ''}${p.sessionId ? ` [${p.sessionId}]` : ''}`;
    return `[${activeTool.label}] ${JSON.stringify(p).slice(0, 120)}`;
  }

  const userText = extractHumanReadableUserText(activeTool.id, params);
  const ts = Date.now();
  const userTurn = { role: 'user', tool: activeTool.id, content: userText, ts, workspaceRoot: ws || undefined };

  chatHistory.push(userTurn);
  saveTurn(activeSessionId, userTurn);
  addUserBubbleEl(userText, activeTool.id, ts);

  let spinnerEl = addSpinnerBubble(activeTool.id);
  let requestDone = false;
  isRunActive = true;

  pgRunBtn.disabled = true;
  pgRunBtn.innerHTML = '<span class="spinner"></span>';
  pgStatus.textContent = '';
  pgLatency.style.display = 'none';

  let pollInterval = setInterval(async () => {
    try {
      const log = await loadChatHistory(activeSessionId);
      // Only rebuild if there's new content to avoid layout jumps
      if (log.length !== chatHistory.length) {
        chatHistory = log;
        rebuildChatLog();
        if (!requestDone) {
          spinnerEl = addSpinnerBubble(activeTool.id);
        }
      }
    } catch {}
  }, 800);

  try {
    const r    = await fetch('/api/tool', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tool: activeTool.id, params }) });
    const data = await r.json();
    const latencyMs = data.latencyMs ?? null;
    const replyTs   = Date.now();

    if (data.ok === false || !r.ok) {
      const errMsg = data.error || 'Unknown error';
      const errTurn = { role: 'error', tool: activeTool.id, content: errMsg, ts: replyTs, workspaceRoot: ws || undefined };
      chatHistory.push(errTurn);
      saveTurn(activeSessionId, errTurn);
      spinnerEl.replaceWith(addErrorBubbleEl(errMsg, activeTool.id, replyTs));
      pgStatus.textContent = '✗ Failed'; pgStatus.style.color = 'var(--accent-red)';
    } else {
      const html    = await renderResponse(data);
      const rawText = (data.result ?? data);
      const nestedText = rawText?.content ?? rawText?.response;
      const content = typeof rawText === 'string' ? rawText
        : (typeof nestedText === 'string' ? nestedText : JSON.stringify(rawText, null, 2));
      const respModel = data.result?.model;
      const respProvider = data.result?.provider;
      const assistantTurn = { role: 'assistant', tool: activeTool.id, content, latencyMs, ts: replyTs, model: respModel, provider: respProvider, workspaceRoot: ws || undefined };
      chatHistory.push(assistantTurn);
      saveTurn(activeSessionId, assistantTurn);
      replaceSpinnerWithResponse(spinnerEl, html, latencyMs, activeTool.id, replyTs, true, respModel, respProvider);
      if (latencyMs != null) {
        pgLatency.textContent = `${latencyMs}ms`;
        pgLatency.className = `latency-badge${latencyMs > 3000 ? ' slow' : ''}`;
        pgLatency.style.display = 'inline-flex';
      }
      pgStatus.textContent = '✓ Success'; pgStatus.style.color = 'var(--accent-green)';
    }
  } catch (err) {
    const errMsg = `Network error: ${err.message}`;
    const errTurn = { role: 'error', tool: activeTool.id, content: errMsg, ts: Date.now(), workspaceRoot: ws || undefined };
    chatHistory.push(errTurn);
    saveTurn(activeSessionId, errTurn);
    spinnerEl.replaceWith(addErrorBubbleEl(errMsg, activeTool.id, Date.now()));
    pgStatus.textContent = '✗ Error'; pgStatus.style.color = 'var(--accent-red)';
  } finally {
    requestDone = true;
    isRunActive = false;
    clearInterval(pollInterval);
    // Do one final sync to ensure everything is matched up
    try {
      chatHistory = await loadChatHistory(activeSessionId);
      rebuildChatLog();
    } catch {}
    pgRunBtn.disabled = false;
    pgRunBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send`;
    refreshConvList(); // update message count and title in sidebar
    attachments = [];
    renderAttachments();
  }
});

// Clear conversation
pgClearBtn.addEventListener('click', async () => {
  await clearServerLog(activeSessionId);
  chatHistory = [];
  chatLog.innerHTML = '';
  chatLog.appendChild(chatEmpty);
  chatEmpty.style.display = 'flex';
  pgStatus.textContent = '';
  pgLatency.style.display = 'none';
  attachments = [];
  renderAttachments();
  refreshConvList();
});

// Render initial form
renderToolForm(activeTool);
