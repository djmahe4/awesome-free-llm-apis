/**
 * @file changed-models-smoke-test.ts
 * @description Smoke-tests every model in CHANGED_MODELS[*].added across registered providers
 * (and checks the removed ones are really dead), then probes the Gonka Broker gateway directly
 * (no provider adapter yet). Reports whether each model is also registered in the provider's
 * `models` list, which is what the router can actually select.
 * Usage: tsx scripts/verification/providers/changed-models-smoke-test.ts [providerId ...] [--removed]
 */
import 'dotenv/config';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { CHANGED_MODELS } from './_changed-models.js';

const GONKA_BASES = ['https://api.gonka.broker/v1', 'https://proxy.gonkabroker.com/v1'];
const GONKA_MODELS = ['gonka-auto', 'MiniMaxAI/MiniMax-M2.7', 'deepseek-ai/DeepSeek-V4-Flash-0731', 'zai-org/GLM-5.3-Flash'];
const PROVIDER_ALIASES: Record<string, string> = { kilocode: 'kilocode', openrouter: 'openrouter', llm7: 'llm7', siliconflow: 'siliconflow' };

type Row = { provider: string; model: string; ok: boolean; ms: number; registered: boolean; note: string };

async function probe(chat: () => Promise<any>): Promise<{ ok: boolean; ms: number; note: string }> {
    const start = Date.now();
    try {
        const res = await Promise.race([
            chat(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 45s')), 45_000)),
        ]);
        const msg = res?.choices?.[0]?.message;
        const text = String(msg?.content ?? msg?.reasoning ?? msg?.reasoning_content ?? '').trim();
        return { ok: true, ms: Date.now() - start, note: text ? `"${text.slice(0, 40)}"` : '(empty reply)' };
    } catch (e: any) {
        return { ok: false, ms: Date.now() - start, note: String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 160) };
    }
}

async function gonka(rows: Row[]) {
    const key = process.env.GONKA_API_KEY;
    if (!key || key.startsWith('your_')) {
        console.error('[gonka] GONKA_API_KEY not set; skipped.');
        return;
    }
    for (const base of GONKA_BASES) {
        for (const model of GONKA_MODELS) {
            const r = await probe(async () => {
                const res = await fetch(`${base}/chat/completions`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say "OK"' }], max_tokens: 16 }),
                });
                const body = await res.text();
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
                return JSON.parse(body);
            });
            rows.push({ provider: `gonka@${new URL(base).host}`, model, registered: false, ...r });
        }
    }
    // live model list, so the doc claim "lineup rotates" can be checked
    try {
        const res = await fetch(`${GONKA_BASES[0]}/models`, { headers: { Authorization: `Bearer ${key}` } });
        const j: any = await res.json();
        console.error(`[gonka] /models (${res.status}):`, (j?.data ?? []).map((m: any) => m.id).join(', ') || JSON.stringify(j).slice(0, 200));
    } catch (e: any) {
        console.error('[gonka] /models failed:', e?.message);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const includeRemoved = args.includes('--removed');
    const only = args.filter(a => !a.startsWith('--'));
    const registry = ProviderRegistry.getInstance();
    const rows: Row[] = [];

    for (const [pid, changes] of Object.entries(CHANGED_MODELS)) {
        if (only.length && !only.includes(pid)) continue;
        const targets = [...changes.added.map(m => ({ m, kind: 'added' })), ...(includeRemoved ? changes.removed.map(m => ({ m, kind: 'removed' })) : [])];
        if (!targets.length) continue;
        const provider = registry.getProvider(PROVIDER_ALIASES[pid] ?? pid);
        if (!provider || !provider.isAvailable()) {
            console.error(`[${pid}] provider missing or no key; skipped ${targets.length} models.`);
            continue;
        }
        for (const { m, kind } of targets) {
            const r = await probe(() => provider.chat({ model: m, messages: [{ role: 'user', content: 'Say "OK"' }], max_tokens: 16 }));
            rows.push({ provider: `${pid}${kind === 'removed' ? ' (removed)' : ''}`, model: m, registered: provider.models.some(x => x.id === m), ...r });
            console.error(`${r.ok ? 'OK  ' : 'FAIL'} ${pid} ${m} ${r.ms}ms ${r.note}`);
        }
    }
    if (!only.length || only.includes('gonka')) await gonka(rows);

    console.log('\n=== Changed-model smoke summary ===');
    for (const r of rows) {
        console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.provider.padEnd(26)} ${r.model.padEnd(52)} ${String(r.ms).padStart(6)}ms ${r.registered ? 'registered' : 'NOT-registered'} ${r.note}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
