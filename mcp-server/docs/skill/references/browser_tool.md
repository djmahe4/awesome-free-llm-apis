# `browser_tool`

**Purpose:** Automate browser workflows end-to-end via headless Chrome DevTools — page navigation, interactive DOM clicking, private API discovery & replay, tabular data extraction, and anti-bot bypass.

---

## 🎯 When to Use
- **Interactive Web Exploration**: Navigating dynamic JavaScript SPAs, handling multi-step flows, clicking tabs/drawers.
- **Private API Discovery & Replay**: Capturing authenticated XHR/Fetch network responses and replaying them directly.
- **Strict Tabular / Structured Scraping**: Extracting tables, lists, and metadata without LLM hallucination.
- **Session Checkpointing**: Saving browser state to pause, resume, or restore exploration tasks later.

---

## ⚡ Subcommands & Actions Reference

| Action | Required Params | Optional Params | Description |
|---|---|---|---|
| `navigate` | `url` | `sessionId`, `waitFor` | Navigates to target URL and waits for network idle or DOM selector. |
| `snapshot` | — | `sessionId`, `includeHtml` | Captures DOM tree with structural diffing against prior snapshot. |
| `click` | `selector` \| `text` | `sessionId`, `waitFor` | Clicks an interactive element, button, or link and computes DOM delta. |
| `scroll` | — | `direction`, `pixels`, `selector` | Scrolls window or specific container down, up, or into view. |
| `wait` | — | `timeoutMs`, `until` | Waits for fixed duration, selector existence, or `dom-stable`. |
| `evaluate` | `script` | `sessionId` | Evaluates JavaScript in the active page context and returns raw result. |
| `network` | — | `sessionId`, `filter` | Lists captured network requests, status codes, request bodies, and headers. |
| `api_replay` | `endpointPattern` | `sessionId` | Intercepts private internal APIs and replays them with session cookies. |
| `extract` | `userInstructions` | `sessionId`, `format` | Extracts structured JSON schema from current DOM without hallucinations. |
| `deep_scrape` | `url`, `userInstructions` | `depth`, `maxPages` | Recursively explores internal links and compiles multi-page datasets. |
| `checkpoint` | `action: 'save' \| 'load'` | `sessionId`, `name` | Persists or restores cookies, localStorage, and navigation state. |
| `screenshot` | — | `sessionId`, `fullPage` | Captures high-res visual PNG screenshot for VLM / multimodal analysis. |

---

## 🛠️ Invocation Examples

### 1. Interactive Tab Click & Network Intercept
```json
{
  "action": "click",
  "text": "Lineups",
  "sessionId": "sports-scrape-1"
}
```

### 2. Extract Structured Data
```json
{
  "action": "extract",
  "userInstructions": "Extract all player names, shirt numbers, positions, and match ratings into a table.",
  "sessionId": "sports-scrape-1"
}
```

### 3. Replay Authenticated Backend API
```json
{
  "action": "api_replay",
  "endpointPattern": "/api/v1/event/*/lineups",
  "sessionId": "sports-scrape-1"
}
```

