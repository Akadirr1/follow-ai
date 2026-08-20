/**
 * SHA-256 helpers shared by ingestion and `add-source`.
 *
 * Portable: Web Crypto only (`crypto.subtle`), present in Deno, Node 18+ and
 * browsers. No Deno globals, no `node:crypto`.
 *
 * Both hashes are stored as 32-byte `bytea` columns whose length P2's schema
 * checks (`octet_length = 32`), so the hex strings here are always 64 chars.
 */

const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(input),
  );
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * `aigundem.sources.feed_url_hash` / `aigundem.articles.url_hash`.
 *
 * The input MUST already be canonicalised (`canonicalizeUrl`) — the hash is
 * only a dedupe key if both writers normalise identically. The seed migration
 * computes the same value in SQL with `extensions.digest(feed_url, 'sha256')`,
 * which hashes the UTF-8 bytes of the literal exactly as this does.
 */
export function urlHashHex(canonicalUrl: string): Promise<string> {
  return sha256Hex(canonicalUrl);
}

/**
 * `aigundem.articles.content_hash`, and therefore the summary cache key.
 *
 * Covers title and body together: a corrected headline must invalidate the
 * cached Turkish summary just as a rewritten body does. Whitespace is collapsed
 * first so that a feed re-indenting its HTML does not look like new content and
 * trigger a pointless Claude call.
 */
export function contentHashHex(title: string, contentText: string): Promise<string> {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  return sha256Hex(`${normalize(title)}\n${normalize(contentText)}`);
}
