/**
 * A small, tolerant, non-validating XML reader for RSS and Atom.
 *
 * Portable: no Deno globals, no dependencies.
 *
 * WHY HAND-ROLLED (arch-001 §3 asks for "a small pinned parser or a hand-rolled
 * tolerant XML walker — state which and why"):
 *   1. This task has no network, so no parser could be installed and, more to
 *      the point, no parser could be *tested* here. A dependency that has never
 *      executed is not a safer choice than 200 lines that run under Jest.
 *   2. The two runtimes differ: the functions run on Deno (npm:/jsr: specifiers)
 *      while the tests run on Node. One dependency-free module behaves
 *      identically in both, with nothing to pin twice.
 *   3. Real feeds are not valid XML often enough that a strict parser is a
 *      liability: unescaped `&`, stray `<` in text, mismatched close tags.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — this is the cost of the choice:
 *   - no DTD, no entity declarations, no external entities (so no XXE by
 *     construction: `<!DOCTYPE …>` is skipped, never interpreted);
 *   - no namespace resolution. Prefixes are kept verbatim and matched literally
 *     (`content:encoded`, `dc:creator`), which is what every real feed uses. A
 *     feed that binds `content:` to a different URI would be mis-read.
 *   - no XPath, no mixed-content fidelity: element text is the concatenation of
 *     its direct text and CDATA children.
 *
 * Input is bounded by the caller (1 MiB via `safeFetch`) and by `maxNodes`
 * here, so a pathological document costs bounded time and memory.
 */

export type XmlNode = {
  /** Verbatim, lowercased tag name including any prefix: `content:encoded`. */
  name: string;
  /** Tag name after the prefix, lowercased: `encoded`. */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text and CDATA content of this element, concatenated. */
  text: string;
};

export type ParseXmlOptions = {
  /** Hard cap on element count. Exceeding it truncates rather than throws. */
  maxNodes?: number;
};

const DEFAULT_MAX_NODES = 50000;

function makeNode(name: string, attrs: Record<string, string>): XmlNode {
  const lower = name.toLowerCase();
  const colon = lower.indexOf(':');
  return {
    name: lower,
    local: colon === -1 ? lower : lower.slice(colon + 1),
    attrs,
    children: [],
    text: '',
  };
}

/**
 * Parse a document into a single synthetic root whose children are the
 * top-level elements. Returns a root even for junk input — callers decide
 * whether they found a feed.
 */
export function parseXml(input: string, options: ParseXmlOptions = {}): XmlNode {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const root = makeNode('#document', {});
  const stack: XmlNode[] = [root];
  let nodeCount = 0;
  let i = 0;
  const length = input.length;

  while (i < length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], input.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], input.slice(i, lt));

    // <!-- comment -->
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }

    // <![CDATA[ ... ]]> — raw text, no entity decoding.
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      const raw = end === -1 ? input.slice(lt + 9) : input.slice(lt + 9, end);
      stack[stack.length - 1].text += raw;
      i = end === -1 ? length : end + 3;
      continue;
    }

    // <!DOCTYPE ...> — skipped, never interpreted. This is the XXE defence.
    if (input.startsWith('<!', lt)) {
      const end = skipDeclaration(input, lt);
      i = end;
      continue;
    }

    // <?xml ... ?>
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      i = end === -1 ? length : end + 2;
      continue;
    }

    // </name>
    if (input.startsWith('</', lt)) {
      const end = input.indexOf('>', lt + 2);
      const rawName = (end === -1 ? input.slice(lt + 2) : input.slice(lt + 2, end))
        .trim()
        .toLowerCase();
      closeTag(stack, rawName);
      i = end === -1 ? length : end + 1;
      continue;
    }

    // <name attr="v" ...> or <name ... />
    const tagEnd = findTagEnd(input, lt);
    if (tagEnd === -1) {
      appendText(stack[stack.length - 1], input.slice(lt));
      break;
    }
    const rawTag = input.slice(lt + 1, tagEnd);
    const selfClosing = rawTag.endsWith('/');
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const parsed = parseTag(body);
    i = tagEnd + 1;
    if (parsed === null) continue; // `< ` in text: treat as text, already skipped

    if (nodeCount >= maxNodes) continue;
    nodeCount += 1;

    const node = makeNode(parsed.name, parsed.attrs);
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function appendText(node: XmlNode, raw: string): void {
  if (raw === '') return;
  node.text += decodeEntities(raw);
}

