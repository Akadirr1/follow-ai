import type { Result } from '../domain/errors';
import type {
  Article,
  ArticleId,
  Cursor,
  DigestSnapshot,
  EnrichmentResult,
  Page,
  Source,
  SourceId,
} from '../domain/types';

/**
 * Repository contract version. Bump when a signature changes shape rather than
 * editing the `V1` interfaces in place: two adapters (mock, supabase) and the
 * persisted query cache all key off this, so a silent signature change would let
 * a stale cache deserialize into the wrong DTO (arch-001 §4, "versioned").
 */
export const REPOSITORY_CONTRACT_VERSION = 1 as const;
export type RepositoryContractVersion = typeof REPOSITORY_CONTRACT_VERSION;

/** Bounds every page request; adapters clamp rather than reject (arch-001 §6: no unbounded queries). */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export type ListArticlesParams = {
  /** Null/undefined starts at the newest article. */
  cursor?: Cursor | null;
  /** Clamped to `1..MAX_PAGE_SIZE`; defaults to `DEFAULT_PAGE_SIZE`. */
  limit?: number;
  /** Restrict to these sources. Undefined means every active source. */
  sourceIds?: readonly SourceId[];
  /** Single category filter; null/undefined means all categories. */
  category?: string | null;
};

export type SearchArticlesParams = {
  query: string;
  cursor?: Cursor | null;
  limit?: number;
};

export interface FeedRepositoryV1 {
  readonly version: RepositoryContractVersion;
  listArticles(params?: ListArticlesParams): Promise<Result<Page<Article>>>;
  getArticle(id: ArticleId): Promise<Result<Article>>;
  /** Case-insensitive match over title + source name + category. */
  searchArticles(params: SearchArticlesParams): Promise<Result<Page<Article>>>;
}

export interface SourceRepositoryV1 {
  readonly version: RepositoryContractVersion;
  /** The catalog's active sources, default and device-added alike. */
  listSources(): Promise<Result<Source[]>>;
  /**
   * Add a custom source by feed or site URL. Failure is a typed `DataError`
   * (`invalid_input`, `unsupported_source`, `duplicate_source`, `network`), never
   * a thrown string.
   */
  addSourceByUrl(url: string): Promise<Result<Source>>;
}

export interface DigestRepositoryV1 {
  readonly version: RepositoryContractVersion;
  /** Ready digest or `{status:'preparing'}` — both are success. */
  getLatestDigest(): Promise<Result<DigestSnapshot>>;
}

export interface EnrichmentRepositoryV1 {
  readonly version: RepositoryContractVersion;
  /** Ask for an article's summary/translation: `ready` now, or `queued` for later. */
  requestEnrichment(articleId: ArticleId): Promise<Result<EnrichmentResult>>;
}

/** Aliases pointing at the current version — what callers should import. */
export type FeedRepository = FeedRepositoryV1;
export type SourceRepository = SourceRepositoryV1;
export type DigestRepository = DigestRepositoryV1;
export type EnrichmentRepository = EnrichmentRepositoryV1;

export type Repositories = {
  readonly version: RepositoryContractVersion;
  readonly mode: 'mock' | 'supabase';
  readonly feed: FeedRepository;
  readonly sources: SourceRepository;
  readonly digest: DigestRepository;
  readonly enrichment: EnrichmentRepository;
};
