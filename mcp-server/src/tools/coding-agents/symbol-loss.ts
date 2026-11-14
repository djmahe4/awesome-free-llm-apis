/** Names declared at the top level of a source file, in file order. */
function topLevelNames(filePath: string, content: string): string[] {
  const re = /\.py$/i.test(filePath) ? /^(?:async\s+)?(?:def|class)\s+(\w+)/gm : /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+(\w+)/gm;
  return [...content.matchAll(re)].map(m => m[1]);
}

/** Top-level names an edit removed although the goal does not mention them (#147). */
export function lostSymbols(filePath: string, before: string, after: string, goal: string): string[] {
  if (!/\.(?:[cm]?[jt]sx?|py)$/i.test(filePath)) return [];
  const kept = new Set(topLevelNames(filePath, after));
  return topLevelNames(filePath, before).filter(name => !kept.has(name) && !new RegExp(`\\b${name}\\b`).test(goal));
}
