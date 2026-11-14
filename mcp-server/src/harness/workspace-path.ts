export function normalizeWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalized || '/';
}

export function isSameOrNestedWorkspacePath(candidate: string, workspaceRoot: string): boolean {
  if (!candidate || !workspaceRoot) return false;
  const candidatePath = normalizeWorkspacePath(candidate);
  const root = normalizeWorkspacePath(workspaceRoot);
  return candidatePath === root || candidatePath.startsWith(root === '/' ? '/' : `${root}/`);
}

export function containsWorkspacePath(text: string, workspaceRoot: string): boolean {
  if (!text || !workspaceRoot) return false;
  const normalizedText = text.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  const root = normalizeWorkspacePath(workspaceRoot);
  let index = normalizedText.indexOf(root);
  while (index !== -1) {
    const prev = index > 0 ? normalizedText[index - 1] : undefined;
    const next = normalizedText[index + root.length];
    const prevValid = prev === undefined || prev === '/' || /[\s"'`,;({\[]/.test(prev);
    const nextValid = next === undefined || next === '/' || /[\s"'`,;)}\]]/.test(next);
    if (prevValid && nextValid) return true;
    index = normalizedText.indexOf(root, index + 1);
  }
  return false;
}
