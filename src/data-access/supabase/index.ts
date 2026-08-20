import { REPOSITORY_CONTRACT_VERSION, type Repositories } from '../repositories';
import { getSupabaseClient } from './client';
import {
  createSupabaseDigestRepository,
  createSupabaseEnrichmentRepository,
  createSupabaseFeedRepository,
  createSupabaseSourceRepository,
} from './repositories';

/**
 * The Supabase repository set. Replaces the P1 stub that threw
 * `not_implemented` — `EXPO_PUBLIC_DATA_MODE=supabase` now builds a real client.
 */
export function createSupabaseRepositories(): Repositories {
  const client = getSupabaseClient();
  return {
    version: REPOSITORY_CONTRACT_VERSION,
    mode: 'supabase',
    feed: createSupabaseFeedRepository(client),
    sources: createSupabaseSourceRepository(client),
    digest: createSupabaseDigestRepository(client),
    enrichment: createSupabaseEnrichmentRepository(),
  };
}

export * from './client';
export * from './edge';
export * from './mapper';
export * from './repositories';
