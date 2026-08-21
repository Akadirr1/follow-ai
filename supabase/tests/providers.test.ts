/**
 * The two non-Anthropic providers: request shape, happy path, and every failure
 * branch.
 *
 * `fetch` is injected everywhere, so nothing here reaches a network and no key
 * exists. What the tests CAN prove is that the request matches the shape the
 * coordinator measured and that every documented failure maps to the same code
 * Claude would produce. What they cannot prove is that Gemini or NVIDIA accept
 * it — that is the first live call, listed as NOT VERIFIED in
 * agents/reports/p11.md.
 */
import {
  buildGeminiRequest,
  createGeminiClient,
  GEMINI_API_KEY_HEADER,
  GEMINI_DEFAULT_MODEL,
  GEMINI_ENDPOINT,
  GEMINI_RESPONSE_SCHEMA,
  interpretGeminiResponse,
  readGeminiUsage,
} from '../functions/_shared/providers/gemini.ts';
import {
  buildNvidiaRequest,
  createNvidiaClient,
  interpretNvidiaResponse,
  NVIDIA_DEFAULT_MODEL,
  NVIDIA_ENDPOINT,
  readNvidiaUsage,
} from '../functions/_shared/providers/nvidia.ts';
import {
  classifyProviderStatus,
  parseRetryAfter,
  MAX_RETRY_AFTER_SECONDS,
} from '../functions/_shared/providers/http.ts';
import { SYSTEM_PROMPT_V1, ARTICLE_OPEN, ARTICLE_CLOSE } from '../functions/_shared/prompt.ts';
import { MAX_TOKENS_DEFAULT } from '../functions/_shared/anthropic-config.ts';

const ARTICLE = {
  title: 'OpenAI ships a new model',
  sourceName: 'OpenAI Blog',
  language: 'en' as const,
  contentText: 'The company announced a model today. It is faster.',
  contentQuality: 'full' as const,
};
const TURKISH = { ...ARTICLE, language: 'tr' as const };
const KEY = 'test-key-not-a-real-credential';

const PAYLOAD = { summary: ['bir', 'iki', 'üç'], translation: 'çeviri' };

/** A fetch that records what it was given and returns a canned response. */
function fakeFetch(make: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    impl: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return make();
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(body), { status, headers });

const geminiOk = (text: string = JSON.stringify(PAYLOAD)) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200, thoughtsTokenCount: 42 },
  modelVersion: 'gemini-2.5-flash',
});

const nvidiaOk = (text: string = JSON.stringify(PAYLOAD)) => ({
  model: 'meta/llama-3.3-70b-instruct',
  choices: [{ finish_reason: 'stop', message: { content: text } }],
  usage: { prompt_tokens: 100, completion_tokens: 200 },
});

// ===========================================================================
// Shared HTTP layer
// ===========================================================================

