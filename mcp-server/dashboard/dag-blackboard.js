const elWorkspaceInput = document.getElementById('dagmem-workspace-input');
const elRefresh = document.getElementById('dagmem-bb-refresh');
const elCount = document.getElementById('dagmem-bb-count');
const elBlackboardContainer = document.getElementById('dagmem-blackboard-container');

function escapeHtml(str) {
  const temp = document.createElement('div');
  temp.textContent = str;
  return temp.innerHTML;
}

function ebbinghausRetention(node) {
  const days = (Date.now() - node.lastReviewedAt) / 86400000;
  return node.confidence * Math.pow(2, -days / node.halfLifeDays);
}

async function loadBlackboard() {
  if (!elWorkspaceInput || !elRefresh || !elCount || !elBlackboardContainer) return;

  const workspacePath = elWorkspaceInput.value.trim();
  if (!workspacePath) {
    elBlackboardContainer.innerHTML = '<div class="conv-empty">Set a workspace above, then click Refresh Queue.</div>';
    elCount.textContent = '0';
    return;
  }

  try {
    const response = await fetch('/api/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage_memory', params: { action: 'graph_query', workspace_root: workspacePath } })
    });
    const d = await response.json();
    if (!d || !d.result || !d.result.nodes || d.result.nodes.length === 0) {
      elBlackboardContainer.innerHTML = '<div class="conv-empty">No nodes due for review.</div>';
      elCount.textContent = '0';
      return;
    }

    const dueNodes = d.result.nodes.filter(node => ebbinghausRetention(node) < 0.5).sort((a, b) => ebbinghausRetention(a) - ebbinghausRetention(b));
    elCount.textContent = dueNodes.length.toString();

    if (dueNodes.length === 0) {
      elBlackboardContainer.innerHTML = '<div class="conv-empty">Nothing due for review right now.</div>';
      return;
    }

    elBlackboardContainer.innerHTML = '';
    dueNodes.forEach(node => {
      const row = document.createElement('div');
      row.className = 'bb-node';

      const idCell = document.createElement('span');
      idCell.textContent = node.id.slice(0, 8);
      row.appendChild(idCell);

      const contentCell = document.createElement('span');
      contentCell.textContent = escapeHtml(node.content || node.filePath).slice(0, 60);
      row.appendChild(contentCell);

      const retentionCell = document.createElement('span');
      retentionCell.textContent = `Retention: ${Math.round(ebbinghausRetention(node) * 100)}%`;
      row.appendChild(retentionCell);

      const resetButton = document.createElement('button');
      resetButton.className = 'btn btn-secondary';
      resetButton.textContent = 'Reset Decay';
      resetButton.setAttribute('data-node-id', node.id);
      row.appendChild(resetButton);

      elBlackboardContainer.appendChild(row);
    });
  } catch (error) {
    elBlackboardContainer.innerHTML = '<div class="conv-empty">Failed to load blackboard.</div>';
    elCount.textContent = '0';
  }
}

if (elBlackboardContainer) {
  elBlackboardContainer.addEventListener('click', async event => {
    if (event.target.hasAttribute('data-node-id')) {
      const nodeId = event.target.getAttribute('data-node-id');
      const workspacePath = elWorkspaceInput ? elWorkspaceInput.value.trim() : '';
      if (!workspacePath) return;

      try {
        await fetch('/api/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: 'manage_memory', params: { action: 'node_review', nodeId, workspace_root: workspacePath } })
        });
        await loadBlackboard();
      } catch (error) {
        console.error('Failed to review node:', error);
      }
    }
  });
}

if (elRefresh) {
  elRefresh.addEventListener('click', loadBlackboard);
}

try {
  loadBlackboard();
} catch (error) {
  console.error('Failed to initialize blackboard:', error);
}
