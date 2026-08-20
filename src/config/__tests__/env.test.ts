import { DEFAULT_DATA_MODE, resolveEnv } from '../env';

describe('env validation', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const raw = (over: Partial<Parameters<typeof resolveEnv>[0]> = {}) => ({
    dataMode: undefined,
    supabaseUrl: undefined,
    supabaseAnonKey: undefined,
    ...over,
  });

  it('defaults to mock with nothing set, and does not warn', () => {
    const env = resolveEnv(raw());
    expect(env.dataMode).toBe('mock');
    expect(env.supabaseUrl).toBeNull();
    expect(env.supabaseAnonKey).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts an explicit mock mode', () => {
    expect(resolveEnv(raw({ dataMode: 'mock' })).dataMode).toBe('mock');
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts supabase mode when both variables are present', () => {
    const env = resolveEnv(
      raw({
        dataMode: 'supabase',
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key',
      }),
    );
    expect(env.dataMode).toBe('supabase');
    expect(env.supabaseUrl).toBe('https://example.supabase.co');
    expect(env.supabaseAnonKey).toBe('anon-key');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to mock and names the missing key', () => {
    const env = resolveEnv(
      raw({ dataMode: 'supabase', supabaseUrl: 'https://example.supabase.co' }),
    );
    expect(env.dataMode).toBe(DEFAULT_DATA_MODE);
    expect(env.supabaseUrl).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('EXPO_PUBLIC_SUPABASE_ANON_KEY'),
    );
  });

  it('falls back to mock and names both variables when neither is set', () => {
    const env = resolveEnv(raw({ dataMode: 'supabase' }));
    expect(env.dataMode).toBe('mock');
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('EXPO_PUBLIC_SUPABASE_URL');
    expect(message).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  });

  it('treats whitespace-only values as missing', () => {
    const env = resolveEnv(
      raw({ dataMode: 'supabase', supabaseUrl: '   ', supabaseAnonKey: '\t' }),
    );
    expect(env.dataMode).toBe('mock');
    expect(warn).toHaveBeenCalled();
  });

  it('warns and falls back to mock for an invalid mode', () => {
    const env = resolveEnv(raw({ dataMode: 'postgres' }));
    expect(env.dataMode).toBe('mock');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EXPO_PUBLIC_DATA_MODE="postgres"'));
  });

  it('trims a valid mode rather than rejecting it', () => {
    expect(resolveEnv(raw({ dataMode: ' supabase ', supabaseUrl: 'u', supabaseAnonKey: 'k' })).dataMode).toBe(
      'supabase',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns a frozen object', () => {
    const env = resolveEnv(raw());
    expect(Object.isFrozen(env)).toBe(true);
  });
});
