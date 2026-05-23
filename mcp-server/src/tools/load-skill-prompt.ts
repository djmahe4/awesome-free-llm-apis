import fetch from 'node-fetch';

const SKILL_INDEX_URL = 'https://sickn33.github.io/antigravity-awesome-skills/skills.json';
const SKILL_BASE_URL = 'https://sickn33.github.io/antigravity-awesome-skills';

interface SkillIndexEntry {
  id?: string;
  name?: string;
  path?: string;
  description?: string;
  plugin?: {
    setup?: {
      type?: string;
      summary?: string;
      docs?: string | null;
    };
  };
}

export interface LoadSkillPromptInput {
  skill: string;
}

export interface LoadSkillPromptResult {
  success: boolean;
  skill?: string;
  description?: string;
  prompt?: string;
  sourceUrl?: string;
  terminalSetupHint?: string;
  error?: string;
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return await response.text();
}

export async function loadSkillPrompt(input: LoadSkillPromptInput): Promise<LoadSkillPromptResult> {
  const normalized = normalizeSkillName(input.skill || '');
  if (!normalized) {
    return { success: false, error: 'Missing required `skill` parameter.' };
  }

  try {
    const index = await fetchJson<SkillIndexEntry[]>(SKILL_INDEX_URL);
    const found = index.find((entry) => {
      const id = normalizeSkillName(entry.id || '');
      const name = normalizeSkillName(entry.name || '');
      return id === normalized || name === normalized || id.includes(normalized) || name.includes(normalized);
    });

    if (!found || !found.path) {
      return { success: false, error: `Skill '${input.skill}' was not found in the remote skills index.` };
    }

    const skillMdUrl = `${SKILL_BASE_URL}/${found.path.replace(/^\/+/, '')}/SKILL.md`;
    const prompt = await fetchText(skillMdUrl);
    const setupType = found.plugin?.setup?.type?.toLowerCase();
    const setupSummary = found.plugin?.setup?.summary?.trim();
    const setupDocs = found.plugin?.setup?.docs?.trim() || '';
    const terminalSetupHint = setupType === 'terminal'
      ? `This skill declares terminal setup. ${setupSummary || ''} ${setupDocs}`.trim()
      : undefined;

    return {
      success: true,
      skill: found.id || found.name || input.skill,
      description: found.description,
      prompt,
      sourceUrl: skillMdUrl,
      terminalSetupHint
    };
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || 'Unknown error while loading skill prompt.'
    };
  }
}