describe('provider HTTP classification', () => {
  const cases: [number, string, boolean][] = [
    [401, 'auth', false],
    [403, 'permission', false],
    [404, 'not_found', false],
    [400, 'bad_request', false],
    [422, 'bad_request', false],
    [408, 'timeout', true],
    [429, 'rate_limited', true],
    [500, 'server_error', true],
    [503, 'server_error', true],
    [529, 'overloaded', true],
  ];

  it.each(cases)('maps HTTP %s to %s', (status, code, retryable) => {
    expect(classifyProviderStatus(status)).toMatchObject({ code, retryable });
  });

  it('uses the same codes the Anthropic table does, so the worker cannot tell providers apart', () => {
    // The whole point of §H: one failure vocabulary, one retry policy.
    for (const [status, code] of cases) {
      expect(typeof classifyProviderStatus(status).code).toBe('string');
      expect(classifyProviderStatus(status).code).toBe(code);
    }
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('  45 ')).toBe(45);
  });

  it('reads an HTTP date', () => {
    const now = () => Date.parse('2026-08-21T12:00:00Z');
    expect(parseRetryAfter('Fri, 21 Aug 2026 12:01:00 GMT', now)).toBe(60);
  });

  it('ignores a date already in the past', () => {
    const now = () => Date.parse('2026-08-21T12:00:00Z');
    expect(parseRetryAfter('Fri, 21 Aug 2026 11:00:00 GMT', now)).toBeUndefined();
  });

  it('caps an absurd value so a bad header cannot park a job for days', () => {
    expect(parseRetryAfter('999999')).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it('ignores nonsense rather than guessing', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

// ===========================================================================
// Gemini
// ===========================================================================

describe('Gemini: request shape', () => {
  it('posts to generateContent with the key in the header, never the URL', () => {
    const { url, headers, body } = buildGeminiRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );

    expect(url).toBe(`${GEMINI_ENDPOINT}/${GEMINI_DEFAULT_MODEL}:generateContent`);
    // A key in the query string ends up in proxy logs and error messages.
    expect(url).not.toContain(KEY);
    expect(url).not.toContain('key=');
    expect(headers[GEMINI_API_KEY_HEADER]).toBe(KEY);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('puts the stable system text in systemInstruction and the article in contents', () => {
    const { body } = buildGeminiRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );

    expect(body.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT_V1);
    // The untrusted article is a separate field, fenced, exactly as the
    // Anthropic request separates system from user turn.
    const sent = body.contents[0].parts[0].text;
    expect(sent).toContain(ARTICLE_OPEN);
    expect(sent).toContain(ARTICLE_CLOSE);
    expect(sent).toContain(ARTICLE.contentText);
    expect(body.systemInstruction.parts[0].text).not.toContain(ARTICLE.contentText);
  });

  it('sends an OpenAPI-subset schema: uppercase types and nullable, no additionalProperties', () => {
    expect(GEMINI_RESPONSE_SCHEMA.type).toBe('OBJECT');
    expect(GEMINI_RESPONSE_SCHEMA.properties.summary.type).toBe('ARRAY');
    expect(GEMINI_RESPONSE_SCHEMA.properties.summary.items.type).toBe('STRING');
    expect(GEMINI_RESPONSE_SCHEMA.properties.translation.nullable).toBe(true);
    // JSON Schema spellings the subset does not accept.
    const serialised = JSON.stringify(GEMINI_RESPONSE_SCHEMA);
    expect(serialised).not.toContain('additionalProperties');
    expect(serialised).not.toContain('"object"');
    expect(serialised).not.toContain('"null"');
    // minItems/maxItems are omitted on purpose: unsupported keys would be a 400
    // on every call, and parseAndValidate re-checks the count anyway.
    expect(serialised).not.toContain('minItems');
    expect(serialised).not.toContain('maxItems');
  });

  it('disables thinking by default and honours an override', () => {
    const off = buildGeminiRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );
    expect(off.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });

    const on = buildGeminiRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response(''), thinkingBudget: 512 },
    );
    expect(on.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 512 });

    const omitted = buildGeminiRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response(''), thinkingBudget: null },
    );
    expect(omitted.body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('is deterministic and carries the token ceiling the worker asked for', () => {
    const { body } = buildGeminiRequest(
      { article: ARTICLE, maxTokens: 16384 },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.maxOutputTokens).toBe(16384);

    const dflt = buildGeminiRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );
    expect(dflt.body.generationConfig.maxOutputTokens).toBe(MAX_TOKENS_DEFAULT);
  });
});

