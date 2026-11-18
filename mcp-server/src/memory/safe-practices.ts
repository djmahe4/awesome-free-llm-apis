import fs from 'node:fs/promises';
import path from 'node:path';

export interface SafePracticesAuditResult {
  updated: boolean;
  filePath: string;
  languagesDetected: string[];
  practicesAppended: string[];
}

export const SAFE_PRACTICES_TEMPLATES: Record<string, string> = {
  typescript: `### TypeScript / JavaScript Safe Practices
- **Linting & Formatting**: Follow ESLint with \`@typescript-eslint\`, Prettier, and \`eslint-plugin-jsdoc\`.
- **Comment Contracts**: Exported and public functions require written contracts (\`@contract\`, \`@pre\`, \`@post\`, \`@throws\`, \`@returns\`).
- **File Headers**: New source files must contain a top-level descriptive file header.
- **Hygiene**: No commented-out code; no unowned \`TODO\` or \`FIXME\` comments in production code.`,

  python: `### Python Safe Practices
- **Linting & Formatting**: Enforce Ruff (\`ruff check\`, \`ruff format\`) and strict PEP 8 / PEP 257 docstring rules.
- **Type Annotations**: Functions must include explicit PEP 484 type hints for all parameters and return types.
- **Docstrings**: Public functions and classes require Google or Sphinx style docstrings detailing Args, Returns, and Raises.
- **Hygiene**: Eliminate wildcard imports (\`from x import *\`) and unhandled broad exceptions (\`except:\`).`,

  general: `### General Engineering Guidelines
- **Verification**: Run local pre-commit checks (\`npm run verify:precommit\` or relevant test suites) before committing.
- **Atomic Commits**: Commit changes with conventional commit prefixes (\`feat:\`, \`fix:\`, \`chore:\`, \`docs:\`).
- **Graph & Contract Fidelity**: Avoid changing exported signatures without reviewing dependent nodes in \`DiskSymbolDb\`.`
};

/**
 * Detects workspace languages and verifies or appends Safe Practices to AGENTS.md.
 */
export async function auditAndPromoteSafePractices(workspaceRoot: string): Promise<SafePracticesAuditResult> {
  const agentsPath = path.join(workspaceRoot, '.agents', 'AGENTS.md');
  const rootAgentsPath = path.join(workspaceRoot, 'AGENTS.md');

  let targetPath = agentsPath;
  let existingContent = '';

  try {
    existingContent = await fs.readFile(agentsPath, 'utf-8');
  } catch {
    try {
      existingContent = await fs.readFile(rootAgentsPath, 'utf-8');
      targetPath = rootAgentsPath;
    } catch {
      targetPath = agentsPath;
    }
  }

  // Detect languages present in workspace
  const languagesDetected: string[] = [];
  try {
    const files = await fs.readdir(workspaceRoot);
    if (files.some(f => f === 'package.json' || f === 'tsconfig.json' || f.endsWith('.ts') || f.endsWith('.js'))) {
      languagesDetected.push('typescript');
    }
    if (files.some(f => f === 'pyproject.toml' || f === 'requirements.txt' || f === 'Pipfile' || f.endsWith('.py'))) {
      languagesDetected.push('python');
    }
  } catch {}

  if (languagesDetected.length === 0) {
    languagesDetected.push('typescript');
  }

  const practicesAppended: string[] = [];
  const missingSections: string[] = [];

  if (!existingContent.includes('## Safe Practices')) {
    missingSections.push('## Safe Practices\n');
  }

  for (const lang of languagesDetected) {
    const headerPattern = lang === 'typescript' ? '### TypeScript / JavaScript Safe Practices' : '### Python Safe Practices';
    if (!existingContent.includes(headerPattern)) {
      missingSections.push(SAFE_PRACTICES_TEMPLATES[lang]);
      practicesAppended.push(lang);
    }
  }

  if (!existingContent.includes('### General Engineering Guidelines')) {
    missingSections.push(SAFE_PRACTICES_TEMPLATES.general);
    practicesAppended.push('general');
  }

  let updated = false;
  if (missingSections.length > 0) {
    const blockToAppend = '\n\n' + missingSections.join('\n\n') + '\n';
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, existingContent ? (existingContent.trimEnd() + blockToAppend) : blockToAppend.trimStart(), 'utf-8');
      updated = true;
    } catch {}
  }

  return {
    updated,
    filePath: targetPath,
    languagesDetected,
    practicesAppended,
  };
}
