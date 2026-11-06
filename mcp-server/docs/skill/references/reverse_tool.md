# `reverse_tool` [v1.1.2]

**Purpose:** Reverse engineering analysis engine and static artifact forensics inspector. Supports static JavaScript/TypeScript AST extraction, binary/archive artifact forensics, evidence tracking with cryptographic SHA-256 validation, and bridge proxying to local/external reverse engineering agent engines (REA).

## Tool Schema

```typescript
interface ReverseToolInput {
  action: 'status' | 'list_capabilities' | 'analyze_javascript' | 'analyze_artifact' | 'get_evidence';
  target?: string;                  // Target file path or evidence ID (ev-*)
  authorization?: 'ctf' | 'lab' | 'consent'; // Explicit authorization framing
  options?: {
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

## Authorization Contract

To ensure security compliance, deep target inspection requires explicit framing:
- **Accepted values:** `'ctf'` (capture the flag competitions), `'lab'` (controlled lab environment), `'consent'` (explicit owner/developer consent).
- If `action` is `analyze_javascript`, `analyze_artifact`, or `get_evidence` and `authorization` is missing or not in `['ctf', 'lab', 'consent']`, the tool returns:
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
