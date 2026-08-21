/**
 * Resolving the internal automations secret.
 *
 * Portable: Web APIs only, no Deno globals, no SDK import. Both the environment
 * and the database lookup are injected, so every branch runs under Jest.
 *
 * WHY THIS EXISTS (coordinator, 2026-08-21): the secret cannot be set as an Edge
 * Function environment variable tonight — there is no Supabase CLI token and the
 * MCP has no secrets tool — so `AUTOMATIONS_SECRET` is simply absent from
 * `Deno.env`. The value does exist, in Supabase Vault as
 * `aigundem_automations_secret`, which the cron jobs already read for their
 * `X-Internal-Secret` header. Vault is therefore the source of truth and the
 * environment variable is the fallback, not the other way round.
 *
 * Order matters for a second reason: when the env var is eventually set, it wins
 * without a database round trip on every internal call.
 */

import { AppError } from './error.ts';
import { requireInternalSecret } from './auth.ts';

/** Just the part of `Deno.env` this needs. */
export type SecretEnv = { get(name: string): string | undefined };

/** Reads `aigundem_automations_secret` out of Vault through the RPC wrapper. */
export type SecretRpc = () => Promise<string | null>;

export const AUTOMATIONS_SECRET_ENV = 'AUTOMATIONS_SECRET';
export const AUTOMATIONS_SECRET_NAME = 'aigundem_automations_secret';

/** Below this, `requireInternalSecret` refuses to treat a value as a secret. */
export const MIN_SECRET_LENGTH = 16;

/**
 * The environment first, then Vault. Returns null when neither has it — the
 * caller decides what that means, and `requireInternalSecret` fails closed.
 *
 * A Vault lookup that throws is swallowed into null on purpose: a database
 * hiccup must produce "not configured" (a 500 that fails closed), never an
 * unhandled rejection that could surface as a different status.
 */
export async function resolveInternalSecret(
  env: SecretEnv,
  rpc: SecretRpc,
): Promise<string | null> {
  const fromEnv = (env.get(AUTOMATIONS_SECRET_ENV) ?? '').trim();
  if (fromEnv !== '') return fromEnv;

  let fromVault: string | null = null;
  try {
    fromVault = await rpc();
  } catch {
    return null;
  }

  const trimmed = (fromVault ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Memoise one resolution for the lifetime of a request.
 *
 * Per invocation, not per isolate: an Edge isolate is reused across requests,
 * and a module-level cache would keep serving a rotated secret until the isolate
 * happened to recycle.
 */
export function createInternalSecretResolver(
  env: SecretEnv,
  rpc: SecretRpc,
): () => Promise<string | null> {
  let pending: Promise<string | null> | null = null;
  return () => {
    if (pending === null) pending = resolveInternalSecret(env, rpc);
    return pending;
  };
}

/**
 * Authenticate an internal caller, resolving the expected secret only if the
 * caller presented one at all.
 *
 * The header is checked for presence BEFORE the Vault lookup. Resolving first
 * would let an unauthenticated request force a database round trip on every
 * call — a free amplifier for anyone who finds the URL. A missing header costs
 * nothing to reject.
 *
 * The comparison itself stays in `auth.ts`: same constant-time compare, same
 * fail-closed behaviour, one code path for all three internal functions.
 */
export async function requireResolvedInternalSecret(
  headers: Headers,
  resolve: () => Promise<string | null>,
): Promise<void> {
  const presented = headers.get('x-internal-secret') ?? '';
  if (presented.trim() === '') {
    throw new AppError('unauthorized', 'Invalid or missing internal secret.');
  }

  const expected = await resolve();
  requireInternalSecret(headers, expected ?? undefined);
}
