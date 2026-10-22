import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

// GETs for mini-apps (api.fetchJson): the public internet only. The hub sits on your home network
// and Tailscale, and app code is written by Claude from anyone's description, so every hop (each
// redirect too) is resolved and refused if any address it names is loopback, private, link-local,
// CGNAT (that includes Tailscale's 100.64/10), unique-local, multicast or otherwise not public. The
// connection then goes to the address that was checked (a pinned lookup), so a DNS answer that
// changes between the check and the connect (rebinding) can't point it somewhere else.

export interface PublicFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** DNS (tests). Default: the system resolver, every address. */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Exceptions to the block list (tests only: their local server is on 127.0.0.1). */
  allow?: (host: string, address: string) => boolean;
}

export class BlockedAddress extends Error {}

/** IPv4 ranges that aren't the public internet: [network, prefix length]. */
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function v4(ip: string): number {
  return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}

function v4Blocked(ip: string): boolean {
  const x = v4(ip);
  return V4_BLOCKED.some(([a, n]) => Math.floor(x / 2 ** (32 - n)) === Math.floor(v4(a) / 2 ** (32 - n)));
}

/** An IPv6 address as eight 16-bit groups (handles "::" and a trailing dotted IPv4). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const x = v4(dotted[1]);
    s = s.slice(0, -dotted[1].length) + `${(x >>> 16).toString(16)}:${(x & 0xffff).toString(16)}`;
  }
  const [head, tail, extra] = s.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const g = [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x, 16));
  return g.length === 8 && g.every((x) => x >= 0 && x <= 0xffff) ? g : null;
}

/** Whether an IP address (v4 or v6, any notation) is somewhere a mini-app must not reach. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/%.*$/, ""));
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true; // not an address at all: refuse
  const g = v6Groups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return true; // ::
  if (zero(0, 7) && g[7] === 1) return true; // ::1
  // IPv4 inside IPv6: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, translated ::ffff:0:a.b.c.d,
  // NAT64 64:ff9b::a.b.c.d, 6to4 2002:AB:CD::
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return v4Blocked(embedded(g[6], g[7]));
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4Blocked(embedded(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4Blocked(embedded(g[6], g[7]));
  if (g[0] === 0x2002) return v4Blocked(embedded(g[1], g[2]));
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 old site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x100 && zero(1, 4)) return true; // 100::/64 discard
  return false;
}

const systemLookup = async (host: string) => dnsLookup(host, { all: true, verbatim: true });

/**
 * GET a public http(s) URL and return its body as text: redirects followed by hand (each hop
 * checked), at most `maxBytes` (1 MB) and `timeoutMs` (10 s) in all.
 */
export async function fetchPublic(url: string, o: PublicFetchOptions = {}): Promise<{ status: number; body: string }> {
  const maxBytes = o.maxBytes ?? 1_000_000;
  const maxRedirects = o.maxRedirects ?? 5;
  const lookup = o.lookup ?? systemLookup;
  const signal = AbortSignal.timeout(o.timeoutMs ?? 10_000);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("not a valid URL");
  }
  for (let hop = 0; ; hop++) {
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http(s) URLs");
    if (u.username || u.password) throw new Error("URLs with a user name or password are not allowed");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
    if (!addresses.length) throw new Error(`${host}: no address`);
    for (const a of addresses)
      if (isBlockedAddress(a.address) && !o.allow?.(host, a.address)) throw new BlockedAddress(`local addresses are not allowed (${host})`);
    const res = await get(u, addresses[0], signal);
    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      if (hop >= maxRedirects) throw new Error("too many redirects");
      u = new URL(location, u);
      continue;
    }
    return { status: res.statusCode ?? 0, body: await read(res, maxBytes, signal) };
  }
}

/** One request, connected to the address that was checked (TLS still verifies the host name). */
function get(u: URL, pinned: { address: string; family: number }, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: "GET",
      headers: { "User-Agent": "g2-jarvis-miniapp", Accept: "application/json, */*;q=0.5" },
      signal,
      lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        opts?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)) as any,
      agent: false,
    });
    req.on("response", resolve);
    req.on("error", (e) => reject(signal.aborted ? new Error("timed out") : e));
    req.end();
  });
}

function read(res: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    const fail = (e: Error) => {
      res.destroy();
      reject(e);
    };
    if (Number(res.headers["content-length"]) > maxBytes) return fail(new Error("response too large"));
    res.on("data", (b: Buffer) => {
      n += b.length;
      if (n > maxBytes) fail(new Error("response too large"));
      else parts.push(b);
    });
    res.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    res.on("error", (e) => reject(signal.aborted ? new Error("timed out") : e));
    res.on("close", () => res.complete || reject(new Error(signal.aborted ? "timed out" : "the connection closed early")));
  });
}
