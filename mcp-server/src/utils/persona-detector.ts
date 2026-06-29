import fs from 'fs';
import path from 'path';

/**
 * Heuristically detects the user/agent persona based on the query text
 * and optional workspace root AGENTS.md override.
 * 
 * Precedence: AGENTS.md preferred persona > heuristic detection > 'generic'
 */
export function detectPersona(query: string, workspaceRoot?: string): string {
  // 1. Precedence: Check AGENTS.md override
  if (workspaceRoot) {
    try {
      const agentsMdPath = path.join(workspaceRoot, 'AGENTS.md');
      if (fs.existsSync(agentsMdPath)) {
        const content = fs.readFileSync(agentsMdPath, 'utf-8');
        const match = content.match(/preferred\s+persona:\s*(\w+)/i) || 
                      content.match(/persona:\s*(\w+)/i);
        if (match) {
          return match[1].toLowerCase().trim();
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Heuristics classification
  const lower = query.toLowerCase();

  // Debugger (highest priority heuristics since it overrides gitignores/scanning restrictions)
  const debuggerPatterns = [
    'error', 'exception', 'bug', 'crash', 'stack trace', 'stacktrace', 'leak', 'broken',
    'why does', 'type error', 'typeerror', 'undefined', 'null', 'failed', 'ts(', 'issue',
    'schema', 'variable', 'parameter', 'debug package', 'function schema'
  ];
  if (debuggerPatterns.some(pat => lower.includes(pat))) {
    return 'debugger';
  }

  // Researcher
  const researcherPatterns = [
    'pdf://', 'paper', 'citation', 'arxiv', 'research', 'study', 'thesis', 'literature'
  ];
  if (researcherPatterns.some(pat => lower.includes(pat))) {
    return 'researcher';
  }

  // Student
  const studentPatterns = [
    'explain how', 'how to', 'tutorial', 'what is', 'learn', 'teaching', 'concept'
  ];
  if (studentPatterns.some(pat => lower.includes(pat))) {
    return 'student';
  }

  // Marketer / SEO
  const marketingPatterns = [
    'seo', 'marketing', 'campaign', 'keyword', 'traffic', 'ad'
  ];
  if (marketingPatterns.some(pat => lower.includes(pat))) {
    return 'marketer';
  }

  // Planner
  const plannerPatterns = [
    'plan', 'roadmap', 'timeline', 'milestone', 'phase', 'step'
  ];
  if (plannerPatterns.some(pat => lower.includes(pat))) {
    return 'planner';
  }

  // Coder
  const coderPatterns = [
    'implement', 'refactor', 'class', 'function', 'method', 'interface', 'module',
    'compile', 'run', 'build', 'test', 'package.json', 'tsconfig.json'
  ];
  if (coderPatterns.some(pat => lower.includes(pat))) {
    return 'coder';
  }

  // Fallback
  return 'generic';
}
