import path from 'node:path';
import fs from 'node:fs';
import { httpGetText, type FetchLike } from '../utils/http.js';
import { RemoteRepoSource } from './remote-repo-source.js';
import { safeSkillSlug, type LoadSkillPromptResult } from '../tools/load-skill-prompt.js';
import { resolveWithin } from '../utils/workspace-roots.js';

export { safeSkillSlug };

export interface DiscoveredSkill {
  name: string;
  description: string;
  path: string;
  rawUrl?: string;
}

export interface InstallSkillResult {
  success: boolean;
  skillName: string;
  installedPath?: string;
  error?: string;
}

const SKILL_REGEX = /(?:^|\/)(?:\.claude\/skills\/[^/]+\/SKILL\.md|skills\/[^/]+\/SKILL\.md|SKILL\.md)$/i;

export function parseGitHubRepoUrl(target: string): { owner: string; repo: string } | null {
  if (!target || typeof target !== 'string') return null;
  const clean = target.trim().replace(/\/+$/, '');
  if (!clean) return null;

  if (clean.includes('://')) {
    const urlMatch = /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)$/i.exec(clean);
    if (urlMatch) {
      return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/i, '') };
    }
    return null;
  }

  const ghDomainMatch = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(clean);
  if (ghDomainMatch) {
    return { owner: ghDomainMatch[1], repo: ghDomainMatch[2].replace(/\.git$/i, '') };
  }

  const handleMatch = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(clean);
  if (handleMatch) {
    return { owner: handleMatch[1], repo: handleMatch[2].replace(/\.git$/i, '') };
  }

  return null;
}

export function discoverSkillsInTree(tree: Array<{ path: string; type?: string }>): string[] {
  return tree
    .filter(entry => (!entry.type || entry.type === 'blob') && SKILL_REGEX.test(entry.path))
    .map(entry => entry.path);
}

export function parseSkillMdContent(skillPath: string, content: string): DiscoveredSkill {
  let name = path.basename(path.dirname(skillPath));
  if (name === '.' || !name || name === 'skills') {
    name = 'root-skill';
  }
  let description = '';

  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (frontmatterMatch) {
    const yaml = frontmatterMatch[1];
    const nameMatch = /^name:\s*['"]?([^'"\r\n]+)['"]?/m.exec(yaml);
    if (nameMatch) {
      name = nameMatch[1].trim();
    }

    const descMatch = /^description:\s*['"]?([^'"\r\n]+)['"]?/m.exec(yaml);
    if (descMatch) {
      description = descMatch[1].trim();
    }
  }

  if (!description) {
    const lines = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').split(/\r?\n/);
    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('![')) {
        description = trimmed.slice(0, 200);
        break;
      }
    }
  }

  return {
    name,
    description: description || 'Skill definition',
    path: skillPath,
  };
}

