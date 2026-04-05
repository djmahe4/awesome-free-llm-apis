# Agentic Prompt Injection System

The Agentic Middleware uses an intelligent prompt injection system to dynamically assemble the most relevant system prompt for a given task. Instead of sending a static, monolithic prompt, it selects sections from a categorized reference map based on the user's intent.

## Architecture

The system relies on a three-tier data hierarchy:
1. **`README.md` (Canonical Source)**: The human-readable source of truth for all prompt sections and reference maps.
2. **`prompt.json` (Indexed Cache)**: A structured JSON file generated from the README (via `scripts/update_prompt_json.py`) that includes pre-tokenized keywords for fast scoring.
3. **`prompts.ts` (Execution Engine)**: The TypeScript middleware that scores, selects, and compresses these sections into a final prompt.

## Scoring Mechanism

The engine calculates a relevance score for each section using the following rules:

| Factor | Score | Description |
| :--- | :--- | :--- |
| **Title Match** | +5.0 per word | Direct matches between query tokens and the section's title. |
| **Keyword Match** | +3.0 per word | Matches against the predefined `keywords` list in `prompt.json`. |
| **Technical Context** | +1.0 per word | Substring matches for longer keywords (length > 4) found in the context. |
| **Architectural Bias** | +4.0 | Applied to reference sections when architectural terms (e.g., `API`, `Python`, `Review`) are detected. |
| **Criticality Bias** | +2.0 | Applied to Level 1 (mandatory/foundational) sections. |

### Strict vs Fuzzy Steering
- **Fuzzy Fallback**: If no keywords are explicitly provided, the engine tokenizes the user's request into a set of search terms.
- **Strict Steering**: If the developer provides an explicit `keywords` array, the fuzzy tokenizer is bypassed, ensuring absolute control over which documentation is injected.

## Reference Selection & Compression

To prevent the system prompt from becoming too large (exceeding the `PROMPT_CHAR_BUDGET` of 25,000 characters), large reference maps are intelligently compressed:

1. **Category-Aware Splitting**: The engine splits massive sections by category headers.
2. **Entry-Level Scoring**: Individual links within a category are scored based on their description and the header they belong to.
3. **Diversity Budget**: The engine selects the top 15 most relevant entries per reference section.
4. **Dynamic Thresholds**: If a section's overall score is very high (e.g., > 8), the engine relaxes the entry-level requirements to provide a broader range of matches.

## The Suggestion Protocol

When reference sections are injected, the system automatically appends the `REFERENCE_SUGGESTION_PROTOCOL`. This forces the LLM to:
1. Provide direct URLs for any patterns it mentions.
2. Justify why a specific implementation pattern from the reference map was chosen.
3. Follow a standardized markdown format for citations.

## Caching and Performance

- **Cache Invalidation**: The system monitors the `mtime` (last modified time) of `prompt.json`. If the file is updated (e.g., by a post-build script), the engine automatically flushes its in-memory cache.
- **Budgeting**: If the sum of relevant sections exceeds the character budget, sections are added in descending order of score until the limit is reached, ensuring the most critical context is always preserved.

## Post-Build Synchronization

The system is designed to be highly maintainable. Developers should only edit the `README.md`. The `prompt.json` is automatically updated during the build process:

```bash
npm run build
```

This triggers `scripts/postbuild.js`, which runs a Python utility (`update_prompt_json.py`) to re-index the README content and keywords.
