export function normalizeWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalized || '/';
}

export function isSameOrNestedWorkspacePath(candidate: string, workspaceRoot: string): boolean {
  const candidatePath = normalizeWorkspacePath(candidate);
  const root = normalizeWorkspacePath(workspaceRoot);
  return candidatePath === root || candidatePath.startsWith(root === '/' ? '/' : `${root}/`);
}

export function containsWorkspacePath(text: string, workspaceRoot: string): boolean {
  const normalizedText = text.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  const root = normalizeWorkspacePath(workspaceRoot);
  let index = normalizedText.indexOf(root);
  while (index !== -1) {
    const next = normalizedText[index + root.length];
    if (next === undefined || next === '/' || /[\s"'`,;)}\]]/.test(next)) return true;
    index = normalizedText.indexOf(root, index + 1);
  }
  return false;
}
