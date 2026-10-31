#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

const OKAPI_URL = 'https://okapi.bot/go/awesome-free-llm-apis';

const HEADER = `<h1 align="center">
\t<a href="https://github.com/mnfst/awesome-free-llm-apis">
\t\t<img src="media/awesome-free-llm-apis.png" width="500" alt="Awesome Free LLM APIs">
\t</a>
</h1>

<p align="center">
\t<a href="https://awesome.re">
\t\t<img src="https://awesome.re/badge-flat2.svg" alt="Awesome">
\t</a>
</p>

<p align="center">LLM APIs with permanent free tiers for text inference.</p>

<p align="center"><sub>All endpoints are OpenAI SDK-compatible unless noted. Each link points to the provider's API key page.</sub></p>

<p align="center"><sub>All of those free LLM APIs are available at <a href="https://manifest.build">manifest.build</a> - make reliable agents.</sub></p>

<hr>

<h3 align="center">Sponsors</h3>

<p align="center">
\t<a href="${OKAPI_URL}">
\t\t<picture>
\t\t\t<source media="(prefers-color-scheme: dark)" srcset="media/okapi-logo-dark.svg">
\t\t\t<img src="media/okapi-logo-light.svg" width="180" alt="Okapi">
\t\t</picture>
\t</a>
\t<br>
\t<sub>Free API watcher. No more breaking changes.</sub>
</p>

<hr>`;

function alignTable(header, rows) {
	const widths = header.map((cell, i) => {
		const longestRow = rows.reduce((max, row) => Math.max(max, row[i].length), 0);
		return Math.max(cell.length, longestRow, 3);
	});
	const pad = (cell, i) => cell + ' '.repeat(widths[i] - cell.length);
	const formatRow = cells => `| ${cells.map(pad).join(' | ')} |`;
	const separator = `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`;
	return [formatRow(header), separator, ...rows.map(formatRow)].join('\n');
}

function formatModelName(name) {
	return /[/:]/.test(name) ? `\`${name}\`` : name;
}

function buildTable(models) {
	const header = ['Model Name', 'Context', 'Max Output', 'Modality', 'Rate Limit'];
	const rows = models.map(m => [formatModelName(m.name), m.context, m.maxOutput, m.modality, m.rateLimit]);
	return alignTable(header, rows);
}

function buildProviderSection(provider) {
	const desc = provider.footnoteRef != null
		? `${provider.description} [^${provider.footnoteRef}]`
		: provider.description;
	const parts = [
		`### [${provider.name}](${provider.url}) ${provider.flag}`,
		'',
		desc,
	];
	if (provider.baseUrl != null) {
		parts.push('', `Base URL: \`${provider.baseUrl}\``);
	}
	parts.push('', buildTable(provider.models));
	return parts.join('\n');
}

const providerAPIs = data.providers
	.filter(p => p.category === 'provider_api')
	.sort((a, b) => a.name.localeCompare(b.name));

const inferenceProviders = data.providers
	.filter(p => p.category === 'inference_provider')
	.sort((a, b) => a.name.localeCompare(b.name));

const glossaryTable = alignTable(
	['Abbreviation', 'Meaning'],
	data.glossary.map(g => [`**${g.abbreviation}**`, g.meaning]),
);

const footnoteLines = data.footnotes
	.sort((a, b) => a.id - b.id)
	.map(f => `[^${f.id}]: ${f.text}`)
	.join('\n');

const mcpServerSection = [
	'### 🚀 Integrated MCP Server',
	'',
	'The [`mcp-server`](mcp-server/) directory contains an enterprise-grade MCP server (`@mcp:free-llm-apis`) exposing 15 zero-cost tools:',
	'- **Universal Chat Pipeline (`use_free_llm`)**: Deterministic quantum-inspired model routing across 70+ free models with automatic failover and background DAG subtask execution.',
	'- **Search Grounding (`SearchRouterMiddleware`)**: Free multi-provider web search fallback (`Parallel AI` &rarr; `TinyFish` &rarr; `Tavily` &rarr; `DuckDuckGo MCP` &rarr; `Jina AI` &rarr; `SearXNG`) with persistent circuit breaker tracking.',
	'- **Autonomous Multi-Agent Harness (`agent_harness`)**: Declarative agent workflows, file ownership locks, reasoning scope isolation, and human-in-the-loop approvals.',
	'- **Persistent Workspace Memory & Wiki (`manage_memory`)**: Content-addressed vector storage, automatic ADR harvesting, and persistent health tracking rooted to your project workspace.',
	'- **Refactoring & Diagnostics**: OMP-style multi-file refactoring (`coding_agents`), offline local model patching (`local_llm_patch`), multi-hypothesis reasoning (`quantum_tool`), real browser automation (`browser_tool`), and visual UI regression testing (`vision_tool`).',
	'',
	'> [!TIP]',
	'> To enable full agentic capabilities in your IDE (Claude Desktop, Cursor, Windsurf), follow the [MCP Setup Guide](mcp-server/docs/setup.md) and [Client Configurations](mcp-server/README.md#client-configurations).',
].join('\n');

const parts = [
	HEADER,
	'',
	'## Contents',
	'',
	'- [Integrated MCP Server](#-integrated-mcp-server)',
	'- [Provider APIs](#provider-apis)',
	'- [Inference providers](#inference-providers)',
	'- [Glossary](#glossary)',
	'',
	mcpServerSection,
	'',
	'## Provider APIs',
	'',
	'APIs run by the companies that train or fine-tune the models themselves.',
	'',
	providerAPIs.map(buildProviderSection).join('\n\n'),
	'',
	'## Inference providers',
	'',
	'Third-party platforms that host open-weight models from various sources.',
	'',
	inferenceProviders.map(buildProviderSection).join('\n\n'),
	'',
	'## Glossary',
	'',
	glossaryTable,
	'',
	'## Contributing',
	'',
	'Know a free tier that\'s missing? [Open a PR](contributing.md). Include the provider, endpoint, rate limits (link to their docs), and a few notable models. Trial credits and time-limited promos don\'t count.',
	'',
	footnoteLines,
	'',
];

const output = parts.join('\n');
fs.writeFileSync(path.join(ROOT, 'README.md'), output);
console.log('README.md generated successfully.');
