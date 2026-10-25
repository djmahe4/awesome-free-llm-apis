import type { FetchLike } from '../../src/utils/http.js';

export interface MockRoute {
  /** String = substring of the URL; RegExp = tested against the full URL. First match wins. */
  match: string | RegExp;
  status?: number;
  body?: unknown;            // JSON-serialised unless it's already a string
  headers?: Record<string, string>;
  /** Throw instead of responding (network failure). */
  throws?: Error | { name?: string; message: string; code?: string };
  /** Responses used in order, last one repeats — for retry scenarios. */
  sequence?: Array<Omit<MockRoute, 'match' | 'sequence'>>;
}

export interface MockFetch {
  fetchImpl: FetchLike;
  calls: string[];
  /** Every request with the headers it carried. */
  requests: Array<{ url: string; headers: Record<string, string> }>;
  callsMatching(re: string | RegExp): string[];
}

/** Route-table fetch double. Any URL with no matching route answers 404 so unexpected calls are visible, not silent. */
export function mockFetch(routes: MockRoute[]): MockFetch {
  const calls: string[] = [];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const counters = new Map<MockRoute, number>();

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    requests.push({ url, headers: { ...(init?.headers ?? {}) } });
    const route = routes.find(r => (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)));
    if (!route) return respond(404, { message: `mock: no route for ${url}` }, {});
    let spec: Omit<MockRoute, 'match' | 'sequence'> = route;
    if (route.sequence?.length) {
      const i = counters.get(route) ?? 0;
      counters.set(route, i + 1);
      spec = route.sequence[Math.min(i, route.sequence.length - 1)];
    }
    if (spec.throws) {
      const err: any = new Error(spec.throws.message);
      if ((spec.throws as any).name) err.name = (spec.throws as any).name;
      if ((spec.throws as any).code) err.code = (spec.throws as any).code;
      throw err;
    }
    return respond(spec.status ?? 200, spec.body ?? {}, spec.headers ?? {});
  };

  return {
    fetchImpl,
    calls,
    requests,
    callsMatching: re => calls.filter(u => (typeof re === 'string' ? u.includes(re) : re.test(u))),
  };
}

function respond(status: number, body: unknown, headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