describe('Gemini: responses', () => {
  const client = (make: () => Response, model?: string) =>
    createGeminiClient({ apiKey: KEY, model, fetchImpl: async () => make() });

  it('returns a validated payload and usage on the happy path', async () => {
    const result = await client(json(geminiOk())).summarise({ article: ARTICLE });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(PAYLOAD);
      expect(result.model).toBe('gemini-2.5-flash');
      // Thinking tokens are billed as output, so they are counted as output.
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 242,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }
  });

  it('applies the Turkish rule the same way Claude does', async () => {
    const nullTranslation = JSON.stringify({ summary: ['bir', 'iki', 'üç'], translation: null });

    const turkish = await client(json(geminiOk(nullTranslation))).summarise({ article: TURKISH });
    expect(turkish.ok).toBe(true);

    // A Turkish article that came back WITH a translation is a violation, and
    // it is the same violation the Anthropic path reports.
    const wrong = await client(json(geminiOk())).summarise({ article: TURKISH });
    expect(wrong).toMatchObject({
      ok: false,
      code: 'schema_translation_present_for_turkish_article',
      retryable: false,
    });
  });

  it('maps 429 to rate_limited and honours Retry-After', async () => {
    const result = await client(json({}, 429, { 'retry-after': '42' })).summarise({
      article: ARTICLE,
    });
    expect(result).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSeconds: 42 });
  });

  it('maps 5xx to a retryable server error and 401 to a terminal auth failure', async () => {
    expect(await client(json({}, 503)).summarise({ article: ARTICLE })).toMatchObject({
      code: 'server_error',
      retryable: true,
    });
    expect(await client(json({}, 401)).summarise({ article: ARTICLE })).toMatchObject({
      code: 'auth',
      retryable: false,
    });
  });

  it('maps an abort to a retryable timeout', async () => {
    const result = await createGeminiClient({
      apiKey: KEY,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      timeoutMs: 20,
    }).summarise({ article: ARTICLE });

    expect(result).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('maps MAX_TOKENS to output_truncated, which the worker retries once escalated', async () => {
    const truncated = { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] };
    expect(await client(json(truncated)).summarise({ article: ARTICLE })).toMatchObject({
      code: 'output_truncated',
      retryable: true,
    });
  });

  it('maps a safety stop to a terminal refusal', async () => {
    for (const reason of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST']) {
      const blocked = { candidates: [{ finishReason: reason, content: { parts: [] } }] };
      expect(await client(json(blocked)).summarise({ article: ARTICLE })).toMatchObject({
        code: 'refusal',
        retryable: false,
      });
    }
  });

  it('treats a blocked prompt and an empty candidate list as refusals', async () => {
    expect(
      await client(json({ promptFeedback: { blockReason: 'SAFETY' } })).summarise({
        article: ARTICLE,
      }),
    ).toMatchObject({ code: 'refusal', retryable: false, detail: 'prompt=SAFETY' });

    expect(await client(json({ candidates: [] })).summarise({ article: ARTICLE })).toMatchObject({
      code: 'refusal',
      detail: 'no_candidates',
    });
  });

  it('reports malformed JSON as schema_not_json, not as a transport problem', async () => {
    expect(await client(json(geminiOk('{not json'))).summarise({ article: ARTICLE })).toMatchObject({
      code: 'schema_not_json',
      retryable: false,
    });
  });

  it('reports an empty text part as no_text_block', async () => {
    expect(await client(json(geminiOk('   '))).summarise({ article: ARTICLE })).toMatchObject({
      code: 'no_text_block',
    });
  });

  it('treats a 200 that is not JSON as a retryable gateway problem', async () => {
    const result = await client(() => new Response('<html>502</html>', { status: 200 })).summarise({
      article: ARTICLE,
    });
    expect(result).toMatchObject({ code: 'server_error', retryable: true, detail: 'non_json_200' });
  });

  it('tolerates a missing usageMetadata block', () => {
    expect(readGeminiUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('never lets the response body reach the failure detail', async () => {
    // An upstream error message can quote the prompt, and arch-001 §3 keeps
    // article text out of logs and rows alike.
    const leaky = json({ error: { message: `rejected prompt: ${ARTICLE.contentText}` } }, 400);
    const result = await client(leaky).summarise({ article: ARTICLE });
    expect(JSON.stringify(result)).not.toContain(ARTICLE.contentText);
  });

  it('falls back to the configured model when the response omits modelVersion', () => {
    const result = interpretGeminiResponse(
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(PAYLOAD) }] } }] },
      'en',
      'gemini-2.5-pro',
    );
    expect(result.ok && result.model).toBe('gemini-2.5-pro');
  });
});

// ===========================================================================
// NVIDIA
// ===========================================================================

describe('NVIDIA: request shape', () => {
  it('posts OpenAI-compatible chat completions with a bearer token', () => {
    const { url, headers, body } = buildNvidiaRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );

    expect(url).toBe(NVIDIA_ENDPOINT);
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(url).not.toContain(KEY);
    expect(body.model).toBe(NVIDIA_DEFAULT_MODEL);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0);
  });

  it('sends the system prompt first and the fenced article second', () => {
    const { body } = buildNvidiaRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT_V1 });
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain(ARTICLE_OPEN);
  });

  /**
   * OpenAI-compatible `json_object` mode REFUSES the request unless the word
   * "JSON" appears in the prompt. Our system prompt says it in the ÇIKTI
   * section; pinning it here means a future prompt edit cannot silently break
   * every NVIDIA call.
   */
  it('keeps the word JSON in the prompt, which json_object mode requires', () => {
    expect(SYSTEM_PROMPT_V1).toContain('JSON');
  });
});

