#!/usr/bin/env node
'use strict';

// Checks that every fact of data.json still has its proof on an official page.
// sources.json maps each fact to a page and a short quote copied from that page.
// The script opens each page once, looks for each quote, opens every link that
// data.json shows to readers, and compares the public model catalogs with data.json.
// It uses no model and no API key.
//
// Usage: node scripts/check-sources.js --out <report.json> [--previous <report.json>]
//          [--sources <sources.json>] [--strict]
//   --previous  yesterday's report: a page error or a broken link counts only on the
//               second day in a row
//   --sources   another knowledge base file (default: sources.json at the repository root)
//   --strict      exit 1 when a sourced fact is not OK or a link answers 404 or 410
//                 (CI runs this on PRs that change sources.json)
//   --consistent  exit 1 only when data.json and sources.json disagree (VALUE_DRIFT or
//                 ROW_GONE). These depend on the files alone, never on a page being up.
//                 (CI runs this on PRs that change data.json only)

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const args = process.argv.slice(2);
const getArg = flag => {
	const i = args.indexOf(flag);
	return i === -1 ? null : args[i + 1];
};
const outFile = getArg('--out');
const previousFile = getArg('--previous');
const sourcesFile = getArg('--sources');
const strict = args.includes('--strict');
const consistent = args.includes('--consistent');
if (!outFile) {
	console.error('Usage: node scripts/check-sources.js --out <report.json> [--previous <report.json>] [--sources <sources.json>] [--strict]');
	process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const base = JSON.parse(fs.readFileSync(sourcesFile || path.join(ROOT, 'sources.json'), 'utf8'));
const previous = previousFile && fs.existsSync(previousFile)
	? JSON.parse(fs.readFileSync(previousFile, 'utf8'))
	: null;

// A page whose text is shorter than this is a JavaScript shell, not a document.
const MIN_TEXT_CHARS = 400;
const TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Facts that data.json states, one key per fact
// ---------------------------------------------------------------------------
const MODEL_FACTS = ['listed', 'context', 'maxOutput', 'modality', 'rateLimit'];
const factKey = (provider, model, fact) => `${provider}|${model || ''}|${fact}`;

function currentValue(provider, model, fact) {
	const p = data.providers.find(x => x.name === provider);
	if (!p) return undefined;
	if (!model) return fact === 'freeTier' ? p.description : undefined;
	const m = p.models.find(x => x.id === model);
	if (!m) return undefined;
	return fact === 'listed' ? 'yes' : m[fact];
}

function allFacts() {
	const facts = [];
	for (const p of data.providers) {
		facts.push(factKey(p.name, null, 'freeTier'));
		for (const m of p.models) {
			if (m.id === null) continue;
			for (const f of MODEL_FACTS) facts.push(factKey(p.name, m.id, f));
		}
	}
	return facts;
}

// ---------------------------------------------------------------------------
// Links that data.json shows to readers: each provider page, and every link in a
// description or a footnote. Base URLs are API endpoints, not pages, so they are left out.
// ---------------------------------------------------------------------------
function allLinks() {
	const links = new Map();
	// An API root such as https://ollama.com/v1 is an endpoint, not a page. It is
	// skipped only on the host of a provider's base URL.
	const apiHosts = new Set(data.providers.filter(p => p.baseUrl).map(p => new URL(p.baseUrl).host));
	const add = (url, where) => {
		const clean = url.replace(/[).,;]+$/, '');
		let u;
		try {
			u = new URL(clean);
		} catch {
			return;
		}
		if (apiHosts.has(u.host) && /^\/(api\/)?v\d+\/?$/.test(u.pathname)) return;
		if (!links.has(clean)) links.set(clean, []);
		links.get(clean).push(where);
	};
	const scan = (text, where) => {
		for (const m of (text || '').matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) add(m[0], where);
	};
	for (const p of data.providers) {
		add(p.url, `${p.name} url`);
		scan(p.description, `${p.name} description`);
	}
	for (const f of data.footnotes) scan(f.text, `footnote ${f.id}`);
	return [...links].map(([url, where]) => ({ url, where }));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function get(url, redirects = 5) {
	return new Promise(resolve => {
		let u;
		try {
			u = new URL(url);
		} catch {
			return resolve({ status: 0, body: '', error: 'bad url' });
		}
		const lib = u.protocol === 'http:' ? http : https;
		const req = lib.get(u, {
			headers: {
				'User-Agent': 'awesome-free-llm-apis source check (+https://github.com/mnfst/awesome-free-llm-apis)',
				Accept: 'text/markdown, text/plain, text/html, application/json;q=0.9, */*;q=0.5',
				// Some docs sites pick a language from this header. The quotes are in English.
				'Accept-Language': 'en',
			},
			timeout: TIMEOUT_MS,
		}, res => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
				res.resume();
				return resolve(get(new URL(res.headers.location, u).toString(), redirects - 1));
			}
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('timeout', () => req.destroy(new Error('timeout')));
		req.on('error', err => resolve({ status: 0, body: '', error: err.message }));
	});
}

// Same normalization for the page and the quote, so a match ignores markup,
// case, and spacing.
function normalize(text) {
	return text
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[*_`|#>]/g, ' ')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

// ---------------------------------------------------------------------------
// Catalogs: the public model lists of some providers
// ---------------------------------------------------------------------------
const CATALOG_IDS = {
	openrouter: json => (json.data || []).map(m => m.id),
	ollama: json => (json.models || []).map(m => m.name || m.model),
	openai: json => (json.data || []).map(m => m.id),
};
const CATALOG_FREE = {
	openrouter: id => id.endsWith(':free'),
};

// A catalog id matches a data.json id when it is the same or adds a tag
// ("gpt-oss:20b" matches "gpt-oss:20b-cloud").
const sameModel = (catalogId, id) =>
	catalogId === id || catalogId.startsWith(`${id}:`) || catalogId.startsWith(`${id}-`);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function run() {
	const sources = base.sources || [];
	const catalogs = base.catalogs || [];

	const pages = {};
	for (const url of [...new Set(sources.map(s => s.url))]) {
		const res = await get(url);
		const text = res.status === 200 ? normalize(res.body) : '';
		let state = 'OK';
		if (res.status !== 200) state = 'PAGE_ERROR';
		else if (text.length < MIN_TEXT_CHARS) state = 'PAGE_EMPTY';
		pages[url] = { url, httpStatus: res.status, chars: text.length, state, text, error: res.error || null };
	}

	const prevFacts = new Map((previous?.facts || []).map(f => [factKey(f.provider, f.model, f.fact), f]));
	const facts = sources.map(s => {
		const page = pages[s.url];
		const value = currentValue(s.provider, s.model, s.fact);
		let state;
		if (value === undefined) state = 'ROW_GONE';
		else if (value !== s.value) state = 'VALUE_DRIFT';
		else if (page.state !== 'OK') state = page.state;
		else if (!page.text.includes(normalize(s.quote))) state = 'QUOTE_MISSING';
		else state = 'OK';

		// A page error is often a one-day outage. It needs two days in a row.
		// A JavaScript page is reported as unverifiable, never as an alert.
		const prev = prevFacts.get(factKey(s.provider, s.model, s.fact));
		let signal = !['OK', 'PAGE_EMPTY'].includes(state);
		if (state === 'PAGE_ERROR') signal = prev?.state === 'PAGE_ERROR';

		return {
			provider: s.provider,
			model: s.model || null,
			fact: s.fact,
			value: s.value,
			current: value === undefined ? null : value,
			url: s.url,
			quote: s.quote,
			state,
			signal,
		};
	});

	const catalogResults = [];
	for (const c of catalogs) {
		const res = await get(c.url);
		const p = data.providers.find(x => x.name === c.provider);
		const listed = (p?.models || []).map(m => m.id).filter(Boolean);
		let ids = null;
		try {
			ids = res.status === 200 ? CATALOG_IDS[c.type](JSON.parse(res.body)) : null;
		} catch {
			ids = null;
		}
		if (!ids || ids.length === 0) {
			catalogResults.push({ provider: c.provider, url: c.url, httpStatus: res.status, state: 'CATALOG_ERROR', gone: [], new: [] });
			continue;
		}
		const gone = listed.filter(id => !ids.some(cid => sameModel(cid, id)));
		const isFree = CATALOG_FREE[c.type];
		const fresh = isFree ? ids.filter(isFree).filter(cid => !listed.some(id => sameModel(cid, id))) : [];
		catalogResults.push({ provider: c.provider, url: c.url, httpStatus: res.status, state: 'OK', size: ids.length, gone, new: fresh });
	}

	// A link is broken only when the server says the page does not exist (404 or 410).
	// Login pages, bot walls (401, 403, 429) and network errors say nothing about the link.
	const prevLinks = new Map((previous?.links || []).map(l => [l.url, l]));
	const linkResults = [];
	for (const l of allLinks()) {
		const res = pages[l.url] || await get(l.url);
		const status = res.httpStatus ?? res.status;
		const state = status === 404 || status === 410 ? 'BROKEN' : status >= 200 && status < 300 ? 'OK' : 'UNCHECKED';
		const signal = state === 'BROKEN' && prevLinks.get(l.url)?.state === 'BROKEN';
		linkResults.push({ url: l.url, where: l.where, httpStatus: status, state, signal });
	}

	const sourced = new Set(facts.map(f => factKey(f.provider, f.model, f.fact)));
	const unsourced = allFacts().filter(k => !sourced.has(k));
	const count = state => facts.filter(f => f.state === state).length;

	const report = {
		generatedAt: new Date().toISOString(),
		summary: {
			facts: allFacts().length,
			sourced: facts.length,
			unsourced: unsourced.length,
			ok: count('OK'),
			quoteMissing: count('QUOTE_MISSING'),
			pageError: count('PAGE_ERROR'),
			unverifiable: count('PAGE_EMPTY'),
			valueDrift: count('VALUE_DRIFT'),
			rowGone: count('ROW_GONE'),
			signals: facts.filter(f => f.signal).length,
			modelsGone: catalogResults.reduce((n, c) => n + c.gone.length, 0),
			modelsNew: catalogResults.reduce((n, c) => n + c.new.length, 0),
			links: linkResults.length,
			linksBroken: linkResults.filter(l => l.state === 'BROKEN').length,
			linkSignals: linkResults.filter(l => l.signal).length,
		},
		facts,
		catalogs: catalogResults,
		links: linkResults,
		pages: Object.values(pages).map(({ text, ...rest }) => rest),
		unsourced: unsourced.map(k => {
			const [provider, model, fact] = k.split('|');
			return { provider, model: model || null, fact };
		}),
	};

	fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
	const s = report.summary;
	console.log(`sources: ${s.sourced}/${s.facts} facts sourced, ${s.ok} OK, ${s.signals} to check, ${s.unverifiable} unverifiable`);
	console.log(`catalogs: ${s.modelsGone} listed models gone, ${s.modelsNew} new free models`);
	for (const f of facts.filter(x => x.state !== 'OK')) {
		console.log(`  ${f.state.padEnd(13)} ${f.provider} ${f.model || ''} ${f.fact}: ${f.url}`);
	}

	console.log(`links: ${s.links} checked, ${s.linksBroken} broken, ${s.linkSignals} broken two days in a row`);
	for (const l of linkResults.filter(x => x.state === 'BROKEN')) {
		console.log(`  BROKEN ${l.httpStatus} ${l.url} (${l.where.join(', ')})`);
	}

	if (strict && (facts.some(f => f.state !== 'OK') || linkResults.some(l => l.state === 'BROKEN'))) process.exit(1);
	if (consistent && facts.some(f => ['VALUE_DRIFT', 'ROW_GONE'].includes(f.state))) process.exit(1);
}

run().catch(err => {
	console.error(err);
	process.exit(1);
});
