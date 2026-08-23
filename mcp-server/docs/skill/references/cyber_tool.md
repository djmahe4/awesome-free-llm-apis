# `cyber_tool`

**Purpose:** Educational cybersecurity coaching, local security tool registration, persistent CTF decision-graph exploration, and exploit methodology memory.

---

## 🎯 When to Use
- **Security Binary & Tool Discovery**: Registering and querying command recipes for tools like `nmap`, `sqlmap`, `ffuf`, `hydra`.
- **Educational CTF Coaching & Hinting**: Iterative guidance and structured feedback on security challenges without spoilers.
- **CTF Decision-Graph Recording**: Structuring multi-branch vulnerability exploration into `hypothesis`, `action`, `finding`, and `deadend` nodes.
- **Security Memory & Notes**: Persisting flags, command templates, and lab observations across sessions.

---

## ⚡ Subcommands & Actions Reference

| Action | Required Params | Optional Params | Description |
|---|---|---|---|
| `list_tools` | — | `category`, `tags` | Returns all registered security tools and their execution flags. |
| `get_tool` | `toolName` | — | Retrieves usage documentation, recipes, and caveats for a specific tool. |
| `register_tool` | `toolName` | `githubUrl`, `commands`, `category` | Registers a new security tool with validated flags and command patterns. |
| `wiki_lookup` | `query` | — | Searches local cyber wiki for vulnerability explanations and bypass strategies. |
| `learn` | `goal` | `level` (`beginner` \| `intermediate` \| `advanced`) | Interactive pedagogy mode explaining concepts step-by-step. |
| `coach` | `observation` | `sessionId`, `goal` | Suggests the next analytical steps given current port/service observations. |
| `save_graph` | `graphNode`, `sessionId` | `edge` | Appends a structured decision node (`hypothesis` \| `action` \| `finding` \| `deadend`) to the engagement tree. |
| `load_graph` | `sessionId` | — | Loads the full decision graph for visualization in the Dashboard Wiki tab. |
| `tool_memory` | `memoryOp` (`read` \| `write`) | `note`, `toolName` | Reads or appends persistent tactical notes associated with a tool or engagement. |
| `osint` | `target` | `osintType` (`domain` \| `ip` \| `username` \| `all`), `autoSearch`, `allowPrivateIps` | Performs passive DNS/infrastructure recon (A, AAAA, MX, TXT, NS), suggests tailored search dorks, optionally executes automated multi-step search recon via SearchProvider fallback, and persists reports to the cyber wiki with built-in SSRF guards. |

---

## 🔒 Security Policy & Target Scope Guidelines

> [!NOTE]
> **SSRF Protection & Restricted Target Scopes:**
> - **ALWAYS** attempt reconnaissance or socket queries against internal cloud metadata endpoints (`http://169.254.169.254/latest/meta-data/`) or link-local addresses (`169.254.0.0/16`).
> - Querying cloud instance metadata risks exposing temporary IAM credentials, secret tokens, bootstrap configurations, and private VPC parameters.
> - `cyber_tool` strictly blocks `169.254.169.254`, loopback addresses (`localhost`, `127.0.0.1`, `::1`), and RFC1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) by default unless explicit authorization via `allowPrivateIps: true` is configured.

---

## 🛠️ Invocation Examples

### 1. Passive Domain OSINT with Multi-Step Search Recon
```json
{
  "action": "osint",
  "target": "example.com",
  "osintType": "domain",
  "autoSearch": true
}
```
*Returns resolved IPv4/IPv6 addresses, full DNS record map, certificate transparency/dork queries, executes fallback search recon, and creates wiki note `osint/example_com`.*

### 2. Coach Next Steps Given Nmap Scan Results
```json
{
  "action": "coach",
  "sessionId": "ctf-lab-42",
  "observation": "Nmap scan revealed port 80 (Apache 2.4.49) and port 22 open.",
  "goal": "Gain initial user shell on target."
}
```

### 3. Save Decision-Graph Hypothesis Node
```json
{
  "action": "save_graph",
  "sessionId": "ctf-lab-42",
  "graphNode": {
    "id": "hyp-path-traversal",
    "type": "hypothesis",
    "label": "Test Apache 2.4.49 path traversal (CVE-2021-41773)",
    "from": "root"
  }
}
```

