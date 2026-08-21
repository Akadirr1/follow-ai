/**
 * `EnrichmentDb` over the `aigundem.internal_*` wrappers.
 *
 * Portable: Web APIs only, no Deno globals, no SDK import. Split out of
 * `enrichment.ts` so policy and transport are separate concerns — and so both
 * files stay under the 500-line house limit.
 *
 * Routing is P3's: `AdminClient.rpc` plus an `rpcPrefix`, so the functions call
 * `public.aigundem_internal_*` today and `aigundem.internal_*` once a human
 * exposes the schema (addendum §C.1). The RPC names here are asserted against
 * migration 202608210007 by `supabase/tests/sql-lint-p4.test.ts`: if they ever
 * diverge the function 404s remotely, after a deploy, which is the most
 * expensive place to find a typo.
 */

import { AppError } from './error.ts';
import type {
  ArticleForEnrichment,
  ChargedEnqueueResult,
  EnqueueResult,
  EnrichmentDb,
  EnrichmentJob,
  SummaryRow,
} from './enrichment.ts';
import type { AdminClient } from './supabase-admin.ts';

/**
 * `EnrichmentDb` over the `aigundem.internal_*` wrappers, reached through the
 * same routing P3 established: `AdminClient.rpc` plus an `rpcPrefix`, so the
 * functions call `public.aigundem_internal_*` today and `aigundem.internal_*`
 * once a human exposes the schema (addendum §C.1).
 */
export function createEnrichmentDb(
  client: AdminClient,
  options: { rpcPrefix?: string } = {},
): EnrichmentDb {
  const prefix = options.rpcPrefix ?? '';

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const fn = `${prefix}${name}`;
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      // The message can quote a row; keep it out of the response (arch-001 §3).
      throw new AppError('upstream_error', `Database call ${fn} failed.`);
    }
    return data as T;
  }

  const firstRow = <T>(data: T[] | T | null): T | null => {
    if (data === null || data === undefined) return null;
    return Array.isArray(data) ? (data[0] ?? null) : data;
  };

  return {
    async findSummary(articleId, contentHash, promptVersion, model) {
      return firstRow(
        await call<SummaryRow[] | null>('internal_find_summary', {
          p_article_id: articleId,
          p_content_hash: contentHash,
          p_prompt_version: promptVersion,
          p_model: model,
        }),
      );
    },

    async findArticle(articleId) {
      return firstRow(
        await call<ArticleForEnrichment[] | null>('internal_find_article_for_enrichment', {
          p_article_id: articleId,
        }),
      );
    },

    async enqueueJob(input) {
      const row = firstRow(
        await call<EnqueueResult[] | null>('internal_enqueue_ai_job', {
          p_article_id: input.articleId,
          p_content_hash: input.contentHash,
          p_prompt_version: input.promptVersion,
          p_model: input.model,
        }),
      );
      if (!row) throw new AppError('upstream_error', 'Job could not be enqueued.');
      return row;
    },

    /**
     * rev-003 N1. One round trip that both decides newness and charges, so a
     * poll for an already-queued job costs the caller nothing.
     */
    async enqueueJobCharged(input) {
      const row = firstRow(
        await call<ChargedEnqueueResult[] | ChargedEnqueueResult | null>(
          'internal_enqueue_ai_job_charged',
          {
            p_article_id: input.articleId,
            p_content_hash: input.contentHash,
            p_prompt_version: input.promptVersion,
            p_model: input.model,
            p_subject: input.subject,
            p_action: input.action,
            p_window_start: input.windowStart,
            p_limit: input.limit,
          },
        ),
      );
      if (!row) throw new AppError('upstream_error', 'Job could not be enqueued.');
      return row;
    },

    /**
     * rev-003 B1. The inverse of leasing: clears the lease and gives back the
     * attempt leasing consumed. Lease-token guarded in SQL, so a worker whose
     * lease expired cannot rewind a job another worker now owns.
     */
    async releaseJobUnattempted(jobId, leaseToken, availableAt, errorCode) {
      return (
        (await call<boolean>('internal_release_ai_job_unattempted', {
          p_job_id: jobId,
          p_lease_token: leaseToken,
          p_available_at: availableAt,
          p_error_code: errorCode,
        })) === true
      );
    },

    async leaseJobs(n) {
      const rows = await call<EnrichmentJob[] | null>('internal_lease_enrichment_jobs', { n });
      return rows ?? [];
    },

    async completeJob(jobId, leaseToken, summary) {
      return (
        (await call<boolean>('internal_complete_enrichment', {
          p_job_id: jobId,
          p_lease_token: leaseToken,
          p_content_hash: summary.content_hash,
          p_prompt_version: summary.prompt_version,
          p_model: summary.model,
          p_summary_tr: summary.summary_tr,
          p_translation_tr: summary.translation_tr,
          p_translation_state: summary.translation_state,
        })) === true
      );
    },

    async retryJob(jobId, leaseToken, availableAt, errorCode) {
      return (
        (await call<boolean>('internal_retry_ai_job', {
          p_job_id: jobId,
          p_lease_token: leaseToken,
          p_available_at: availableAt,
          p_error_code: errorCode,
        })) === true
      );
    },

    async failJob(jobId, leaseToken, errorCode) {
      return (
        (await call<boolean>('internal_fail_ai_job', {
          p_job_id: jobId,
          p_lease_token: leaseToken,
          p_error_code: errorCode,
        })) === true
      );
    },

    async bumpRateLimit(subject, action, windowStart, limit) {
      return (
        (await call<boolean>('internal_bump_rate_limit', {
          p_subject: subject,
          p_action: action,
          p_window_start: windowStart,
          p_limit: limit,
        })) === true
      );
    },
  };
}
