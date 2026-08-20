/**
 * SSRF guard and guarded fetch (arch-001 §3 `add-source` rules).
 *
 * Portable: Web APIs only (`URL`, `fetch`, `AbortController`, `TextDecoder`).
 * No Deno globals — the DNS resolver and the fetch implementation are injected, so
 * the whole policy is unit-testable from Node with no network.
 *
 * Policy, in order:
 *   1. absolute `https:` only — no `http:`, no `file:`, no `data:`;
 *   2. no userinfo (`https://user:pass@host/`);
 *   3. no fragment;
 *   4. default port only (empty or 443);
 *   5. a real DNS name — IP literals of every family are refused outright, and
 *      special-use suffixes (`.local`, `.internal`, `.onion`, …) with them;
 *   6. every resolved address must classify as `public` (see `ip.ts`);
 *   7. at most 3 redirects, and EVERY hop is revalidated against 1–6 before it
 *      is fetched;
 *   8. fixed time and byte limits, `redirect: 'manual'`, credentials omitted,
 *      and only the headers this module chooses are sent — no cookies, no
 *      caller-supplied headers.
 *
 * Residual risk, unchanged from arch-001: DNS rebinding. The address checked at
 * step 6 is not provably the address the TCP connection uses. Closing that
 * needs connect-time destination enforcement, which the Edge runtime does not
 * expose. Recorded, not solved.
 */

import { BLOCKED_IP_CLASSES, classifyIp, isIpLiteral } from './ip.ts';
import { canonicalizeUrl, MAX_URL_LENGTH } from './url.ts';

export type UrlRejectReason =
  | 'not_absolute_url'
  | 'scheme_not_https'
  | 'credentials_not_allowed'
  | 'fragment_not_allowed'
  | 'port_not_allowed'
  | 'invalid_host'
  | 'ip_literal_not_allowed'
  | 'special_use_host'
  | 'url_too_long'
  | 'dns_unavailable'
  | 'dns_no_answer'
  | 'blocked_address';

export type UrlCheck =
  | { ok: true; url: string; hostname: string; addresses: string[]; dnsChecked: boolean }
  | { ok: false; reason: UrlRejectReason; detail?: string };

/** Suffixes that never name a public host. */
const SPECIAL_USE_SUFFIXES = [
  '.local',
  '.localhost',
  '.localdomain',
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.home.arpa',
  '.lan',
  '.onion',
  '.test',
  '.example',
  '.invalid',
  '.in-addr.arpa',
  '.ip6.arpa',
];

const SPECIAL_USE_EXACT = new Set([
  'localhost',
  'localhost.localdomain',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
]);

/**
 * Everything that can be decided without touching the network.
 * Always run this before any DNS lookup or fetch.
 */
export function checkUrlShape(raw: string): UrlCheck {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'not_absolute_url' };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'url_too_long' };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not_absolute_url' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_https', detail: url.protocol };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials_not_allowed' };
  }
  if (url.hash !== '') {
    return { ok: false, reason: 'fragment_not_allowed' };
  }
  if (url.port !== '' && url.port !== '443') {
    return { ok: false, reason: 'port_not_allowed', detail: url.port };
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === '') {
    return { ok: false, reason: 'invalid_host' };
  }
  if (isIpLiteral(hostname) || hostname.startsWith('[')) {
    // Even a public IP literal is refused: a feed worth seeding has a name,
    // and allowing literals removes the DNS classification step entirely.
    return { ok: false, reason: 'ip_literal_not_allowed', detail: hostname };
  }
  if (hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) {
    return { ok: false, reason: 'invalid_host', detail: hostname };
  }
  if (hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) {
    return { ok: false, reason: 'invalid_host', detail: hostname };
  }
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((l) => l === '' || l.length > 63)) {
    return { ok: false, reason: 'invalid_host', detail: hostname };
  }
  if (SPECIAL_USE_EXACT.has(hostname)) {
    return { ok: false, reason: 'special_use_host', detail: hostname };
  }
  for (const suffix of SPECIAL_USE_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { ok: false, reason: 'special_use_host', detail: hostname };
    }
  }

  let canonical: string;
  try {
    canonical = canonicalizeUrl(url.toString());
  } catch {
    return { ok: false, reason: 'url_too_long' };
  }

  return { ok: true, url: canonical, hostname, addresses: [], dnsChecked: false };
}

/** Injected DNS resolver. `null` means the runtime offers none. */
export type Resolver = ((hostname: string) => Promise<string[]>) | null;

export type SafetyOptions = {
  resolve: Resolver;
  /**
   * When true (user-supplied URLs, i.e. `add-source`), a missing or failing
   * resolver is a rejection: the guard fails closed rather than fetching an
   * unclassified destination. When false (seeded sources whose hostnames were
   * reviewed by a human), shape checks alone are accepted.
   */
  requireDns: boolean;
};

/** Full check: shape, then every resolved address. */
export async function checkUrlSafety(
  raw: string,
  options: SafetyOptions,
): Promise<UrlCheck> {
  const shape = checkUrlShape(raw);
  if (!shape.ok) return shape;

  if (options.resolve === null) {
    if (options.requireDns) {
      return { ok: false, reason: 'dns_unavailable', detail: shape.hostname };
    }
    return shape;
  }

  let addresses: string[];
  try {
    addresses = await options.resolve(shape.hostname);
  } catch {
    return options.requireDns
      ? { ok: false, reason: 'dns_unavailable', detail: shape.hostname }
      : shape;
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, reason: 'dns_no_answer', detail: shape.hostname };
  }

  for (const address of addresses) {
    const cls = classifyIp(address);
    if (BLOCKED_IP_CLASSES.has(cls)) {
      return { ok: false, reason: 'blocked_address', detail: cls };
    }
  }

  return { ...shape, addresses, dnsChecked: true };
}

