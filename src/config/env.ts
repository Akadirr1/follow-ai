/**
 * The single place this app reads `process.env`.
 *
 * Expo's babel plugin inlines `process.env.EXPO_PUBLIC_*` only when it sees the
 * static member expression literally, so the three reads below must stay written
 * out. Passing `process.env` around as an object would silently produce
 * `undefined` in a production bundle — which is exactly the kind of failure that
 * looks like "config not set" instead of "code is wrong". Everything downstream
 * imports `env`, and the resolver is exported pure so tests can drive it.
 */

export type DataMode = 'mock' | 'supabase';

export const DATA_MODES: readonly DataMode[] = ['mock', 'supabase'];

/**
 * Where an unusable configuration lands. Always `mock`: it is the only mode that
 * works with no backend, and it must stay separate from `DEFAULT_DATA_MODE`
 * below — if the fallback pointed at the default, a production build with a
 * missing key would "fall back" to supabase and loop.
 */
export const FALLBACK_DATA_MODE: DataMode = 'mock';

/**
 * What an *unset* `EXPO_PUBLIC_DATA_MODE` means, which differs by build type
 * (P10): a production bundle should talk to Supabase, while dev and test stay on
 * the prototype fixtures so nobody needs credentials to run the app or the suite.
 *
 * `__DEV__` is the only signal available at module scope that distinguishes the
 * two, and Metro defines it in every bundle. Jest sets it too, so tests keep
 * getting `mock` without any per-test configuration.
 *
 * An explicit `EXPO_PUBLIC_DATA_MODE` always wins over this — a developer can
 * point a dev build at Supabase, and a release build can be pinned to mock.
 */
export function defaultDataModeFor(isDev: boolean): DataMode {
  return isDev ? 'mock' : 'supabase';
}

declare const __DEV__: boolean | undefined;

/** Treat an absent `__DEV__` as a development build: the safer of the two. */
export const IS_DEV: boolean = typeof __DEV__ === 'boolean' ? __DEV__ : true;

export const DEFAULT_DATA_MODE: DataMode = defaultDataModeFor(IS_DEV);

export type RawEnv = {
  dataMode: string | undefined;
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
};

export type AppEnv = Readonly<{
  dataMode: DataMode;
  /** Non-null only when `dataMode === 'supabase'`. */
  supabaseUrl: string | null;
  /** Non-null only when `dataMode === 'supabase'`. Public by design (addendum §F). */
  supabaseAnonKey: string | null;
}>;

const trim = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const isDataMode = (value: string): value is DataMode =>
  (DATA_MODES as readonly string[]).includes(value);

/**
 * Resolve raw strings into validated config. Every rejection is announced: a
 * silent fallback to mock would look identical to a working Supabase build until
 * someone noticed the data never changed.
 */
export function resolveEnv(
  raw: RawEnv,
  defaults: { defaultMode: DataMode } = { defaultMode: DEFAULT_DATA_MODE },
): AppEnv {
  const requested = trim(raw.dataMode);
  const url = trim(raw.supabaseUrl);
  const anonKey = trim(raw.supabaseAnonKey);

  let mode: DataMode = defaults.defaultMode;
  if (requested === undefined) {
    mode = defaults.defaultMode;
  } else if (isDataMode(requested)) {
    mode = requested;
  } else {
    console.warn(
      `[config] EXPO_PUBLIC_DATA_MODE="${requested}" is not one of ${DATA_MODES.join(
        ' | ',
      )}; falling back to "${FALLBACK_DATA_MODE}".`,
    );
    mode = FALLBACK_DATA_MODE;
  }

  if (mode === 'supabase') {
    const missing: string[] = [];
    if (!url) missing.push('EXPO_PUBLIC_SUPABASE_URL');
    if (!anonKey) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    if (missing.length > 0) {
      console.warn(
        `[config] EXPO_PUBLIC_DATA_MODE="supabase" but ${missing.join(
          ' and ',
        )} ${missing.length === 1 ? 'is' : 'are'} missing; falling back to "${FALLBACK_DATA_MODE}".`,
      );
      return Object.freeze({
        dataMode: FALLBACK_DATA_MODE,
        supabaseUrl: null,
        supabaseAnonKey: null,
      });
    }
  }

  return Object.freeze({
    dataMode: mode,
    supabaseUrl: mode === 'supabase' ? (url as string) : null,
    supabaseAnonKey: mode === 'supabase' ? (anonKey as string) : null,
  });
}

/** Read once at module load; the three literal reads are what babel inlines. */
export const env: AppEnv = resolveEnv({
  dataMode: process.env.EXPO_PUBLIC_DATA_MODE,
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});
