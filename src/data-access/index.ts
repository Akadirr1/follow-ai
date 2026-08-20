/**
 * The data-access seam's front door. Screens and hooks import `getRepositories()`
 * and the domain DTOs from here; nothing above this layer knows whether the data
 * came from the prototype fixtures or from Supabase.
 */
import { env, type DataMode } from '../config/env';
import { createMockRepositories } from './mock';
import { createSupabaseRepositories } from './supabase';
import type { Repositories } from './repositories';

export * from './repositories';
export type {
  Article,
  ArticleId,
  ArticleSummary,
  Cursor,
  Digest,
  DigestItem,
  DigestSnapshot,
  EnrichmentResult,
  Iso,
  Language,
  Page,
  Source,
  SourceId,
  TranslationState,
} from '../domain/types';
export {
  DataErrorException,
  isDataErrorException,
  type DataError,
  type DataErrorCode,
  type Result,
} from '../domain/errors';

let cached: Repositories | null = null;

/**
 * Build (or reuse) the repository set for a data mode.
 *
 * Defaults to the validated `env.dataMode`. The instance is memoised per mode so
 * callers share one set; passing an explicit mode bypasses the cache, which is what
 * tests want.
 */
export function getRepositories(mode: DataMode = env.dataMode): Repositories {
  if (mode === env.dataMode && cached) return cached;

  const repositories =
    mode === 'supabase' ? createSupabaseRepositories() : createMockRepositories();

  if (mode === env.dataMode) cached = repositories;
  return repositories;
}

/** Drops the memoised set. Only useful when a test or P6 swaps modes at runtime. */
export function resetRepositories(): void {
  cached = null;
}
