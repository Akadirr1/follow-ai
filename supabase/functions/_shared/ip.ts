/**
 * IP literal parsing and range classification for the SSRF guard.
 *
 * Portable: no Deno globals, no Node APIs, no dependencies.
 *
 * Split out of `url-safety.ts` so the range table stays readable and can be
 * unit-tested directly against the full matrix arch-001 §3 requires:
 * loopback, private, link-local, carrier-grade NAT, documentation, multicast,
 * reserved, and IPv6 local ranges.
 */

export type IpClass =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cgnat'
  | 'documentation'
  | 'multicast'
  | 'broadcast'
  | 'reserved'
  | 'unique_local';

export type ParsedIp = { family: 4 | 6; bytes: number[] };

/** Every class except `public` is refused as a fetch destination. */
export const BLOCKED_IP_CLASSES: ReadonlySet<IpClass> = new Set<IpClass>([
  'unspecified',
  'loopback',
  'private',
  'link_local',
  'cgnat',
  'documentation',
  'multicast',
  'broadcast',
  'reserved',
  'unique_local',
]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Strict dotted-quad. Rejects octal/hex/short forms such as `010.0.0.1`. */
export function parseIpv4(input: string): ParsedIp | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return { family: 4, bytes };
}

/** RFC 4291 textual IPv6, including `::` compression and embedded IPv4. */
export function parseIpv6(input: string): ParsedIp | null {
  let text = input;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // A zone id (`%eth0`) has no meaning for a remote destination.
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text === '') return null;
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return null;

  const doubleColon = text.indexOf('::');
  if (doubleColon !== text.lastIndexOf('::')) return null;

  const expand = (segment: string): string[] =>
    segment === '' ? [] : segment.split(':');

  let head: string[];
  let tail: string[];
  if (doubleColon === -1) {
    head = expand(text);
    tail = [];
  } else {
    head = expand(text.slice(0, doubleColon));
    tail = expand(text.slice(doubleColon + 2));
  }

  // A trailing dotted-quad occupies the last two groups (`::ffff:1.2.3.4`).
  const toBytes = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      if (group.includes('.')) {
        if (i !== groups.length - 1) return null;
        const v4 = parseIpv4(group);
        if (!v4) return null;
        out.push(...v4.bytes);
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return null;
      const value = parseInt(group, 16);
      out.push((value >> 8) & 0xff, value & 0xff);
    }
    return out;
  };

  const headBytes = toBytes(head);
  const tailBytes = toBytes(tail);
  if (headBytes === null || tailBytes === null) return null;

  const missing = 16 - headBytes.length - tailBytes.length;
  if (doubleColon === -1) {
    if (missing !== 0) return null;
    return { family: 6, bytes: headBytes.concat(tailBytes) };
  }
  if (missing < 1) return null;
  return {
    family: 6,
    bytes: headBytes.concat(new Array(missing).fill(0), tailBytes),
  };
}

/** Parse either family. Bracketed IPv6 (`[::1]`) is accepted. */
export function parseIp(input: string): ParsedIp | null {
  const text = input.trim();
  if (text === '') return null;
  if (text.startsWith('[')) return parseIpv6(text);
  if (text.includes(':')) return parseIpv6(text);
  return parseIpv4(text);
}

/** True when the hostname is an IP literal rather than a name. */
export function isIpLiteral(hostname: string): boolean {
  return parseIp(hostname) !== null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyIpv4(b: number[]): IpClass {
  if (b[0] === 0) return b.every((x) => x === 0) ? 'unspecified' : 'reserved';
  if (b[0] === 10) return 'private';
  if (b[0] === 127) return 'loopback';
  if (b[0] === 169 && b[1] === 254) return 'link_local';
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return 'private';
  if (b[0] === 192 && b[1] === 168) return 'private';
  if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return 'cgnat';
  // 192.0.0.0/24 IETF protocol assignments, 192.0.2.0/24 TEST-NET-1.
  if (b[0] === 192 && b[1] === 0 && b[2] === 0) return 'reserved';
  if (b[0] === 192 && b[1] === 0 && b[2] === 2) return 'documentation';
  if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return 'reserved'; // benchmarking
  if (b[0] === 198 && b[1] === 51 && b[2] === 100) return 'documentation';
  if (b[0] === 203 && b[1] === 0 && b[2] === 113) return 'documentation';
  if (b[0] === 255 && b[1] === 255 && b[2] === 255 && b[3] === 255) return 'broadcast';
  if (b[0] >= 224 && b[0] <= 239) return 'multicast';
  if (b[0] >= 240) return 'reserved';
  return 'public';
}

function classifyIpv6(b: number[]): IpClass {
  const allZero = b.every((x) => x === 0);
  if (allZero) return 'unspecified';
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return 'loopback';

  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 hat. Classify the v4.
  const isMapped =
    b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (isMapped) return classifyIpv4(b.slice(12));

  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 also embed IPv4.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return classifyIpv4(b.slice(12));
  }

  if (b[0] === 0xff) return 'multicast';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link_local';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return 'reserved'; // deprecated site-local
  if ((b[0] & 0xfe) === 0xfc) return 'unique_local';
  // 100::/64 discard-only.
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) {
    return 'reserved';
  }
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0x0d && b[3] === 0xb8) return 'documentation'; // 2001:db8::/32
    if (b[2] === 0x00 && b[3] === 0x00) return 'reserved'; // 2001::/32 Teredo
  }
  // 3fff::/20 documentation (RFC 9637).
  if (b[0] === 0x3f && (b[1] & 0xf0) === 0xf0) return 'documentation';
  return 'public';
}

/** Classify an address literal. Unparseable input is `reserved` (fail closed). */
export function classifyIp(address: string): IpClass {
  const parsed = parseIp(address);
  if (!parsed) return 'reserved';
  return parsed.family === 4
    ? classifyIpv4(parsed.bytes)
    : classifyIpv6(parsed.bytes);
}

/** True when the address may be used as a fetch destination. */
export function isPublicAddress(address: string): boolean {
  return !BLOCKED_IP_CLASSES.has(classifyIp(address));
}
