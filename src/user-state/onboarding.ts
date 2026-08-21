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

/**
 * The completion marker, as an external store.
 *
 * WHY (fix-006): the root layout used to read the marker once in a mount effect
 * and never again, so `completeOnboarding()` — which only writes KV — could not
 * tell it anything. `<Stack.Protected guard={completed}>` therefore kept `(tabs)`
 * unmounted, and the onboarding screen's `router.replace('/(tabs)')` addressed a
 * route that did not exist: "The action 'REPLACE' … was not handled by any
 * navigator". The device stayed on onboarding until a cold restart.
 *
 * A three-line store fixes it at the source rather than at the call site: the
 * write publishes, the layout subscribes, and the navigator's own guard does the
 * navigating. `undefined` means "not read yet" and is what keeps the launch gate
 * closed, so the distinction between "incomplete" (`null`) and "unknown" has to
 * survive into the snapshot.
 */
export type OnboardingSnapshot = string | null | undefined;

let snapshot: OnboardingSnapshot;
const listeners = new Set<() => void>();
let priming: Promise<void> | null = null;

/** Current completion marker without touching storage. Cheap and synchronous. */
export const getOnboardingSnapshot = (): OnboardingSnapshot => snapshot;

export function subscribeOnboarding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish a new value. Compares first, because `useSyncExternalStore` re-renders
 * every subscriber on notification whether or not the value moved. Iterates a
 * copy so a listener that unsubscribes itself cannot skip the next one.
 */
function publishOnboarding(next: OnboardingSnapshot): void {
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Read the marker once and publish it. Memoised: every mounted subscriber calls
 * this, and a launch must not turn into N storage reads. A failed read publishes
 * `null` — replaying onboarding is recoverable, hanging on the splash is not.
 */
export function primeOnboardingState(storage: KvStore = kv): Promise<void> {
  priming ??= getOnboardingCompletedAt(storage)
    .then((value) => {
      publishOnboarding(value);
    })
    .catch((error: unknown) => {
      console.warn('[onboarding] could not read the completion marker:', error);
      publishOnboarding(null);
    });
  return priming;
}

/**
 * Drops the cached snapshot and the memoised read. Test seam only: module state
 * outlives a test file's `beforeEach` otherwise.
 */
export function resetOnboardingStateForTests(): void {
  snapshot = undefined;
  priming = null;
  listeners.clear();
}

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
  // After the write, never before: a publish that outran a failed write would
  // send the user into tabs with no marker to survive the next launch.
  publishOnboarding(completedAt);
  return { ok: true, completedAt };
}

/** Dev/rollback helper: sends the device back through onboarding. */
export async function resetOnboarding(storage: KvStore = kv): Promise<void> {
  await storage.removeItem(P9_KEYS.onboardingCompletedAt);
  publishOnboarding(null);
}

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
