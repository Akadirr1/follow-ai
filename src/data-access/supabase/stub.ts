import { DataErrorException, type DataError } from '../../domain/errors';
import type { Repositories } from '../repositories';

/**
 * P6 replaces this file with the real adapter (Supabase JS, `.schema('aigundem')`,
 * Edge Function calls). Until then, asking for `supabase` mode fails loudly at
 * construction: there is no `Result` channel on the factory, and handing back a
 * repository set whose every call errors would let a build ship looking healthy
 * while showing an empty app.
 *
 * Reaching this needs an explicit `EXPO_PUBLIC_DATA_MODE=supabase` *with* both
 * Supabase variables set — `src/config/env.ts` already downgrades an incomplete
 * configuration to mock with a warning, so this cannot fire by accident.
 */
export const SUPABASE_NOT_IMPLEMENTED: DataError = {
  code: 'not_implemented',
  retryable: false,
  message:
    'The supabase data mode is not implemented yet (P6). Set EXPO_PUBLIC_DATA_MODE=mock.',
};

export function createSupabaseRepositories(): Repositories {
  throw new DataErrorException(SUPABASE_NOT_IMPLEMENTED);
}
