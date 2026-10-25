export interface DnsResolvers {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(host: string): Promise<string[][]>;
  resolveNs(host: string): Promise<string[]>;
}

/** Races a lookup against a timer and always clears the timer (an unanswered one used to stay armed). */
function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS Timeout')), ms); });
  return Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * A, AAAA, MX, TXT and NS records of a host, looked up in parallel: a dead resolver now costs one timeout, not
 * five in a row. A lookup that fails or times out simply leaves its record type out.
 */
export async function lookupDnsRecords(host: string, r: DnsResolvers, timeoutMs = 3000): Promise<{ report: Record<string, any>; resolvedIps: string[] }> {
  const ok = async <T>(run: () => Promise<T[]>): Promise<T[]> => {
    try { return await withTimeout(run, timeoutMs); } catch { return []; }
  };
  const [a, aaaa, mx, txt, ns] = await Promise.all([
    ok(() => r.resolve4(host)), ok(() => r.resolve6(host)), ok(() => r.resolveMx(host)), ok(() => r.resolveTxt(host)), ok(() => r.resolveNs(host)),
  ]);
  const report: Record<string, any> = {};
  if (a.length) report.A = a;
  if (aaaa.length) report.AAAA = aaaa;
  if (mx.length) report.MX = mx;
  if (txt.length) report.TXT = txt;
  if (ns.length) report.NS = ns;
  return { report, resolvedIps: [...a, ...aaaa] };
}
