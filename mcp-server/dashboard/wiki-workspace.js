(function () {
  'use strict';

  const SAVE_DEBOUNCE_MS = 900;
  const SEARCH_INDEX_DEBOUNCE_MS = 250;
  const SEARCH_MAX_RESULTS = 80;

  function toIsoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  function slugId(text) {
    const base = String(text || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return `${base || 'item'}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function parseTimeToSeconds(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const parts = s.split(':').map(v => Number(v));
    if (parts.some(Number.isNaN)) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  class WikiWorkspaceController {
    constructor(deps) {
      this.esc = deps.esc;
      this.renderMarkdown = deps.renderMarkdown;
      this.initialized = false;
      this.currentPage = null;
      this.wikiInitialized = false;
      this.wikiActiveTitle = null;
      this.pendingHighlight = null;
      this.saveTimer = null;
      this.searchDebounce = null;
      this.suspendEditorEvents = false;
      this.saveState = 'idle';
      this.lineIndex = [];
      this.pagesCache = [];
      this.templateConfig = this.defaultTemplateConfig();
      this.llmDraft = null;
    }

    defaultTemplateConfig() {
      return {
        daily: {
          sections: [
            { id: 'today', title: 'Today', enabled: true },
            { id: 'work', title: 'Work', enabled: true },
            { id: 'learning', title: 'Learning', enabled: true },
            { id: 'decisions', title: 'Decisions', enabled: true },
            { id: 'problems', title: 'Problems & Blockers', enabled: true },
            { id: 'notes', title: 'Notes', enabled: true },
            { id: 'wins', title: 'Wins', enabled: true },
            { id: 'personal', title: 'Personal', enabled: false },
            { id: 'tomorrow', title: 'Tomorrow', enabled: true },
            { id: 'checklist', title: 'Checklist', enabled: true }
          ],
          checklist: []
        },
        monthly: {
          sections: [
            { id: 'direction', title: 'Direction', enabled: true },
            { id: 'professional', title: 'Professional', enabled: true },
            { id: 'learning', title: 'Learning', enabled: true },
            { id: 'personal', title: 'Personal', enabled: false },
            { id: 'decisions', title: 'Key Decisions', enabled: true },
            { id: 'events', title: 'Significant Events', enabled: true },
            { id: 'friction', title: 'Recurring Problems / Friction', enabled: true },
            { id: 'progress', title: 'Progress', enabled: true },
            { id: 'lessons', title: 'Lessons', enabled: true },
            { id: 'carry', title: 'Carry Forward', enabled: true },
            { id: 'checklist', title: 'Monthly Checklist', enabled: true }
          ],
          checklist: []
        }
      };
    }

    storageKey() {
      const ws = this.workspaceValue() || '__global__';
      return `mcp-journal-template::${ws}`;
    }

    workspaceValue() {
      return this.el.wikiWorkspaceInput?.value.trim() || '';
    }

    loadTemplateConfig() {
      try {
        const raw = localStorage.getItem(this.storageKey());
        if (!raw) {
          this.templateConfig = this.defaultTemplateConfig();
          return;
        }
        const parsed = JSON.parse(raw);
        const fallback = this.defaultTemplateConfig();
        this.templateConfig = {
          daily: {
            sections: Array.isArray(parsed?.daily?.sections) ? parsed.daily.sections : fallback.daily.sections,
            checklist: Array.isArray(parsed?.daily?.checklist) ? parsed.daily.checklist : fallback.daily.checklist
          },
          monthly: {
            sections: Array.isArray(parsed?.monthly?.sections) ? parsed.monthly.sections : fallback.monthly.sections,
            checklist: Array.isArray(parsed?.monthly?.checklist) ? parsed.monthly.checklist : fallback.monthly.checklist
          }
        };
      } catch {
        this.templateConfig = this.defaultTemplateConfig();
      }
    }

    persistTemplateConfig() {
      try {
        localStorage.setItem(this.storageKey(), JSON.stringify(this.templateConfig));
      } catch {}
    }

    bindElements() {
      this.el = {
        wikiWorkspaceInput: document.getElementById('wiki-workspace-input'),
        wikiLoadBtn: document.getElementById('wiki-load-btn'),
        wikiPageList: document.getElementById('wiki-page-list'),
        wikiPageTitle: document.getElementById('wiki-page-title'),
        wikiPageBody: document.getElementById('wiki-page-body'),
        wikiRelated: document.getElementById('wiki-related'),
        wikiSearchInput: document.getElementById('wiki-search-input'),
        wikiSearchBtn: document.getElementById('wiki-search-btn'),
        wikiSearchResults: document.getElementById('wiki-search-results'),
        wikiEditor: document.getElementById('wiki-editor'),
        wikiSaveBtn: document.getElementById('wiki-save-btn'),
        wikiSaveStatus: document.getElementById('wiki-save-status'),
        wikiNewPageBtn: document.getElementById('wiki-new-page-btn'),
        wikiReferenceViewer: document.getElementById('wiki-reference-viewer'),
        wikiAskLlmBtn: document.getElementById('wiki-ask-llm-btn'),
        wikiLlmOutput: document.getElementById('wiki-llm-output'),
        wikiLlmInsertBtn: document.getElementById('wiki-llm-insert-btn'),
        wikiLlmCopyBtn: document.getElementById('wiki-llm-copy-btn'),
        wikiLlmDiscardBtn: document.getElementById('wiki-llm-discard-btn'),
        journalDateInput: document.getElementById('journal-daily-date'),
        journalOpenDailyBtn: document.getElementById('journal-open-daily-btn'),
        journalOpenMonthlyBtn: document.getElementById('journal-open-monthly-btn'),
        journalChecklist: document.getElementById('journal-checklist'),
        journalChecklistInput: document.getElementById('journal-checklist-input'),
        journalChecklistAddBtn: document.getElementById('journal-checklist-add-btn'),
        templatePeriod: document.getElementById('journal-template-period'),
        templateSectionSelect: document.getElementById('journal-template-section-select'),
        templateSectionName: document.getElementById('journal-template-section-name'),
        templateSectionAddBtn: document.getElementById('template-section-add-btn'),
        templateSectionRemoveBtn: document.getElementById('template-section-remove-btn'),
        templateSectionRenameBtn: document.getElementById('template-section-rename-btn'),
        templateSectionUpBtn: document.getElementById('template-section-up-btn'),
        templateSectionDownBtn: document.getElementById('template-section-down-btn'),
        templateSectionToggleBtn: document.getElementById('template-section-toggle-btn'),
        templateChecklistSelect: document.getElementById('journal-template-checklist-select'),
        templateChecklistText: document.getElementById('journal-template-checklist-text'),
        templateChecklistAddBtn: document.getElementById('template-checklist-add-btn'),
        templateChecklistRemoveBtn: document.getElementById('template-checklist-remove-btn'),
        templateChecklistRenameBtn: document.getElementById('template-checklist-rename-btn'),
        templateSaveBtn: document.getElementById('journal-template-save-btn'),
        templateResetBtn: document.getElementById('journal-template-reset-btn')
      };
    }

    init() {
      if (this.initialized) return;
      this.initialized = true;
      this.bindElements();
      this.bindEvents();
      if (this.el.journalDateInput) {
        this.el.journalDateInput.value = toIsoDate(new Date());
      }
    }

    initTab() {
      this.init();
      if (!this.wikiInitialized) {
        this.wikiInitialized = true;
        const savedWs = localStorage.getItem('mcp-workspace');
        if (savedWs && this.el.wikiWorkspaceInput) {
          this.el.wikiWorkspaceInput.value = savedWs;
        }
        this.loadTemplateConfig();
        this.renderTemplateEditor();
        this.loadWikiList();
      }
    }

    bindEvents() {
      this.el.wikiLoadBtn?.addEventListener('click', () => this.loadWikiList());
      this.el.wikiWorkspaceInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.loadWikiList();
      });
      this.el.wikiWorkspaceInput?.addEventListener('change', () => {
        this.loadTemplateConfig();
        this.renderTemplateEditor();
      });

      this.el.wikiSearchBtn?.addEventListener('click', () => this.runLineSearch());
      this.el.wikiSearchInput?.addEventListener('input', () => {
        clearTimeout(this.searchDebounce);
        this.searchDebounce = setTimeout(() => this.runLineSearch(), SEARCH_INDEX_DEBOUNCE_MS);
      });

      this.el.wikiEditor?.addEventListener('input', () => {
        if (this.suspendEditorEvents) return;
        this.markSaving('pending');
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveCurrentPage(), SAVE_DEBOUNCE_MS);
      });

      this.el.wikiSaveBtn?.addEventListener('click', () => this.saveCurrentPage());
      this.el.wikiNewPageBtn?.addEventListener('click', () => this.createNewPage());

      this.el.wikiPageBody?.addEventListener('click', (e) => {
        const anchor = e.target.closest('[data-wiki-link="1"]');
        if (!anchor) return;
        e.preventDefault();
        this.followParsedLink({
          type: anchor.dataset.linkType || 'page',
          target: anchor.dataset.linkTarget || '',
          locatorRaw: anchor.dataset.linkLocator || ''
        });
      });

      this.el.wikiRelated?.addEventListener('click', (e) => {
        const chip = e.target.closest('.wiki-link-chip');
        if (!chip) return;
        const title = chip.dataset.title;
        if (title) this.loadWikiPage(title);
      });

      this.el.wikiAskLlmBtn?.addEventListener('click', () => this.askLlmFromEditor());
      this.el.wikiLlmInsertBtn?.addEventListener('click', () => this.insertLlmDraft());
      this.el.wikiLlmCopyBtn?.addEventListener('click', () => this.copyLlmDraft());
      this.el.wikiLlmDiscardBtn?.addEventListener('click', () => this.discardLlmDraft());

      this.el.journalOpenDailyBtn?.addEventListener('click', () => this.openDailyJournal());
      this.el.journalOpenMonthlyBtn?.addEventListener('click', () => this.openMonthlyJournal());
      this.el.journalChecklistAddBtn?.addEventListener('click', () => this.addChecklistItemFromInput());
      this.el.journalChecklistInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.addChecklistItemFromInput();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.target.value = '';
        }
      });
      this.el.journalChecklist?.addEventListener('keydown', (e) => this.onChecklistKeydown(e));
      this.el.journalChecklist?.addEventListener('click', (e) => this.onChecklistClick(e));
      this.el.journalChecklist?.addEventListener('change', (e) => this.onChecklistToggle(e));

      this.el.templatePeriod?.addEventListener('change', () => this.renderTemplateEditor());
      this.el.templateSectionSelect?.addEventListener('change', () => this.syncTemplateEditorsFromSelection());
      this.el.templateChecklistSelect?.addEventListener('change', () => this.syncTemplateEditorsFromSelection());

      this.el.templateSectionAddBtn?.addEventListener('click', () => this.templateAddSection());
      this.el.templateSectionRemoveBtn?.addEventListener('click', () => this.templateRemoveSection());
      this.el.templateSectionRenameBtn?.addEventListener('click', () => this.templateRenameSection());
      this.el.templateSectionUpBtn?.addEventListener('click', () => this.templateMoveSection(-1));
      this.el.templateSectionDownBtn?.addEventListener('click', () => this.templateMoveSection(1));
      this.el.templateSectionToggleBtn?.addEventListener('click', () => this.templateToggleSection());

      this.el.templateChecklistAddBtn?.addEventListener('click', () => this.templateAddChecklistItem());
      this.el.templateChecklistRemoveBtn?.addEventListener('click', () => this.templateRemoveChecklistItem());
      this.el.templateChecklistRenameBtn?.addEventListener('click', () => this.templateRenameChecklistItem());

      this.el.templateSaveBtn?.addEventListener('click', () => {
        this.persistTemplateConfig();
        this.setSaveStatus('Template saved for future journal pages.');
      });
      this.el.templateResetBtn?.addEventListener('click', () => {
        this.templateConfig = this.defaultTemplateConfig();
        this.persistTemplateConfig();
        this.renderTemplateEditor();
        this.setSaveStatus('Templates reset to defaults.');
      });
    }

    async callManageMemory(params) {
      const workspace = this.workspaceValue();
      const r = await fetch('/api/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'manage_memory', params: { ...params, workspace_root: workspace } })
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw new Error(d.error || 'Request failed');
      return d.result;
    }

    setSaveStatus(text) {
      if (this.el.wikiSaveStatus) this.el.wikiSaveStatus.textContent = text;
    }

    markSaving(mode) {
      this.saveState = mode;
      if (mode === 'pending') this.setSaveStatus('Saving…');
      if (mode === 'saved') this.setSaveStatus('Saved');
      if (mode === 'failed') this.setSaveStatus('Save failed');
    }

    async loadWikiList() {
      if (!this.el.wikiPageList) return;
      this.el.wikiPageList.innerHTML = '<div class="conv-empty">Loading…</div>';
      try {
        const result = await this.callManageMemory({ action: 'wiki_list' });
        const pages = result.pages || [];
        this.pagesCache = pages;
        if (!pages.length) {
          this.el.wikiPageList.innerHTML = '<div class="conv-empty">No wiki pages yet for this workspace.</div>';
          this.lineIndex = [];
          this.renderSearchResults([]);
          return;
        }
        this.el.wikiPageList.innerHTML = pages.map(p => `
          <div class="wiki-page-item${p.title === this.wikiActiveTitle ? ' active' : ''}" data-title="${this.esc(p.title)}">
            <span>${this.esc(p.title)}</span>
            <span class="badge ${p.tier === 'semantic' ? 'badge-green' : 'badge-amber'}" style="width:fit-content;font-size:.62rem;">${this.esc(p.tier)} · ${Math.round((p.confidence || 0) * 100)}%</span>
          </div>
        `).join('');
        this.el.wikiPageList.querySelectorAll('.wiki-page-item').forEach(el => {
          el.addEventListener('click', () => this.loadWikiPage(el.dataset.title));
        });
        this.rebuildLineIndex();
      } catch (err) {
        this.el.wikiPageList.innerHTML = `<div class="conv-empty">Failed to load: ${this.esc(err.message)}</div>`;
      }
    }

    parseChecklistItems(content) {
      const lines = String(content || '').split('\n');
      return lines
        .map((line, idx) => {
          const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(?:<!--\s*id:([^\s]+)\s*-->\s*)?(.*)$/);
          if (!m) return null;
          const done = m[1].toLowerCase() === 'x';
          const id = m[2] || slugId(m[3]);
          return { id, text: (m[3] || '').trim(), done, lineNumber: idx + 1 };
        })
        .filter(Boolean);
    }

    applyChecklistToContent(content, checklist) {
      const lines = String(content || '').split('\n');
      let checklistHeading = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^##\s+Checklist\s*$/i.test(lines[i].trim()) || /^##\s+Monthly Checklist\s*$/i.test(lines[i].trim())) {
          checklistHeading = i;
          break;
        }
      }
      if (checklistHeading === -1) {
        lines.push('', '## Checklist', '');
        checklistHeading = lines.length - 2;
      }

      let end = checklistHeading + 1;
      while (end < lines.length) {
        const raw = lines[end];
        if (/^##\s+/.test(raw.trim())) break;
        end++;
      }

      const serialized = checklist.map(item => `- [${item.done ? 'x' : ' '}] <!--id:${item.id}--> ${item.text}`);
      const before = lines.slice(0, checklistHeading + 1);
      const after = lines.slice(end);
      return [...before, '', ...serialized, ...after].join('\n').replace(/\n{3,}/g, '\n\n');
    }

    currentChecklistItems() {
      if (!this.currentPage) return [];
      return this.parseChecklistItems(this.currentPage.content || '');
    }

    renderChecklist() {
      if (!this.el.journalChecklist) return;
      const items = this.currentChecklistItems();
      if (!items.length) {
        this.el.journalChecklist.innerHTML = '<div class="conv-empty">No checklist items on this page.</div>';
        return;
      }
      this.el.journalChecklist.innerHTML = items.map((item, idx) => `
        <div class="journal-check-item" data-item-id="${this.esc(item.id)}" tabindex="0">
          <input type="checkbox" data-action="toggle" data-item-id="${this.esc(item.id)}" ${item.done ? 'checked' : ''} aria-label="Toggle checklist item ${this.esc(item.text)}">
          <span class="journal-check-text${item.done ? ' done' : ''}">${this.esc(item.text)}</span>
          <span class="journal-check-meta">${this.esc(item.id)}</span>
          <button class="btn btn-outline btn-xs" data-action="edit" data-item-id="${this.esc(item.id)}">Edit</button>
          <button class="btn btn-outline btn-xs" data-action="delete" data-item-id="${this.esc(item.id)}">Delete</button>
          <button class="btn btn-outline btn-xs" data-action="up" data-item-id="${this.esc(item.id)}" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-outline btn-xs" data-action="down" data-item-id="${this.esc(item.id)}" ${idx === items.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
      `).join('');
    }

    updateChecklist(items) {
      if (!this.currentPage) return;
      this.currentPage.content = this.applyChecklistToContent(this.currentPage.content, items);
      this.setEditorContent(this.currentPage.content);
      this.renderChecklist();
      this.markSaving('pending');
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveCurrentPage(), 300);
    }

    onChecklistToggle(e) {
      const box = e.target.closest('input[type="checkbox"][data-action="toggle"]');
      if (!box) return;
      const id = box.dataset.itemId;
      const items = this.currentChecklistItems();
      const item = items.find(it => it.id === id);
      if (!item) return;
      item.done = !!box.checked;
      this.updateChecklist(items);
    }

    onChecklistClick(e) {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.itemId;
      const items = this.currentChecklistItems();
      const idx = items.findIndex(it => it.id === id);
      if (idx === -1) return;

      if (action === 'delete') {
        items.splice(idx, 1);
        this.updateChecklist(items);
        return;
      }
      if (action === 'edit') {
        const updated = prompt('Edit checklist item', items[idx].text);
        if (updated == null) return;
        const next = updated.trim();
        if (!next) return;
        items[idx].text = next;
        this.updateChecklist(items);
        return;
      }
      if (action === 'up' && idx > 0) {
        const [item] = items.splice(idx, 1);
        items.splice(idx - 1, 0, item);
        this.updateChecklist(items);
        return;
      }
      if (action === 'down' && idx < items.length - 1) {
        const [item] = items.splice(idx, 1);
        items.splice(idx + 1, 0, item);
        this.updateChecklist(items);
      }
    }

    onChecklistKeydown(e) {
      const row = e.target.closest('.journal-check-item');
      if (!row) return;
      const id = row.dataset.itemId;
      if (!id) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        row.blur();
        return;
      }
      if (e.key === ' ' && e.target === row) {
        e.preventDefault();
        const items = this.currentChecklistItems();
        const item = items.find(it => it.id === id);
        if (!item) return;
        item.done = !item.done;
        this.updateChecklist(items);
      }
    }

    addChecklistItemFromInput() {
      if (!this.currentPage) return;
      const text = this.el.journalChecklistInput?.value.trim();
      if (!text) return;
      const items = this.currentChecklistItems();
      items.push({ id: slugId(text), text, done: false });
      this.updateChecklist(items);
      if (this.el.journalChecklistInput) this.el.journalChecklistInput.value = '';
    }

    setEditorContent(content) {
      if (!this.el.wikiEditor) return;
      this.suspendEditorEvents = true;
      this.el.wikiEditor.value = content || '';
      this.suspendEditorEvents = false;
    }

    async loadWikiPage(title, options = {}) {
      this.wikiActiveTitle = title;
      if (this.el.wikiPageTitle) this.el.wikiPageTitle.textContent = title;
      if (this.el.wikiPageBody) this.el.wikiPageBody.innerHTML = '<div class="conv-empty">Loading…</div>';
      if (this.el.wikiRelated) this.el.wikiRelated.innerHTML = '';
      if (this.el.wikiPageList) {
        this.el.wikiPageList.querySelectorAll('.wiki-page-item').forEach(el => {
          el.classList.toggle('active', el.dataset.title === title);
        });
      }

      try {
        const result = await this.callManageMemory({ action: 'wiki_read', title });
        const page = result.page;
        if (!page) {
          if (this.el.wikiPageBody) this.el.wikiPageBody.innerHTML = '<div class="conv-empty">Page not found.</div>';
          return;
        }

        this.currentPage = { ...page };
        this.pendingHighlight = options;

        const html = await this.renderMarkdown(page.content);
        if (this.el.wikiPageBody) this.el.wikiPageBody.innerHTML = html;
        this.setEditorContent(page.content);
        this.markSaving('saved');
        this.renderChecklist();

        if (page.links && page.links.length && this.el.wikiRelated) {
          this.el.wikiRelated.innerHTML = page.links.map(l => `<span class="wiki-link-chip" data-title="${this.esc(l)}">${this.esc(l)}</span>`).join('');
        }

        this.renderReferenceViewer();
        this.applyPendingHighlight();
      } catch (err) {
        if (this.el.wikiPageBody) this.el.wikiPageBody.innerHTML = `<div class="conv-empty">Failed to load page: ${this.esc(err.message)}</div>`;
      }
    }

    async saveCurrentPage() {
      if (!this.currentPage || !this.el.wikiEditor) return;
      const title = this.currentPage.title;
      const content = this.el.wikiEditor.value;
      try {
        this.markSaving('pending');
        await this.callManageMemory({
          action: 'wiki_write',
          title,
          content,
          tags: this.currentPage.tags || [],
          links: this.currentPage.links || []
        });
        this.currentPage.content = content;
        this.markSaving('saved');
        await this.syncTypedLinksToDag(title, content);
        this.renderChecklist();
        this.loadWikiList();
      } catch {
        this.markSaving('failed');
      }
    }

    parseTypedLinks(content) {
      const parser = window.WikiLinkParser;
      if (!parser?.parseWikiReferences) return [];
      const refs = parser.parseWikiReferences(content || '');
      return refs.filter(ref => ref.typed || ref.type === 'page');
    }

    async findOrCreateNode(graph, descriptor) {
      const node = graph.nodes.find(descriptor.match);
      if (node) return node;
      const created = await this.callManageMemory({ action: 'node_add', node: descriptor.create });
      graph.nodes.push(created.node || created);
      return created.node || created;
    }

    async syncTypedLinksToDag(title, content) {
      const refs = this.parseTypedLinks(content).filter(ref => ref?.target);
      if (!refs.length) return;

      try {
        const graphResult = await this.callManageMemory({ action: 'graph_query' });
        const graph = { nodes: graphResult.nodes || [], edges: graphResult.edges || [] };

        const sourceNode = await this.findOrCreateNode(graph, {
          match: n => Array.isArray(n.tags) && n.tags.includes(`wiki-page:${title}`),
          create: {
            type: 'text',
            content: `wiki:${title}`,
            tags: ['wiki-page', `wiki-page:${title}`]
          }
        });

        for (const ref of refs) {
          const locator = ref.locatorRaw || '';
          const relation = locator ? `wiki_ref:${ref.type}:${locator}` : `wiki_ref:${ref.type}`;
          let descriptor;

          if (ref.type === 'image' || ref.type === 'audio' || ref.type === 'video') {
            descriptor = {
              match: n => n.filePath === ref.target && n.type === ref.type,
              create: {
                type: ref.type,
                filePath: ref.target,
                tags: ['wiki-ref', `wiki-ref:${ref.type}`, `wiki-target:${ref.target}`]
              }
            };
          } else if (ref.type === 'pdf') {
            const parsed = window.WikiLinkParser.parseLocator(locator);
            descriptor = {
              match: n => n.filePath === ref.target && n.type === 'pdf_page' && (parsed?.kind !== 'page' || n.pdfPage === parsed.value),
              create: {
                type: 'pdf_page',
                filePath: ref.target,
                pdfPage: parsed?.kind === 'page' ? parsed.value : undefined,
                tags: ['wiki-ref', 'wiki-ref:pdf', `wiki-target:${ref.target}`]
              }
            };
          } else {
            descriptor = {
              match: n => Array.isArray(n.tags) && n.tags.includes(`wiki-page:${ref.target}`),
              create: {
                type: 'text',
                content: ref.type === 'quote' ? `${ref.target}${locator ? '#' + locator : ''}` : `wiki:${ref.target}`,
                tags: ['wiki-ref', `wiki-ref:${ref.type}`, `wiki-page:${ref.target}`]
              }
            };
          }

          const targetNode = await this.findOrCreateNode(graph, descriptor);
          const hasEdge = graph.edges.some(e => e.from === sourceNode.id && e.to === targetNode.id && e.relation === relation);
          if (!hasEdge) {
            const edgeResult = await this.callManageMemory({ action: 'node_link', from: sourceNode.id, to: targetNode.id, relation });
            graph.edges.push(edgeResult.edge || edgeResult);
          }
        }
      } catch {
        // Non-fatal: saving wiki page is the primary operation.
      }
    }

    async rebuildLineIndex() {
      const pages = this.pagesCache || [];
      const index = [];
      await Promise.all(pages.map(async (meta) => {
        try {
          const result = await this.callManageMemory({ action: 'wiki_read', title: meta.title });
          const page = result.page;
          if (!page?.content) return;
          const lines = page.content.split('\n');
          let currentHeading = '';
          lines.forEach((line, i) => {
            const heading = line.match(/^#{1,6}\s+(.*)$/);
            if (heading) {
              currentHeading = heading[1].trim();
              return;
            }
            const text = line.trim();
            if (!text) return;
            index.push({
              title: meta.title,
              lineNumber: i + 1,
              lineText: text,
              normalized: text.toLowerCase(),
              heading: currentHeading,
              offset: Math.max(0, line.indexOf(text))
            });
          });
        } catch {}
      }));
      this.lineIndex = index;
      this.runLineSearch();
    }

    renderSearchResults(results) {
      if (!this.el.wikiSearchResults) return;
      if (!results.length) {
        this.el.wikiSearchResults.innerHTML = '<div class="conv-empty">No line matches yet.</div>';
        return;
      }

      this.el.wikiSearchResults.innerHTML = results.map((r, idx) => `
        <div class="wiki-search-item" data-search-index="${idx}">
          <div class="wiki-search-title">${this.esc(r.title)}</div>
          <div class="wiki-search-meta">Line ${r.lineNumber}${r.heading ? ` · ${this.esc(r.heading)}` : ''}</div>
          <div class="wiki-search-line">${this.esc(r.lineText)}</div>
          <button class="btn btn-outline btn-xs" data-action="open-result" data-search-index="${idx}">Open</button>
        </div>
      `).join('');

      this.el.wikiSearchResults.querySelectorAll('[data-action="open-result"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.searchIndex);
          const hit = results[idx];
          if (!hit) return;
          this.loadWikiPage(hit.title, {
            lineNumber: hit.lineNumber,
            lineText: hit.lineText,
            query: this.el.wikiSearchInput?.value.trim() || ''
          });
        });
      });
    }

    runLineSearch() {
      const q = (this.el.wikiSearchInput?.value || '').trim().toLowerCase();
      if (!q) {
        this.renderSearchResults([]);
        return;
      }
      const terms = q.split(/\s+/).filter(Boolean);
      const ranked = [];
      this.lineIndex.forEach(entry => {
        let score = 0;
        for (const t of terms) {
          const pos = entry.normalized.indexOf(t);
          if (pos === -1) return;
          score += 10 - Math.min(pos, 9);
        }
        ranked.push({ ...entry, score });
      });
      ranked.sort((a, b) => b.score - a.score || a.lineNumber - b.lineNumber);
      this.renderSearchResults(ranked.slice(0, SEARCH_MAX_RESULTS));
    }

    clearHighlights() {
      this.el.wikiPageBody?.querySelectorAll('mark.wiki-line-hit').forEach(mark => {
        const parent = mark.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize();
      });
    }

    highlightText(text) {
      const root = this.el.wikiPageBody;
      if (!root || !text) return false;
      const needle = text.trim().toLowerCase();
      if (!needle) return false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let foundNode = null;
      let foundIndex = -1;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const raw = node.nodeValue || '';
        const lower = raw.toLowerCase();
        const idx = lower.indexOf(needle);
        if (idx !== -1) {
          foundNode = node;
          foundIndex = idx;
          break;
        }
      }
      if (!foundNode) return false;

      const raw = foundNode.nodeValue || '';
      const before = raw.slice(0, foundIndex);
      const middle = raw.slice(foundIndex, foundIndex + text.length);
      const after = raw.slice(foundIndex + text.length);

      const mark = document.createElement('mark');
      mark.className = 'wiki-line-hit';
      mark.textContent = middle;
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));
      foundNode.parentNode.replaceChild(frag, foundNode);
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    }

    applyPendingHighlight() {
      if (!this.pendingHighlight) return;
      this.clearHighlights();
      const { lineNumber, lineText, query, lineStart, lineEnd } = this.pendingHighlight;
      const lines = (this.currentPage?.content || '').split('\n');

      if (lineStart && lineEnd) {
        for (let n = lineStart; n <= lineEnd; n++) {
          const t = (lines[n - 1] || '').trim();
          if (t && this.highlightText(t)) {
            this.pendingHighlight = null;
            return;
          }
        }
      }

      if (lineNumber && lines[lineNumber - 1]) {
        const candidate = (lines[lineNumber - 1] || '').trim();
        if (candidate && this.highlightText(candidate)) {
          this.pendingHighlight = null;
          return;
        }
      }
      if (lineText && this.highlightText(lineText)) {
        this.pendingHighlight = null;
        return;
      }
      if (query && this.highlightText(query)) {
        this.pendingHighlight = null;
        return;
      }
      this.pendingHighlight = null;
    }

    parseTimeLocator(locatorRaw) {
      const parsed = window.WikiLinkParser.parseLocator(locatorRaw);
      if (!parsed || parsed.kind !== 'time') return null;
      const value = parsed.value;
      const range = String(value).split('-');
      const start = parseTimeToSeconds(range[0]);
      const end = range[1] ? parseTimeToSeconds(range[1]) : null;
      if (start == null) return null;
      return { start, end };
    }

    renderReferenceViewer(type = '', src = '', locatorRaw = '') {
      if (!this.el.wikiReferenceViewer) return;
      if (!type) {
        this.el.wikiReferenceViewer.innerHTML = '<div class="conv-empty">Typed link previews will appear here.</div>';
        return;
      }

      if (type === 'image') {
        this.el.wikiReferenceViewer.innerHTML = `<img src="${this.esc(src)}" alt="Linked image" class="wiki-ref-image">`;
        return;
      }

      if (type === 'audio') {
        this.el.wikiReferenceViewer.innerHTML = `<audio controls src="${this.esc(src)}" class="wiki-ref-media"></audio>`;
        const audio = this.el.wikiReferenceViewer.querySelector('audio');
        const range = this.parseTimeLocator(locatorRaw);
        if (audio && range?.start != null) {
          audio.addEventListener('loadedmetadata', () => {
            try { audio.currentTime = range.start; } catch {}
          }, { once: true });
        }
        return;
      }

      if (type === 'video') {
        this.el.wikiReferenceViewer.innerHTML = `<video controls src="${this.esc(src)}" class="wiki-ref-media"></video>`;
        const video = this.el.wikiReferenceViewer.querySelector('video');
        const range = this.parseTimeLocator(locatorRaw);
        if (video && range?.start != null) {
          video.addEventListener('loadedmetadata', () => {
            try { video.currentTime = range.start; } catch {}
          }, { once: true });
        }
        return;
      }

      if (type === 'pdf') {
        const anchor = locatorRaw ? `#${locatorRaw}` : '';
        this.el.wikiReferenceViewer.innerHTML = `
          <div class="wiki-ref-pdf-actions">
            <a class="btn btn-outline btn-xs" target="_blank" rel="noopener noreferrer" href="${this.esc(src + anchor)}">Open PDF</a>
            <span style="font-size:.72rem;color:var(--text-muted);">PDF offset support depends on browser viewer.</span>
          </div>
        `;
      }
    }

    async followParsedLink(link) {
      const type = (link.type || 'page').toLowerCase();
      const target = (link.target || '').trim();
      const locatorRaw = (link.locatorRaw || '').trim();
      if (!target) return;

      if (type === 'page') {
        this.loadWikiPage(target);
        return;
      }

      if (type === 'quote') {
        const parsed = window.WikiLinkParser.parseLocator(locatorRaw);
        if (parsed?.kind === 'line') {
          this.loadWikiPage(target, {
            lineStart: parsed.start,
            lineEnd: parsed.end
          });
        } else {
          this.loadWikiPage(target);
        }
        return;
      }

      const fileUrl = `/api/media/preview?file=${encodeURIComponent(target)}`;
      this.renderReferenceViewer(type, fileUrl, locatorRaw);
      if (type === 'pdf') {
        window.open(`${fileUrl}${locatorRaw ? '#' + locatorRaw : ''}`, '_blank', 'noopener');
      }
    }

    createFrontmatter(period, dateValue) {
      return ['---', 'type: journal', `period: ${period}`, `${period === 'daily' ? 'date' : 'month'}: ${dateValue}`, '---', ''].join('\n');
    }

    buildJournalFromTemplate(period, dateValue, carryItems = []) {
      const cfg = this.templateConfig[period] || this.defaultTemplateConfig()[period];
      const lines = [this.createFrontmatter(period, dateValue)];
      const sections = cfg.sections.filter(s => s.enabled);
      sections.forEach((section, idx) => {
        const headingLevel = idx === 0 ? '# ' : '## ';
        lines.push(`${headingLevel}${section.title}`);
        if (/checklist/i.test(section.title)) {
          const base = [...(cfg.checklist || []), ...carryItems].map(item => ({
            id: item.id || slugId(item.text),
            text: item.text || '',
            done: !!item.done,
            carried_from: item.carried_from || undefined
          }));
          base.forEach(item => {
            const suffix = item.carried_from ? ` _(carried from ${item.carried_from})_` : '';
            lines.push(`- [${item.done ? 'x' : ' '}] <!--id:${item.id}--> ${item.text}${suffix}`);
          });
          if (!base.length) lines.push('- [ ] <!--id:example-item--> ');
        } else {
          lines.push('');
        }
        lines.push('');
      });
      return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    async openDailyJournal() {
      const date = this.el.journalDateInput?.value || toIsoDate(new Date());
      const title = `journal/daily/${date}`;
      const existing = await this.callManageMemory({ action: 'wiki_read', title });
      if (existing?.page) {
        this.loadWikiPage(title);
        return;
      }

      const carry = await this.collectCarryOverForDaily(date);
      const content = this.buildJournalFromTemplate('daily', date, carry);
      await this.callManageMemory({
        action: 'wiki_write',
        title,
        content,
        tags: ['journal', 'daily'],
        links: []
      });
      await this.loadWikiList();
      this.loadWikiPage(title);
    }

    async openMonthlyJournal() {
      const date = this.el.journalDateInput?.value || toIsoDate(new Date());
      const month = date.slice(0, 7);
      const title = `journal/monthly/${month}`;
      const existing = await this.callManageMemory({ action: 'wiki_read', title });
      if (!existing?.page) {
        const content = this.buildJournalFromTemplate('monthly', month, []);
        await this.callManageMemory({
          action: 'wiki_write',
          title,
          content,
          tags: ['journal', 'monthly'],
          links: []
        });
      }
      await this.loadWikiList();
      this.loadWikiPage(title);
    }

    async collectCarryOverForDaily(dateText) {
      const dt = new Date(`${dateText}T00:00:00`);
      if (Number.isNaN(dt.getTime())) return [];
      dt.setDate(dt.getDate() - 1);
      const prevDate = toIsoDate(dt);
      const prevTitle = `journal/daily/${prevDate}`;

      try {
        const prev = await this.callManageMemory({ action: 'wiki_read', title: prevTitle });
        const page = prev?.page;
        if (!page?.content) return [];
        const incomplete = this.parseChecklistItems(page.content).filter(item => !item.done);
        if (!incomplete.length) return [];

        const mode = prompt(
          `Previous daily journal has ${incomplete.length} incomplete checklist items. Carry forward? (all / selected / skip)`,
          'selected'
        );
        if (!mode || mode.toLowerCase() === 'skip') return [];
        if (mode.toLowerCase() === 'all') {
          return incomplete.map(item => ({ ...item, carried_from: prevTitle }));
        }

        const ids = prompt(
          `Enter checklist IDs to carry forward (comma-separated):\n${incomplete.map(item => `${item.id}: ${item.text}`).join('\n')}`,
          incomplete.map(item => item.id).join(',')
        );
        if (!ids) return [];
        const selectedIds = new Set(ids.split(',').map(v => v.trim()).filter(Boolean));
        return incomplete
          .filter(item => selectedIds.has(item.id))
          .map(item => ({ ...item, carried_from: prevTitle }));
      } catch {
        return [];
      }
    }

    templatePeriodKey() {
      return this.el.templatePeriod?.value === 'monthly' ? 'monthly' : 'daily';
    }

    renderTemplateEditor() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      if (!cfg) return;

      if (this.el.templateSectionSelect) {
        this.el.templateSectionSelect.innerHTML = cfg.sections.map((section, idx) =>
          `<option value="${idx}">${section.enabled ? '✓' : '✕'} ${this.esc(section.title)}</option>`
        ).join('');
      }
      if (this.el.templateChecklistSelect) {
        this.el.templateChecklistSelect.innerHTML = (cfg.checklist || []).map((item, idx) =>
          `<option value="${idx}">${this.esc(item.text || item.id || `item-${idx + 1}`)}</option>`
        ).join('');
      }
      this.syncTemplateEditorsFromSelection();
    }

    syncTemplateEditorsFromSelection() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      if (!cfg) return;

      const sIdx = Number(this.el.templateSectionSelect?.value || 0);
      const section = cfg.sections[sIdx];
      if (section && this.el.templateSectionName) this.el.templateSectionName.value = section.title;

      const cIdx = Number(this.el.templateChecklistSelect?.value || 0);
      const item = cfg.checklist?.[cIdx];
      if (this.el.templateChecklistText) this.el.templateChecklistText.value = item?.text || '';
    }

    templateAddSection() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      const title = (this.el.templateSectionName?.value || '').trim();
      if (!title) return;
      cfg.sections.push({ id: slugId(title), title, enabled: true });
      this.renderTemplateEditor();
    }

    templateRemoveSection() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      const idx = Number(this.el.templateSectionSelect?.value || -1);
      if (idx < 0 || idx >= cfg.sections.length) return;
      cfg.sections.splice(idx, 1);
      this.renderTemplateEditor();
    }

    templateRenameSection() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      const idx = Number(this.el.templateSectionSelect?.value || -1);
      const title = (this.el.templateSectionName?.value || '').trim();
      if (idx < 0 || !title) return;
      cfg.sections[idx].title = title;
      this.renderTemplateEditor();
    }

    templateMoveSection(delta) {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      const idx = Number(this.el.templateSectionSelect?.value || -1);
      const next = idx + delta;
      if (idx < 0 || next < 0 || next >= cfg.sections.length) return;
      const [item] = cfg.sections.splice(idx, 1);
      cfg.sections.splice(next, 0, item);
      this.renderTemplateEditor();
      if (this.el.templateSectionSelect) this.el.templateSectionSelect.value = String(next);
      this.syncTemplateEditorsFromSelection();
    }

    templateToggleSection() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      const idx = Number(this.el.templateSectionSelect?.value || -1);
      if (idx < 0) return;
      cfg.sections[idx].enabled = !cfg.sections[idx].enabled;
      this.renderTemplateEditor();
      if (this.el.templateSectionSelect) this.el.templateSectionSelect.value = String(idx);
    }

    templateAddChecklistItem() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      const text = (this.el.templateChecklistText?.value || '').trim();
      if (!text) return;
      cfg.checklist = cfg.checklist || [];
      cfg.checklist.push({ id: slugId(text), text, done: false });
      this.renderTemplateEditor();
    }

    templateRemoveChecklistItem() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      const idx = Number(this.el.templateChecklistSelect?.value || -1);
      if (!cfg.checklist || idx < 0 || idx >= cfg.checklist.length) return;
      cfg.checklist.splice(idx, 1);
      this.renderTemplateEditor();
    }

    templateRenameChecklistItem() {
      const period = this.templatePeriodKey();
      const cfg = this.templateConfig[period];
      const idx = Number(this.el.templateChecklistSelect?.value || -1);
      const text = (this.el.templateChecklistText?.value || '').trim();
      if (!cfg.checklist || idx < 0 || idx >= cfg.checklist.length || !text) return;
      cfg.checklist[idx].text = text;
      this.renderTemplateEditor();
      if (this.el.templateChecklistSelect) this.el.templateChecklistSelect.value = String(idx);
      this.syncTemplateEditorsFromSelection();
    }

    currentInstructionFromEditor() {
      const editor = this.el.wikiEditor;
      if (!editor) return '';
      const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
      if (selected) return selected;

      const before = editor.value.slice(0, editor.selectionStart);
      const after = editor.value.slice(editor.selectionStart);
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineEndIdx = after.indexOf('\n');
      const line = editor.value.slice(lineStart, lineEndIdx === -1 ? editor.value.length : editor.selectionStart + lineEndIdx).trim();
      if (line.startsWith('>')) return line.replace(/^>\s*/, '').trim();
      return '';
    }

    async askLlmFromEditor() {
      const instruction = this.currentInstructionFromEditor();
      if (!instruction) {
        this.setSaveStatus('Select text or place cursor on a "> instruction" line first.');
        return;
      }

      this.setSaveStatus('Running one-shot LLM…');
      try {
        const r = await fetch('/api/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'use_free_llm',
            params: {
              prompt: instruction,
              workspace_root: this.workspaceValue()
            }
          })
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.error || 'LLM request failed');

        const payload = d.result || {};
        const text = typeof payload === 'string'
          ? payload
          : (payload?.content || payload?.response || payload?.result || JSON.stringify(payload, null, 2));

        this.llmDraft = {
          instruction,
          text,
          model: payload?.model || payload?.provider || '',
          createdAt: new Date().toISOString()
        };
        if (this.el.wikiLlmOutput) this.el.wikiLlmOutput.textContent = text;
        this.toggleLlmActions(true);
        this.setSaveStatus('LLM response ready. Choose Insert, Copy, or Discard.');
      } catch (err) {
        this.toggleLlmActions(false);
        this.setSaveStatus(`LLM request failed: ${err.message || err}`);
      }
    }

    toggleLlmActions(show) {
      [this.el.wikiLlmInsertBtn, this.el.wikiLlmCopyBtn, this.el.wikiLlmDiscardBtn].forEach(btn => {
        if (!btn) return;
        btn.style.display = show ? '' : 'none';
      });
    }

    insertLlmDraft() {
      if (!this.llmDraft || !this.el.wikiEditor) return;
      const block = [
        '',
        '> [LLM Insert]',
        `source: user-as-agent`,
        `model: ${this.llmDraft.model || 'unknown'}`,
        `timestamp: ${this.llmDraft.createdAt}`,
        '',
        this.llmDraft.text,
        ''
      ].join('\n');
      const cursor = this.el.wikiEditor.selectionEnd;
      const raw = this.el.wikiEditor.value;
      this.el.wikiEditor.value = raw.slice(0, cursor) + block + raw.slice(cursor);
      this.currentPage.content = this.el.wikiEditor.value;
      this.markSaving('pending');
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveCurrentPage(), 200);
      this.discardLlmDraft();
    }

    async copyLlmDraft() {
      if (!this.llmDraft) return;
      try {
        await navigator.clipboard.writeText(this.llmDraft.text);
        this.setSaveStatus('LLM response copied.');
      } catch {
        this.setSaveStatus('Copy failed.');
      }
    }

    discardLlmDraft() {
      this.llmDraft = null;
      if (this.el.wikiLlmOutput) this.el.wikiLlmOutput.textContent = '';
      this.toggleLlmActions(false);
      this.setSaveStatus('LLM draft discarded.');
    }

    createNewPage() {
      const title = prompt('New wiki page title');
      if (!title) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      const content = '# New Page\n\n';
      this.callManageMemory({
        action: 'wiki_write',
        title: trimmed,
        content,
        tags: [],
        links: []
      }).then(() => {
        this.loadWikiList();
        this.loadWikiPage(trimmed);
      }).catch((err) => {
        this.setSaveStatus(`Create failed: ${err.message || err}`);
      });
    }
  }

  window.DashboardWiki = {
    create(deps) {
      const controller = new WikiWorkspaceController(deps);
      controller.init();
      return controller;
    }
  };
})();
