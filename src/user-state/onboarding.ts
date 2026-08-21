import { kv, type KvStore } from '../storage/kv';
import { setEnabledSourceIds, updateSettings } from './store';

/**
 * Onboarding completion and the notification bookkeeping that goes with it.
 *
 * These keys live here rather than in `KV_KEYS` because `src/storage/**` is not
 * P9's to edit; they follow the same `v1:aigundem.*` convention so a grep for the
 * prefix still finds every key the app owns.
 */
export const P9_KEYS = {
  /** ISO instant, set once onboarding finishes. Absent = never completed. */
  onboardingCompletedAt: 'v1:aigundem.user.onboarding_completed_at',
  /** Identifier of the one daily-digest schedule this device owns. */
  notificationId: 'v1:aigundem.notifications.digest_id',
  /** Last permission answer we saw, so the UI can explain itself without asking. */
  permissionStatus: 'v1:aigundem.notifications.permission',
} as const;

/** Mirrors `expo-notifications` plus `undetermined` for "never asked". */
export type PermissionStatus = 'undetermined' | 'granted' | 'provisional' | 'denied';

const PERMISSION_STATUSES: readonly PermissionStatus[] = [
  'undetermined',
  'granted',
  'provisional',
  'denied',
];

export const isPermissionStatus = (value: unknown): value is PermissionStatus =>
  typeof value === 'string' && (PERMISSION_STATUSES as readonly string[]).includes(value);

export async function getOnboardingCompletedAt(storage: KvStore = kv): Promise<string | null> {
  const raw = await storage.getItem(P9_KEYS.onboardingCompletedAt);
  if (raw === null) return null;
  if (Number.isNaN(Date.parse(raw))) {
    // Something wrote a non-instant here; treating it as "not completed" replays
    // onboarding, which is recoverable, whereas trusting it is not.
    console.warn(`[onboarding] stored completion "${raw}" is not an instant; treating as incomplete.`);
    return null;
  }
  return raw;
}

export const isOnboardingComplete = async (storage: KvStore = kv): Promise<boolean> =>
  (await getOnboardingCompletedAt(storage)) !== null;

export type OnboardingChoices = {
  sourceIds: string[];
  digestTime: string;
  digestEnabled: boolean;
};

/**
 * Finish onboarding.
 *
 * A key/value store has no transaction, so "atomic" here means **ordered**: the
 * choices are written first and the completion marker last. A crash or a kill
 * part-way leaves the marker absent, so onboarding replays and overwrites the
 * partial state — the failure mode is repeating a 20-second flow, not entering
 * the app with no sources selected.
 *
 * Refuses an empty selection: a device with no sources would land on an empty
 * feed with no explanation.
 */
export async function completeOnboarding(
  choices: OnboardingChoices,
  storage: KvStore = kv,
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: true; completedAt: string } | { ok: false; reason: 'no_sources' }> {
  const sourceIds = [...new Set(choices.sourceIds.filter(Boolean))];
  if (sourceIds.length === 0) {
    console.warn('[onboarding] refusing to complete with no sources selected.');
    return { ok: false, reason: 'no_sources' };
  }

  await setEnabledSourceIds(sourceIds, storage);
  await updateSettings(
    { digestTime: choices.digestTime, digestEnabled: choices.digestEnabled },
    storage,
  );

  const completedAt = now();
  await storage.setItem(P9_KEYS.onboardingCompletedAt, completedAt);
  return { ok: true, completedAt };
}

/** Dev/rollback helper: sends the device back through onboarding. */
export const resetOnboarding = (storage: KvStore = kv): Promise<void> =>
  storage.removeItem(P9_KEYS.onboardingCompletedAt);

export async function getNotificationId(storage: KvStore = kv): Promise<string | null> {
  const raw = await storage.getItem(P9_KEYS.notificationId);
  return raw && raw.trim() ? raw : null;
}

export const setNotificationId = (id: string | null, storage: KvStore = kv): Promise<void> =>
  id === null
    ? storage.removeItem(P9_KEYS.notificationId)
    : storage.setItem(P9_KEYS.notificationId, id);

export async function getPermissionStatus(storage: KvStore = kv): Promise<PermissionStatus> {
  const raw = await storage.getItem(P9_KEYS.permissionStatus);
  if (raw === null) return 'undetermined';
  if (!isPermissionStatus(raw)) {
    console.warn(`[notifications] stored permission "${raw}" is unknown; treating as undetermined.`);
    return 'undetermined';
  }
  return raw;
}

export const setPermissionStatus = (
  status: PermissionStatus,
  storage: KvStore = kv,
): Promise<void> => storage.setItem(P9_KEYS.permissionStatus, status);