export function parseReadmeSkills(readmeContent: string): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];
  const lines = readmeContent.split(/\r?\n/);
  const seen = new Set<string>();

  function addSkill(name: string, description: string, skillPath = ''): void {
    let cleanName = name.replace(/`/g, '').trim();
    let cleanPath = skillPath.replace(/`/g, '').trim();
    let cleanDesc = description.replace(/`/g, '').trim();

    const nameLink = /\[([^\]]+)\]\(([^)]+)\)/.exec(cleanName);
    if (nameLink) {
      cleanName = nameLink[1];
      if (!cleanPath) cleanPath = nameLink[2];
    }

    const pathLink = /\[([^\]]+)\]\(([^)]+)\)/.exec(cleanPath);
    if (pathLink) {
      cleanPath = pathLink[2];
    }

    cleanName = cleanName.replace(/[*_[\]]/g, '').trim();
    cleanDesc = cleanDesc.replace(/[*]/g, '').trim();
    if (!cleanName || cleanName.length < 2 || cleanName.length > 60) return;
    if (/^(name|skill|tool|description|status|path|type|license|overview)$/i.test(cleanName)) return;

    const key = cleanName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    skills.push({
      name: cleanName,
      description: cleanDesc || 'Discovered from README',
      path: cleanPath,
    });
  }

  // 1. Table parser
  let inTable = false;
  let nameCol = -1;
  let descCol = -1;
  let pathCol = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim().replace(/`/g, ''));
      if (!inTable) {
        const lowerCells = cells.map(c => c.toLowerCase());
        const nIdx = lowerCells.findIndex(c => /^(skill|name|power|tool|title|agent|library)/i.test(c));
        const dIdx = lowerCells.findIndex(c => /(desc|summary|overview|purpose|detail|about|what)/i.test(c));
        const pIdx = lowerCells.findIndex(c => /(path|folder|directory|link|file)/i.test(c));

        if (nIdx !== -1 && dIdx !== -1) {
          inTable = true;
          nameCol = nIdx;
          descCol = dIdx;
          pathCol = pIdx;
          continue;
        }
      } else {
        if (cells.every(c => /^:?-+:?$/.test(c))) {
          continue;
        }
        if (nameCol >= 0 && nameCol < cells.length) {
          let rawName = cells[nameCol];
          let skillPath = pathCol >= 0 && pathCol < cells.length ? cells[pathCol] : '';
          const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(rawName);
          if (linkMatch) {
            rawName = linkMatch[1];
            if (!skillPath) skillPath = linkMatch[2];
          }
          const pathMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(skillPath);
          if (pathMatch) {
            skillPath = pathMatch[2];
          }
          const desc = descCol >= 0 && descCol < cells.length ? cells[descCol] : '';
          addSkill(rawName, desc, skillPath);
        }
      }
    } else {
      inTable = false;
    }
  }

  // 2. Bullet list parser
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('-') && !line.startsWith('*') && !line.startsWith('+')) continue;

    const bulletMatch = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (!bulletMatch) continue;
    const rest = bulletMatch[1].trim().replace(/`/g, '');

    // Pattern 1: **[name](link)**: desc or **[name](link)** - desc
    let match = /^\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*(?::|[-–—])\s*(.+)$/.exec(rest);
    if (match) {
      addSkill(match[1], match[3], match[2]);
      continue;
    }

    // Pattern 2: [name](link): desc or [name](link) - desc
    match = /^\[([^\]]+)\]\(([^)]+)\)\s*(?::|[-–—])\s*(.+)$/.exec(rest);
    if (match) {
      addSkill(match[1], match[3], match[2]);
      continue;
    }

    // Pattern 3: **name**: desc or **name** - desc
    match = /^\*\*([^*]+)\*\*\s*(?::|[-–—])\s*(.+)$/.exec(rest);
    if (match) {
      let bName = match[1].trim();
      let bPath = '';
      const lMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(bName);
      if (lMatch) {
        bName = lMatch[1];
        bPath = lMatch[2];
      }
      addSkill(bName, match[2], bPath);
      continue;
    }

    // Pattern 4: Plain name: desc or name - desc
    match = /^([a-zA-Z0-9_.-]{2,})\s*(?::|[-–—])\s+(.+)$/.exec(rest);
    if (match && !/^(note|warning|tip|important|caution)$/i.test(match[1])) {
      addSkill(match[1], match[2]);
      continue;
    }
  }

  // 3. Header parser
  const IGNORED_HEADERS = new Set([
    'installation', 'usage', 'features', 'table of contents', 'license',
    'contributing', 'skills', 'overview', 'requirements', 'setup',
    'getting started', 'quick start', 'faq', 'architecture', 'acknowledgments',
    'roadmap', 'prerequisites', 'background', 'description',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const hMatch = /^#{2,4}\s+(.+)$/.exec(line);
    if (!hMatch) continue;

    let title = hMatch[1].trim();
    let skillPath = '';
    const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(title);
    if (linkMatch) {
      title = linkMatch[1];
      skillPath = linkMatch[2];
    }
    const cleanTitle = title.replace(/[`*]/g, '').trim();
    if (IGNORED_HEADERS.has(cleanTitle.toLowerCase())) continue;

    let desc = '';
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const nextLine = lines[j].trim();
      if (!nextLine) continue;
      if (nextLine.startsWith('#') || nextLine.startsWith('|') || nextLine.startsWith('```')) break;
      desc = nextLine;
      break;
    }

    if (desc) {
      addSkill(cleanTitle, desc, skillPath);
    }
  }

  return skills;
}

