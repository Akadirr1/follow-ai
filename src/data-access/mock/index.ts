import { REPOSITORY_CONTRACT_VERSION, type Repositories } from '../repositories';
import {
  createMockDigestRepository,
  createMockEnrichmentRepository,
  createMockFeedRepository,
  createMockSourceRepository,
} from './repositories';

/** The full mock repository set — the default data mode until P6 lands Supabase. */
export function createMockRepositories(): Repositories {
  return {
    version: REPOSITORY_CONTRACT_VERSION,
    mode: 'mock',
    feed: createMockFeedRepository(),
    sources: createMockSourceRepository(),
    digest: createMockDigestRepository(),
    enrichment: createMockEnrichmentRepository(),
  };
}

export * from './mapper';
export * from './repositories';
