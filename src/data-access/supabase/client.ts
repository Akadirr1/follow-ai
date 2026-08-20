import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '../../config/env';
import { err, type DataError, type Result } from '../../domain/errors';

/**
 * The one Supabase client. v1 has **no users**: anonymous sign-in is a Dashboard
 * toggle nobody could flip (addendum §A), so the client never authenticates,
 * never persists a session and never refreshes a token. Every request carries the
 * public anon JWT as both `apikey` and bearer; protection is RLS, not identity.
 *
 * `.schema()` is deliberately unused. Schema `aigundem` is not exposed to
 * PostgREST (measured: `Accept-Profile: aigundem` → `PGRST106`, "Only the
 * following schemas are exposed: public, graphql_public"), so reads go to the
 * `public.aigundem_*` shims from migration 0006.
 */

/** The read surface, all in `public` until the human exposes `aigundem`. */
export const FEED_VIEW = 'aigundem_feed_articles_v1';
export const SEARCH_RPC = 'aigundem_search_articles_v1';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    // env.ts already downgrades an incomplete config to mock mode with a warning,
    // so reaching here means someone built a client by hand.
    throw new Error(
      '[supabase] EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY are required in supabase data mode.',
    );
  }
  client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'X-Client-Info': 'ai-gundem/1.0.0' },
    },
  });
  return client;
}

/** Test seam and mode switching: drops the memoised client. */
export function resetSupabaseClient(): void {
  client = null;
}

/** PostgREST error shape, as much of it as we rely on. */
export type PostgrestErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

/**
 * Map a PostgREST failure onto the seam's `DataError`. The codes worth naming
 * are the ones a reader will actually hit tonight: `PGRST205`/`PGRST106` mean the
 * object or schema is not exposed — a deployment gap, not a user error, and the
 * message says so instead of surfacing "unknown error".
 */
export function toDataError(error: PostgrestErrorLike, context: string): DataError {
  const code = error.code ?? '';
  const message = error.message ?? 'Unknown PostgREST error';

  if (code === 'PGRST205' || code === 'PGRST106') {
    return {
      code: 'not_implemented',
      retryable: false,
      message: `${context}: ${message}. The read surface is not exposed to PostgREST yet.`,
      details: { postgrestCode: code },
    };
  }
  if (code === 'PGRST116') {
    return { code: 'not_found', retryable: false, message: `${context}: no matching row.` };
  }
  if (code === '42501') {
    return {
      code: 'server',
      retryable: false,
      message: `${context}: permission denied by RLS or grants.`,
      details: { postgrestCode: code },
    };
  }
  return {
    code: 'server',
    retryable: true,
    message: `${context}: ${message}`,
    ...(code ? { details: { postgrestCode: code } } : {}),
  };
}

/** Wrap a thrown/rejected transport failure — no network, DNS, abort. */
export function toNetworkError<T = never>(error: unknown, context: string): Result<T> {
  return err<T>('network', `${context}: ${error instanceof Error ? error.message : String(error)}`, {
    retryable: true,
  });
}