// ---------------------------------------------------------------------------
// Guarded fetch
// ---------------------------------------------------------------------------

export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export type SafeFetchOptions = SafetyOptions & {
  fetchImpl: FetchImpl;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Conditional-request headers only. Never cookies, never authorization. */
  conditional?: { etag?: string | null; lastModified?: string | null };
  accept?: string;
  userAgent?: string;
};

export type SafeFetchFailure =
  | { ok: false; kind: 'unsafe_url'; reason: UrlRejectReason; detail?: string }
  | { ok: false; kind: 'too_many_redirects' }
  | { ok: false; kind: 'redirect_without_location' }
  | { ok: false; kind: 'timeout' }
  | { ok: false; kind: 'network_error'; detail?: string }
  | { ok: false; kind: 'too_large' }
  | { ok: false; kind: 'http_error'; status: number };

export type SafeFetchSuccess = {
  ok: true;
  status: number;
  finalUrl: string;
  redirects: number;
  headers: Headers;
  /** Empty string for 304 Not Modified. */
  body: string;
  byteLength: number;
};

export type SafeFetchResult = SafeFetchSuccess | SafeFetchFailure;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const DEFAULT_USER_AGENT = 'AIGundem/1.0 (+https://aigundem.app)';
export const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5, */*;q=0.1';

/**
 * Fetch a URL under the full policy. Never throws for an expected failure —
 * callers count outcomes per source, so failures are values.
 */
export async function safeFetch(
  raw: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  const headers: Record<string, string> = {
    accept: options.accept ?? FEED_ACCEPT,
    'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
    'accept-encoding': 'gzip',
  };
  if (options.conditional?.etag) headers['if-none-match'] = options.conditional.etag;
  if (options.conditional?.lastModified) {
    headers['if-modified-since'] = options.conditional.lastModified;
  }

  let current = raw;
  let redirects = 0;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const check = await checkUrlSafety(current, {
      resolve: options.resolve,
      requireDns: options.requireDns,
    });
    if (!check.ok) {
      return { ok: false, kind: 'unsafe_url', reason: check.reason, detail: check.detail };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, kind: 'timeout' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      response = await options.fetchImpl(check.url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      return aborted
        ? { ok: false, kind: 'timeout' }
        : { ok: false, kind: 'network_error', detail: shortReason(cause) };
    }
    clearTimeout(timer);

    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects >= maxRedirects) return { ok: false, kind: 'too_many_redirects' };
      const location = response.headers.get('location');
      if (!location) return { ok: false, kind: 'redirect_without_location' };
      let next: string;
      try {
        next = new URL(location, check.url).toString();
      } catch {
        return { ok: false, kind: 'unsafe_url', reason: 'not_absolute_url' };
      }
      redirects += 1;
      current = next;
      // Loop: the new hop goes through the whole policy again before any fetch.
      continue;
    }

    if (response.status === 304) {
      return {
        ok: true,
        status: 304,
        finalUrl: check.url,
        redirects,
        headers: response.headers,
        body: '',
        byteLength: 0,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, kind: 'http_error', status: response.status };
    }

    const read = await readCapped(response, maxBytes);
    if (!read.ok) return read;

    return {
      ok: true,
      status: response.status,
      finalUrl: check.url,
      redirects,
      headers: response.headers,
      body: read.text,
      byteLength: read.byteLength,
    };
  }
}

function shortReason(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return 'error';
}

/** Read a body under a hard byte cap, decoding with the declared charset. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string; byteLength: number } | { ok: false; kind: 'too_large' }> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    return { ok: false, kind: 'too_large' };
  }

  let bytes: Uint8Array;
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, kind: 'too_large' };
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return { ok: false, kind: 'too_large' };
    bytes = new Uint8Array(buffer);
  }

  return {
    ok: true,
    text: decodeBody(bytes, response.headers.get('content-type')),
    byteLength: bytes.byteLength,
  };
}

/**
 * Decode using, in order: the HTTP `charset`, the XML declaration's `encoding`,
 * then UTF-8. Webrazzi and several Turkish publishers still serve windows-1254
 * or ISO-8859-9, and mis-decoding turns every Turkish character into U+FFFD.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const candidates: string[] = [];

  const fromHeader = contentType?.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1];
  if (fromHeader) candidates.push(fromHeader);

  // The XML declaration is ASCII in every encoding we care about.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 256));
  const fromXml = head.match(/<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i)?.[1];
  if (fromXml) candidates.push(fromXml);

  candidates.push('utf-8');

  for (const label of candidates) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
      // Unknown label: try the next candidate.
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Content-type / sniff check: is this plausibly a feed rather than a web page?
 * Used to decide between "parse it" and "look for a <link rel=alternate>".
 */
export function looksLikeXmlFeed(body: string, contentType: string | null): boolean {
  const type = (contentType ?? '').toLowerCase();
  if (/(rss|atom)\+xml/.test(type)) return true;
  if (/(application|text)\/xml/.test(type)) return true;
  const head = body.slice(0, 1024).toLowerCase();
  return (
    head.includes('<rss') ||
    head.includes('<feed') ||
    head.includes('<rdf:rdf') ||
    (head.includes('<?xml') && !head.includes('<html'))
  );
}