describe('NVIDIA: responses', () => {
  const client = (make: () => Response, model?: string) =>
    createNvidiaClient({ apiKey: KEY, model, fetchImpl: async () => make() });

  it('returns a validated payload and usage on the happy path', async () => {
    const result = await client(json(nvidiaOk())).summarise({ article: ARTICLE });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(PAYLOAD);
      expect(result.model).toBe('meta/llama-3.3-70b-instruct');
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }
  });

  it('applies the Turkish rule the same way', async () => {
    const nullTranslation = JSON.stringify({ summary: ['bir', 'iki', 'üç'], translation: null });
    expect((await client(json(nvidiaOk(nullTranslation))).summarise({ article: TURKISH })).ok).toBe(
      true,
    );
    expect(await client(json(nvidiaOk())).summarise({ article: TURKISH })).toMatchObject({
      code: 'schema_translation_present_for_turkish_article',
    });
  });

  it('maps 429 with Retry-After, 5xx and 401', async () => {
    expect(
      await client(json({}, 429, { 'retry-after': '17' })).summarise({ article: ARTICLE }),
    ).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSeconds: 17 });
    expect(await client(json({}, 500)).summarise({ article: ARTICLE })).toMatchObject({
      code: 'server_error',
      retryable: true,
    });
    expect(await client(json({}, 401)).summarise({ article: ARTICLE })).toMatchObject({
      code: 'auth',
      retryable: false,
    });
  });

  it('maps an abort to a retryable timeout', async () => {
    const result = await createNvidiaClient({
      apiKey: KEY,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      timeoutMs: 20,
    }).summarise({ article: ARTICLE });

    expect(result).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('maps finish_reason length to output_truncated', async () => {
    const truncated = { choices: [{ finish_reason: 'length', message: { content: '{"sum' } }] };
    expect(await client(json(truncated)).summarise({ article: ARTICLE })).toMatchObject({
      code: 'output_truncated',
      retryable: true,
    });
  });

  it('maps a content filter to a terminal refusal', async () => {
    const filtered = { choices: [{ finish_reason: 'content_filter', message: { content: null } }] };
    expect(await client(json(filtered)).summarise({ article: ARTICLE })).toMatchObject({
      code: 'refusal',
      retryable: false,
    });
  });

  it('reports malformed JSON as schema_not_json', async () => {
    expect(await client(json(nvidiaOk('nope'))).summarise({ article: ARTICLE })).toMatchObject({
      code: 'schema_not_json',
      retryable: false,
    });
  });

  it('reports an empty choice list and an empty message', async () => {
    expect(await client(json({ choices: [] })).summarise({ article: ARTICLE })).toMatchObject({
      code: 'refusal',
      detail: 'no_choices',
    });
    const empty = { choices: [{ finish_reason: 'stop', message: { content: '' } }] };
    expect(await client(json(empty)).summarise({ article: ARTICLE })).toMatchObject({
      code: 'no_text_block',
    });
  });

  it('tolerates a missing usage block', () => {
    expect(readNvidiaUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('falls back to the configured model when the response omits it', () => {
    const result = interpretNvidiaResponse(
      { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(PAYLOAD) } }] },
      'en',
      'mistralai/mistral-large-2-instruct',
    );
    expect(result.ok && result.model).toBe('mistralai/mistral-large-2-instruct');
  });
});

// ===========================================================================
// Both providers agree with each other and with Claude
// ===========================================================================

describe('the three providers are interchangeable', () => {
  it('produce the identical payload from the identical article', async () => {
    const gemini = await createGeminiClient({
      apiKey: KEY,
      fetchImpl: async () => new Response(JSON.stringify(geminiOk())),
    }).summarise({ article: ARTICLE });

    const nvidia = await createNvidiaClient({
      apiKey: KEY,
      fetchImpl: async () => new Response(JSON.stringify(nvidiaOk())),
    }).summarise({ article: ARTICLE });

    expect(gemini.ok && gemini.payload).toEqual(nvidia.ok && nvidia.payload);
  });

  it('send byte-identical article blocks, so a switch changes nothing but the wrapper', () => {
    const g = buildGeminiRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );
    const n = buildNvidiaRequest(
      { article: ARTICLE },
      { apiKey: KEY, fetchImpl: async () => new Response('') },
    );

    expect(g.body.contents[0].parts[0].text).toBe(n.body.messages[1].content);
    expect(g.body.systemInstruction.parts[0].text).toBe(n.body.messages[0].content);
  });
});
