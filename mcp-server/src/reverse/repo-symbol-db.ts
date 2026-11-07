import fs from 'node:fs';
import path from 'node:path';
import { getMcpDir } from '../utils/mcp-home.js';
import type { GitHubReleaseAsset } from './github-releases.js';

export interface RepoSymbolItem {
  name: string;
  kind: string;
  line: number;
  filePath: string;
}

export interface RepoKnowledgeRecord {
  owner: string;
  repo: string;
  commitSha: string;
  indexedAt: string;
  readmeClaims?: string[];
  symbols: RepoSymbolItem[];
  callFlows: string[];
  manifests: string[];
  dependencies: Array<{ name: string; spec?: string }>;
  releaseAssets: GitHubReleaseAsset[];
}

export class RepoSymbolDb {
  private readonly storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir || path.join(getMcpDir(), 'repos');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private recordFile(owner: string, repo: string, commitSha: string): string {
    const sanitized = `${owner}_${repo}_${commitSha}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const filePath = path.join(this.storageDir, `${sanitized}.json`);
    if (!path.resolve(filePath).startsWith(path.resolve(this.storageDir))) {
      throw new Error(`Invalid record path: ${filePath}`);
    }
    return filePath;
  }

  saveRecord(record: RepoKnowledgeRecord): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    const filePath = this.recordFile(record.owner, record.repo, record.commitSha);
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  getRecord(owner: string, repo: string, commitSha: string): RepoKnowledgeRecord | null {
    const filePath = this.recordFile(owner, repo, commitSha);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as RepoKnowledgeRecord;
      }
      return null;
    } catch {
      return null;
    }
  }

  generateWikiMarkdown(record: RepoKnowledgeRecord): string {
    const manifests = record.manifests || [];
    const dependencies = record.dependencies || [];
    const releaseAssets = record.releaseAssets || [];
    const symbols = record.symbols || [];
    const callFlows = record.callFlows || [];

    const lines: string[] = [
      `# Repository Knowledge: ${record.owner}/${record.repo}`,
      `> Commit SHA: \`${record.commitSha}\` | Indexed: ${record.indexedAt}`,
      '',
      '## Architecture & Structure',
      `- Manifests: ${manifests.join(', ') || 'None found'}`,
      `- Dependencies: ${dependencies.map(d => `${d.name}${d.spec ? `@${d.spec}` : ''}`).join(', ') || 'None'}`,
      `- Release Assets: ${releaseAssets.length} found`,
      '',
      '## Key Grounded Symbols',
    ];

    for (const s of symbols.slice(0, 30)) {
      lines.push(`- \`${s.name}\` [${s.kind}] in \`${s.filePath}:L${s.line}\``);
    }

    if (callFlows.length > 0) {
      lines.push('', '## Call Graphs & Execution Flows');
      for (const flow of callFlows.slice(0, 20)) {
        lines.push(`- \`${flow}\``);
      }
    }

    const warnings: string[] = [];
    const claims = record.readmeClaims || [];
    const depNames = dependencies.map(d => d.name.toLowerCase());

    for (const claim of claims) {
      if (/grpc|protobuf/i.test(claim) && !depNames.some(d => d.includes('grpc') || d.includes('proto'))) {
        warnings.push(`Documentation claims gRPC microservices, but no gRPC dependencies were discovered in manifests.`);
      }
      if (/enclave|hardware/i.test(claim) && symbols.every(s => !/enclave|tpm|sgx/i.test(s.name))) {
        warnings.push(`Documentation claims hardware enclave security, but no matching symbols or bindings exist.`);
      }
    }

    if (warnings.length > 0) {
      lines.push('', '## Anti-BLA Deception / Discrepancy Warnings');
      for (const w of warnings) {
        lines.push(`> [!WARNING] ${w}`);
      }
    }

    return lines.join('\n');
  }
}