export async function discoverRepoSkills(options: {
  owner: string;
  repo: string;
  ref?: string;
  fetchImpl?: FetchLike;
  token?: string;
}): Promise<{ skills: DiscoveredSkill[]; readmeOverview?: string }> {
  const source = new RemoteRepoSource({ fetchImpl: options.fetchImpl, token: options.token });
  const treeRes = await source.indexTree(options.owner, options.repo, options.ref || 'main');
  if (!treeRes.success) {
    return { skills: [], readmeOverview: undefined };
  }

  const skillPaths = discoverSkillsInTree(treeRes.descriptors);
  const readmeDesc = treeRes.descriptors.find(d => /^readme\.md$/i.test(path.basename(d.path)));

  let readmeSkills: DiscoveredSkill[] = [];
  let readmeOverview: string | undefined;

  if (readmeDesc) {
    const commit = treeRes.commitSha || options.ref || 'main';
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/${encodeURIComponent(commit)}/${readmeDesc.path}`;
    const headers: Record<string, string> = {
      Accept: 'text/plain, text/markdown, */*',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    };
    const res = await httpGetText(rawUrl, { fetchImpl: options.fetchImpl, headers });
    if (res.ok && typeof res.text === 'string') {
      readmeSkills = parseReadmeSkills(res.text);
      const lines = res.text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('[!') && !l.startsWith('!['));
      if (lines.length > 0) {
        readmeOverview = lines[0].slice(0, 300);
      }
    }
  }

  const mergedSkills: DiscoveredSkill[] = [];
  const addedNames = new Set<string>();

  for (const sPath of skillPaths) {
    let skillName = path.basename(path.dirname(sPath));
    if (skillName === '.' || !skillName || skillName === 'skills') {
      skillName = options.repo;
    }
    const matchingReadme = readmeSkills.find(r => r.name.toLowerCase() === skillName.toLowerCase());
    mergedSkills.push({
      name: skillName,
      description: matchingReadme ? matchingReadme.description : 'Skill definition',
      path: sPath,
    });
    addedNames.add(skillName.toLowerCase());
  }

  for (const rSkill of readmeSkills) {
    if (!addedNames.has(rSkill.name.toLowerCase())) {
      mergedSkills.push(rSkill);
      addedNames.add(rSkill.name.toLowerCase());
    }
  }

  return { skills: mergedSkills, readmeOverview };
}

export async function installRepoSkill(options: {
  owner: string;
  repo: string;
  ref?: string;
  skillSubpath: string;
  targetDir: string;
  overwrite?: boolean;
  fetchImpl?: FetchLike;
  token?: string;
}): Promise<InstallSkillResult> {
  const { owner, repo, ref = 'main', targetDir, overwrite = true, fetchImpl, token } = options;

  let skillDirInRepo = options.skillSubpath;
  if (skillDirInRepo.endsWith('SKILL.md')) {
    skillDirInRepo = path.dirname(skillDirInRepo);
  }

  const rawUrl = skillDirInRepo === '.'
    ? `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/SKILL.md`
    : `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${skillDirInRepo}/SKILL.md`;

  const headers: Record<string, string> = {
    Accept: 'text/plain, text/markdown, */*',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  try {
    const res = await httpGetText(rawUrl, { fetchImpl, headers });
    if (!res.ok || typeof res.text !== 'string') {
      return {
        success: false,
        skillName: path.basename(skillDirInRepo) || repo,
        error: `Failed to fetch SKILL.md from ${rawUrl}: status ${res.status || 'not found'}`,
      };
    }

    const skillInfo = parseSkillMdContent(path.join(skillDirInRepo, 'SKILL.md'), res.text);
    const candidateName = skillInfo.name || path.basename(skillDirInRepo) || repo;
    const slug = safeSkillSlug(candidateName);
    if (!slug) {
      return {
        success: false,
        skillName: candidateName,
        error: `Invalid skill name: "${candidateName}". Must be a valid slug.`,
      };
    }

    fs.mkdirSync(targetDir, { recursive: true });
    const destSkillDir = resolveWithin(targetDir, slug);
    if (!destSkillDir) {
      return {
        success: false,
        skillName: slug,
        error: `Target path for skill "${slug}" escapes target directory.`,
      };
    }

    if (fs.existsSync(destSkillDir) && !overwrite) {
      return {
        success: false,
        skillName: slug,
        error: `Skill directory already exists at ${destSkillDir} and overwrite is disabled.`,
      };
    }

    fs.mkdirSync(destSkillDir, { recursive: true });
    const destSkillFile = path.join(destSkillDir, 'SKILL.md');
    fs.writeFileSync(destSkillFile, res.text, 'utf8');

    return {
      success: true,
      skillName: slug,
      installedPath: destSkillFile,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      skillName: path.basename(skillDirInRepo) || repo,
      error: `Error installing skill: ${msg}`,
    };
  }
}

export async function loadSkillPromptFromRepo(options: {
  repoUrl: string;
  skillName?: string;
  workspaceDir?: string;
  targetSkillsDir?: string;
  overwrite?: boolean;
  fetchImpl?: FetchLike;
  token?: string;
}): Promise<LoadSkillPromptResult> {
  const parsed = parseGitHubRepoUrl(options.repoUrl);
  if (!parsed) {
    return { success: false, error: `Invalid GitHub repository URL: "${options.repoUrl}".` };
  }

  const source = new RemoteRepoSource({ fetchImpl: options.fetchImpl, token: options.token });
  const treeRes = await source.indexTree(parsed.owner, parsed.repo, 'main');
  if (!treeRes.success) {
    return { success: false, error: `Failed to inspect repository tree: ${treeRes.error}` };
  }

  const skillPaths = discoverSkillsInTree(treeRes.descriptors);
  const readmeDesc = treeRes.descriptors.find(d => /^readme\.md$/i.test(path.basename(d.path)));

  let readmeSkills: DiscoveredSkill[] = [];
  if (readmeDesc) {
    const readmeUrl = `https://raw.githubusercontent.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${encodeURIComponent(treeRes.commitSha)}/${readmeDesc.path}`;
    const headers: Record<string, string> = {
      Accept: 'text/plain, text/markdown, */*',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    };
    const res = await httpGetText(readmeUrl, { fetchImpl: options.fetchImpl, headers });
    if (res.ok && typeof res.text === 'string') {
      readmeSkills = parseReadmeSkills(res.text);
    }
  }

  if (skillPaths.length === 0) {
    if (readmeSkills.length > 0) {
      return {
        success: true,
        skills: readmeSkills.map(s => ({ name: s.name, description: s.description })),
        message: `Discovered ${readmeSkills.length} skills from repository README.`,
      };
    }
    return { success: false, error: `No SKILL.md found in repository "${parsed.owner}/${parsed.repo}".` };
  }

  const discovered: Array<{ name: string; description: string; path?: string }> = [];
  for (const p of skillPaths) {
    let sName = path.basename(path.dirname(p));
    if (sName === '.' || !sName || sName === 'skills') {
      sName = parsed.repo;
    }
    const desc = readmeSkills.find(r => r.name.toLowerCase() === sName.toLowerCase())?.description || '';
    discovered.push({ name: sName, description: desc, path: p });
  }
  for (const r of readmeSkills) {
    if (!discovered.some(d => d.name.toLowerCase() === r.name.toLowerCase())) {
      discovered.push({ name: r.name, description: r.description, path: r.path });
    }
  }

  let chosenPath: string;
  if (options.skillName) {
    const target = options.skillName.toLowerCase();
    const matched = skillPaths.find(p => {
      const sName = path.basename(path.dirname(p)).toLowerCase();
      return sName === target || p.toLowerCase().includes(target);
    });
    if (!matched) {
      return {
        success: false,
        error: `Skill "${options.skillName}" was not found in repository "${parsed.owner}/${parsed.repo}". Available skills: ${discovered.map(s => s.name).join(', ')}`,
      };
    }
    chosenPath = matched;
  } else {
    const repoMatch = skillPaths.find(p => p.toLowerCase().includes(`skills/${parsed.repo.toLowerCase()}`));
    chosenPath = repoMatch || skillPaths[0];
  }

  const targetDir = options.targetSkillsDir || (options.workspaceDir ? path.join(options.workspaceDir, 'skills') : path.join(process.cwd(), 'skills'));

  const installRes = await installRepoSkill({
    owner: parsed.owner,
    repo: parsed.repo,
    ref: treeRes.commitSha,
    skillSubpath: chosenPath,
    targetDir,
    overwrite: options.overwrite ?? true,
    fetchImpl: options.fetchImpl,
    token: options.token,
  });

  if (!installRes.success || !installRes.installedPath) {
    return { success: false, error: installRes.error };
  }

  const promptContent = fs.readFileSync(installRes.installedPath, 'utf8');
  const meta = parseSkillMdContent(chosenPath, promptContent);

  return {
    success: true,
    skill: meta.name,
    description: meta.description,
    prompt: promptContent,
    skills: discovered.map(s => ({ name: s.name, description: s.description })),
  };
}
