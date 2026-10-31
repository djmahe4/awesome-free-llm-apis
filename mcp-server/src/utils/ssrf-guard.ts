import net from 'node:net';
import dns from 'node:dns';

/**
 * Shared outbound-URL guard (browser_tool navigation, osint targets, anything that fetches a
 * user-supplied URL). Fails closed: anything that cannot be proven public is rejected.
 *
 * The WHATWG URL parser already normalizes decimal/hex/octal IPv4 spellings
 * (http://2130706433/, http://0x7f.1/, http://017700000001/ all become 127.0.0.1), so checking
 * `URL.hostname` covers those; hostnames are then resolved and EVERY address must be public.
 */

/** [network, prefix length] blocks that are never public. */
const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],   // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 3],      // multicast + reserved + broadcast (224.0.0.0 - 255.255.255.255)
];

function v4ToInt(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

export function isPrivateIPv4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true;
  return PRIVATE_V4.some(([base, bits]) => {
    const b = v4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

/** Expands any valid IPv6 text (including an embedded dotted IPv4 tail) to eight 16-bit groups. */
function expandV6(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let text = ip.split('%')[0];
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = v4ToInt(tail[1]);
    if (v4 === null) return null;
    text = text.slice(0, text.length - tail[1].length) + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...rest].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  if (g.every(x => x === 0)) return true;                          // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true;                     // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                     // fe80::/10 link-local (fe80-febf)
  if ((g[0] & 0xff00) === 0xff00) return true;                     // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form: judge the embedded v4.
  const mapped = g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0);
  if (mapped) return isPrivateIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  // 64:ff9b::/96 NAT64 embeds a v4 address too.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return isPrivateIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  return false;
}

/** True for private, loopback, link-local, reserved and unparsable addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; code: 'BAD_URL' | 'BAD_SCHEME' | 'CREDENTIALS_IN_URL' | 'PRIVATE_ADDRESS' | 'METADATA_ADDRESS' | 'DNS_FAILED'; message: string };

export interface UrlCheckOptions {
  /** Permit private/loopback targets (local development). The scheme is still enforced. */
  allowPrivate?: boolean;
  /**
   * Explicit local-testing allowlist: `host` (any port) or `host:port`, e.g. `localhost:3111`,
   * `127.0.0.1:8080`, `[::1]:3000`. Only those targets skip the private-address check; everything
   * else private stays blocked. Cloud metadata addresses are never allowed.
   */
  allowHosts?: string[];
  /** Injectable resolver (tests); defaults to dns.lookup with all addresses. */
  resolve?: (host: string) => Promise<string[]>;
}

/** 169.254.0.0/16 (AWS/GCP/Azure metadata) and the AWS IPv6 metadata address. */
function isMetadataAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.startsWith('169.254.');
  const g = expandV6(ip);
  if (!g) return false;
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every(x => x === 0) && g[7] === 0x254) return true;
  const mapped = g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff;
  return mapped && g[6] === 0xa9fe;
}

function isAllowListed(url: URL, host: string, allow?: string[]): boolean {
  if (!allow || allow.length === 0) return false;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return allow.some(entry => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    const m = e.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!m) return false;
    const eHost = m[1].replace(/^\[|\]$/g, '');
    return eHost === host && (m[2] === undefined || m[2] === port);
  });
}

const PRIVATE_NAME_RE = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** Every address of a host; bounded so a hung resolver cannot stall the caller. */
async function defaultResolve(host: string): Promise<string[]> {
  const lookup = dns.promises.lookup(host, { all: true, verbatim: true });
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), 5000);
    t.unref?.();
  });
  const found = await Promise.race([lookup, timeout]);
  return found.map(f => f.address);
}

/**
 * Guard for a bare target that is not a URL: `host`, `ip`, `host:port`, `[v6]`, `[v6]:port`, a decimal/hex/octal
 * IPv4 spelling, or an unbracketed IPv6 address. The target is normalized by the WHATWG URL parser (so every
 * IPv4 spelling collapses to dotted form), private/loopback/link-local/metadata addresses and internal names are
 * refused, and a hostname must not resolve to any private address. A name that does not resolve is allowed: it is
 * not a private target (OSINT legitimately investigates unregistered domains).
 */
export async function checkHostTarget(raw: string, opts: UrlCheckOptions = {}): Promise<UrlCheck> {
  const target = String(raw ?? '').trim();
  if (!target || target.length > 253 + 8) {
    return { ok: false, code: 'BAD_URL', message: 'Target is empty or too long' };
  }
  // An unbracketed IPv6 literal ("::1") is not valid in a URL authority; wrap it.
  const authority = net.isIPv6(target) ? `[${target}]` : target;
  let url: URL;
  try {
    url = new URL(`http://${authority}/`);
  } catch {
    // Not a host at all (for instance a username): nothing network-addressed to protect against.
    return { ok: true, url: new URL('http://invalid.invalid/') };
  }
  const verdict = await checkPublicHttpUrl(url.toString(), opts);
  if (!verdict.ok && verdict.code === 'DNS_FAILED') return { ok: true, url };
  return verdict;
}

export async function checkPublicHttpUrl(raw: string, opts: UrlCheckOptions = {}): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, code: 'BAD_URL', message: `Not a valid absolute URL: ${JSON.stringify(String(raw ?? '').slice(0, 80))}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'BAD_SCHEME', message: `Only http and https are allowed, got ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, code: 'CREDENTIALS_IN_URL', message: 'URLs with embedded credentials are not allowed' };
  }
  // URL.hostname keeps IPv6 literals in brackets.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

  // Cloud metadata endpoints hand out credentials; no opt-in unlocks them.
  if (net.isIP(host) && isMetadataAddress(host)) {
    return { ok: false, code: 'METADATA_ADDRESS', message: `${host} is a cloud metadata address and is never allowed` };
  }
  if (opts.allowPrivate) return { ok: true, url };
  if (isAllowListed(url, host, opts.allowHosts)) return { ok: true, url };
  if (net.isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, code: 'PRIVATE_ADDRESS', message: `${host} is a private, loopback, link-local or reserved address` }
      : { ok: true, url };
  }
  if (PRIVATE_NAME_RE.test(host)) {
    return { ok: false, code: 'PRIVATE_ADDRESS', message: `${host} is an internal-only hostname` };
  }
  let addrs: string[];
  try {
    addrs = await (opts.resolve ?? defaultResolve)(host);
  } catch (err: any) {
    return { ok: false, code: 'DNS_FAILED', message: `Could not resolve ${host}: ${err?.code || err?.message || 'error'}` };
  }
  if (addrs.length === 0) return { ok: false, code: 'DNS_FAILED', message: `${host} resolved to no addresses` };
  const bad = addrs.find(isPrivateAddress);
  if (bad) return { ok: false, code: 'PRIVATE_ADDRESS', message: `${host} resolves to ${bad}, a private or reserved address` };
  return { ok: true, url };
}