/** Close the nearest matching open element; ignore a stray close tag. */
function closeTag(stack: XmlNode[], name: string): void {
  for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
    if (stack[depth].name === name) {
      stack.length = depth;
      return;
    }
  }
}

/** Skip `<!DOCTYPE …>`, honouring one level of `[ … ]` internal subset. */
function skipDeclaration(input: string, start: number): number {
  let i = start + 2;
  let bracket = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;
    else if (ch === '>' && bracket <= 0) return i + 1;
    i += 1;
  }
  return input.length;
}

/** Find the `>` that ends a tag, skipping quoted attribute values. */
function findTagEnd(input: string, start: number): number {
  let i = start + 1;
  let quote = '';
  while (i < input.length) {
    const ch = input[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
    i += 1;
  }
  return -1;
}

const NAME_START = /^[A-Za-z_]/;

function parseTag(body: string): { name: string; attrs: Record<string, string> } | null {
  const trimmed = body.trim();
  if (trimmed === '' || !NAME_START.test(trimmed)) return null;

  const nameMatch = /^[^\s/>]+/.exec(trimmed);
  if (!nameMatch) return null;
  const name = nameMatch[0];

  const attrs: Record<string, string> = {};
  const attrRegex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  const rest = trimmed.slice(name.length);
  while ((match = attrRegex.exec(rest)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeEntities(value);
  }
  return { name, attrs };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  ccedil: 'ç',
  laquo: '«',
  raquo: '»',
  deg: '°',
  euro: '€',
  pound: '£',
};

/**
 * Decode XML/HTML character references. Unknown named entities are left
 * verbatim: a feed containing a literal `&foo;` should read as `&foo;`, not
 * lose characters. Decoding is single-pass, so `&amp;lt;` yields `&lt;` — the
 * correct result, and the reason a recursive decoder is a bug, not a feature.
 */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return codePointOrOriginal(code, whole);
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return codePointOrOriginal(code, whole);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function codePointOrOriginal(code: number, original: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return original;
  // Surrogate halves are not valid standalone code points.
  if (code >= 0xd800 && code <= 0xdfff) return original;
  try {
    return String.fromCodePoint(code);
  } catch {
    return original;
  }
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** First direct child whose full or local name matches any of `names`. */
export function child(node: XmlNode, ...names: string[]): XmlNode | null {
  const wanted = names.map((n) => n.toLowerCase());
  for (const candidate of node.children) {
    if (wanted.includes(candidate.name) || wanted.includes(candidate.local)) {
      return candidate;
    }
  }
  return null;
}

/** All direct children matching any of `names`. */
export function children(node: XmlNode, ...names: string[]): XmlNode[] {
  const wanted = names.map((n) => n.toLowerCase());
  return node.children.filter(
    (candidate) => wanted.includes(candidate.name) || wanted.includes(candidate.local),
  );
}

/** Trimmed text of the first matching child, or '' when absent. */
export function childText(node: XmlNode, ...names: string[]): string {
  const found = child(node, ...names);
  return found ? found.text.trim() : '';
}

/** Depth-first search for the first element with the given name. */
export function findFirst(node: XmlNode, name: string): XmlNode | null {
  const wanted = name.toLowerCase();
  const queue: XmlNode[] = [...node.children];
  while (queue.length > 0) {
    const current = queue.shift() as XmlNode;
    if (current.name === wanted || current.local === wanted) return current;
    queue.push(...current.children);
  }
  return null;
}
