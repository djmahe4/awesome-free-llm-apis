/**
 * Live smoke test: every real tool in the user's registry, through resolve_tool, per source.
 * Read-only (never writes the registry). Hits GitHub / Docker Hub / Debian / Kali / package registries.
 *
 *   npx tsx scripts/smoke/smoke_registry_sources.ts [--tools a,b] [--sources github,docker,apt] [--delay 300]
 *
 * Unauthenticated GitHub allows 60 req/h; each github deep-read costs ~3-10 calls, so a
 * `rate_limited` / `could_not_verify` outcome is reported as such, not as a failure of the tool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CyberToolsRegistry } from '../../src/utils/CyberToolsRegistry.js';
import { resolveTool, resetResolveSessions } from '../../src/tools/resolve-tool.js';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const sources = (arg('sources') ?? 'github,docker,apt').split(',') as ('github' | 'docker' | 'apt')[];
const delay = Number(arg('delay') ?? 300);
const only = arg('tools')?.split(',');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const reg = await CyberToolsRegistry.loadRegistry();
  const real = Object.entries(reg).filter(([n, e]) => !CyberToolsRegistry.isTestDebris(n, e.url)).map(([n]) => n)
    .filter(n => !only || only.includes(n));
  console.log(`registry: ${CyberToolsRegistry.getRegistryFilePath()}\nreal tools: ${real.join(', ')}\n`);
  const rows: any[] = [];
  for (const tool of real) {
    for (const source of sources) {
      resetResolveSessions();
      const intent = source === 'github' ? 'what libraries does it depend on' : source === 'apt' ? 'apt install' : 'docker image';
      const t0 = Date.now();
      let r: any;
      try { r = await resolveTool({ toolName: tool, prompt: intent, source, sessionId: `smoke-${tool}-${source}` }); }
      catch (e: any) { r = { status: 'crashed', message: String(e?.message ?? e) }; }
      const s = r.summary ?? {};
      const note = r.status === 'answer'
        ? (source === 'github' ? `${s.repo} deps=${s.dependencies?.length ?? 0} described=${s.dependencyDescriptions?.length ?? 0}`
          : source === 'docker' ? s.image : `${s.distro}: ${s.installCommand}`)
        : r.question ?? r.message ?? '';
      rows.push({ tool, source, status: r.status, ms: Date.now() - t0, note });
      console.log(`${tool.padEnd(18)} ${source.padEnd(7)} ${String(r.status).padEnd(16)} ${String(Date.now() - t0).padStart(6)}ms  ${String(note).slice(0, 110)}`);
      await sleep(delay);
    }
  }
  const dir = path.join(process.cwd(), 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `smoke-registry-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(rows, null, 2));
  const bad = rows.filter(r => r.status === 'crashed');
  console.log(`\nreport: ${out}\ncrashed: ${bad.length}`);
  process.exitCode = bad.length ? 1 : 0;
}
main();
