# `reverse_tool` [v1.1.2]

**Purpose:** Reverse engineering analysis engine, remote GitHub asset recognizer, and static artifact forensics inspector. Supports static JavaScript/TypeScript AST extraction, binary/archive artifact forensics, evidence tracking with cryptographic SHA-256 validation, remote GitHub repo recon (releases, AST symbols, call flows, wiki generation), and bridge proxying to local/external reverse engineering agent engines (REA).

## Tool Schema

```typescript
interface ReverseToolInput {
  action: 'status' | 'list_capabilities' | 'analyze_javascript' | 'analyze_artifact' | 'get_evidence' | 'scan_github';
  target?: string;                  // Target file path, evidence ID (ev-*), or GitHub repo ("owner/repo")
  authorization?: 'ctf' | 'lab' | 'consent'; // Explicit authorization framing
  options?: {
    ref?: string;                   // Branch, tag, or commit SHA (default: repo default)
    limit?: number;                 // Maximum files or assets to inspect
    query?: string;                 // Symbol or path search filter
    storageDir?: string;            // Directory for persisting downloaded assets or wiki markdown
    workspaceRoot?: string;
    reaAgentsPath?: string;
    [key: string]: unknown;
  };
}

interface ReverseToolResult {
  success: boolean;
  action: string;
  target?: string;
  data?: unknown;
  evidence?: ReverseEvidence;
  error?: string;
}
```

## Actions

| Action | Required Fields | Optional Fields | Description |
|---|---|---|---|
| `status` | none | none | Checks Node.js runtime compatibility (`>= 22.19`, rejecting 23/25) and REA engine status. |
| `list_capabilities` | none (if target omitted) | `target`, `authorization` | Lists static and engine analysis capabilities. Target requires valid authorization. |
| `analyze_javascript` | `target`, `authorization` | `options` | Parses JS/TS AST for crypto calls, network fetches, obfuscation, eval, and secret patterns. |
| `analyze_artifact` | `target`, `authorization` | `options` | Inspects binary, ELF, PE, archive, or model files for entropy, strings, and suspicious headers. |
| `get_evidence` | `target`, `authorization` | none | Retrieves previously stored evidence file and findings by evidence ID. |
| `scan_github` | `target`, `authorization` | `options` (`ref`, `limit`, `query`, `storageDir`) | Discovers remote GitHub repo releases, classifies candidate binary/firmware/model assets, indexes source AST symbols/call flows on demand, and generates structured wiki docs. |

## GitHub Recon (`scan_github`) Output Structure

When executing `action: 'scan_github'`, the response payload includes:

```typescript
interface ReverseScanGithubData {
  owner: string;
  repo: string;
  commitSha: string;
  releaseAssets: Array<{
    id: number;
    name: string;
    size: number;
    content_type: string;
    browser_download_url: string;
    category: 'binary_native' | 'asar' | 'ai_model' | 'firmware' | 'archive' | 'unknown';
    candidateForAnalyzeArtifact: boolean;
  }>;
  skills: DiscoveredSkill[];
  symbols: Array<{
    name: string;
    kind: 'function' | 'class' | 'interface' | 'variable';
    filePath: string;
    line?: number;
  }>;
  callFlows: Array<{
    caller: string;
    callee: string;
    filePath: string;
  }>;
  wikiMarkdown: string;
  descriptors: Array<{
    path: string;
    type: string;
    size: number;
    category?: string;
  }>;
  readmeExcerpt?: string;
}
```

- **`commitSha`**: Exact commit SHA indexed from the remote git tree.
- **`releaseAssets`**: GitHub releases and categorised release binary/ASAR/model downloads.
- **`descriptors`**: Flat repo tree metadata without downloading repository archives.
- **`symbols` & `callFlows`**: AST symbols and inter-function call flows resolved on-demand.
- **`wikiMarkdown`**: Curated architecture, security overview, and discovered capabilities ready for memory store.
- **`evidence`**: Cryptographic evidence bundle generated for the GitHub scan.

## Authorization Contract

To ensure security compliance, deep target inspection requires explicit framing:
- **Accepted values:** `'ctf'` (capture the flag competitions), `'lab'` (controlled lab environment), `'consent'` (explicit owner/developer consent).
- If `action` is `analyze_javascript`, `analyze_artifact`, `get_evidence`, or `scan_github` and `authorization` is missing or not in `['ctf', 'lab', 'consent']`, the tool returns:
  `{ success: false, error: 'Target analysis requires authorization framing: "ctf" | "lab" | "consent".' }`.
- In `list_capabilities`, if `target` is provided without `authorization`, the same authorization framing error is returned.

## Evidence Contract

Every analysis generates a standardized `ReverseEvidence` object:
- `id`: Unique identifier formatted as `ev-<timestamp>-<hash>`.
- `target`: Resolved target path.
- `sha256`: Cryptographic digest of target file.
- `findings`: Array of identified risks, suspicious indicators, or structural elements.
- `created_at`: ISO timestamp of collection.
- `metadata`: Environmental options and runtime provenance.

Evidence records are persisted to `.free-llm-mcp/evidence/` or session cache and can be retrieved using `action: 'get_evidence'`.

## Error States

- **Node.js Incompatibility**: Returns warning/failure status if Node version `< 22.19` or is experimental `23.x` / `25.x`.
- **Missing Target**: Returns `{ success: false, error: 'Target is required.' }` when target is omitted for analysis actions.
- **Missing / Invalid Authorization**: Returns authorization framing error.
- **Target Not Found**: Returns `{ success: false, error: 'Target file not found: <path>' }`.
- **Invalid Evidence ID**: Returns `{ success: false, error: 'Evidence ID not found: <id>' }`.
- **Invalid GitHub Target**: Returns error if target is not `owner/repo` or valid GitHub URL.
- **GitHub Rate Limit**: Returns `{ success: false, error: 'GitHub API quota exhausted or rate limit hit. Provide a valid GITHUB_TOKEN.' }`.
