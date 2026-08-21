import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppIcon } from '../src/components/AppIcon';
import { ErrorState, LoadingState } from '../src/components/StateViews';
import { Toggle } from '../src/components/Toggle';
import { useSources } from '../src/data-access/hooks';
import { useDigestNotifications } from '../src/notifications/useDigestNotifications';
import { DIGEST_TIMES, type DigestTime } from '../src/notifications/NotificationService';
import type { Palette } from '../src/theme/palettes';
import { useTheme, useThemedStyles } from '../src/theme/ThemeProvider';
import { fonts, mono, radius } from '../src/theme/typography';
import { completeOnboarding } from '../src/user-state/onboarding';

/**
 * First run. Three short steps, all on one scroll: which sources, what time, and
 * an optional permission ask.
 *
 * The prototype has no onboarding screen, so every string here is new; they are
 * listed in `agents/reports/p9.md`. The register follows the design board —
 * second person singular, no exclamation marks.
 */

/** Shown whenever the selection is empty; also the failure message from `start`. */
export const NO_SOURCE_NOTICE = 'En az bir kaynak seç.';

export default function OnboardingScreen() {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const sources = useSources();
  const notifications = useDigestNotifications();

  const catalog = useMemo(() => sources.data ?? [], [sources.data]);
  /** Every default starts on; the user narrows rather than builds from nothing. */
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [time, setTime] = useState<DigestTime>('08:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = catalog.filter((source) => !disabled.has(source.id));
  const canStart = selected.length > 0 && !busy;
  /**
   * A disabled button with no reason is a dead end, so the requirement is stated
   * as soon as it is unmet rather than waiting for a press that cannot happen.
   */
  const notice = selected.length === 0 ? NO_SOURCE_NOTICE : error;

  const toggle = (id: string) => {
    setError(null);
    setDisabled((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const askPermission = async () => {
    // The explanatory copy above this button is the "explanatory UI" the OS
    // guidelines ask for; only now does the system dialog appear.
    const result = await notifications.enable(time);
    if (!result.ok && result.status === 'permission_denied') {
      setError(
        'Bildirim izni verilmedi. Digest saatin kayıtlı kalır; izni daha sonra telefon ayarlarından açabilirsin.',
      );
    }
  };

  const start = async () => {
    if (selected.length === 0) {
      setError(NO_SOURCE_NOTICE);
      return;
    }
    setBusy(true);
    setError(null);

    const result = await completeOnboarding({
      sourceIds: selected.map((source) => source.id),
      digestTime: time,
      // Only claim the reminder is on if the OS will actually deliver it.
      digestEnabled: notifications.canNotify,
    });

    if (!result.ok) {
      setBusy(false);
      setError(NO_SOURCE_NOTICE);
      return;
    }

    // No navigation here, on purpose (fix-006). `completeOnboarding` publishes
    // the marker, `_layout`'s guard flips in the same tick, and React Navigation
    // swaps the stack itself: `onboarding` leaves `routeNames`, its route is
    // filtered out of the state, and `getStateForRouteNamesChange` pushes the
    // first screen that is now available — `(tabs)`.
    //
    // Navigating from here is what broke: `router.replace('/(tabs)')` ran while
    // the guard still said `false`, so `(tabs)` was not in the navigator at all
    // and the action went unhandled.
  };

  if (sources.isPending) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <LoadingState />
      </SafeAreaView>
    );
  }

  if (sources.isError) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <AppIcon size={56} radius={14} />
          <Text style={styles.title}>AI Gündem&apos;e hoş geldin</Text>
          <Text style={styles.lede}>
            Yapay zekâ haberlerini tek akışta topluyoruz, Türkçe özetliyoruz. Başlamak için iki
            şey seç.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>KAYNAKLAR</Text>
          <Text style={styles.sectionHint}>
            Takip etmek istemediklerini kapat. En az bir kaynak açık kalmalı.
          </Text>
          <View style={styles.group}>
            {catalog.map((source, index) => {
              const on = !disabled.has(source.id);
              return (
                <View
                  key={source.id}
                  style={[styles.row, index < catalog.length - 1 && styles.rowDivided]}
                >
                  <View style={styles.tile}>
                    <Text style={styles.tileText}>{source.tile}</Text>
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{source.name}</Text>
                    <Text style={styles.rowSub}>
                      {source.category} · {source.language.toUpperCase()}
                    </Text>
                  </View>
                  <Toggle on={on} onToggle={() => toggle(source.id)} accessibilityLabel={source.name} />
                </View>
              );
            })}
          </View>
          <Text style={styles.count}>{selected.length} kaynak seçili</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>GÜNLÜK DIGEST</Text>
          <Text style={styles.sectionHint}>
            Her sabah günün beş haberini tek ekranda özetliyoruz. Hangi saatte hazır olsun?
          </Text>
          <View style={styles.slots}>
            {DIGEST_TIMES.map((slot) => {
              const active = time === slot;
              return (
                <Pressable
                  key={slot}
                  onPress={() => setTime(slot)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={[styles.slot, active ? styles.slotOn : styles.slotOff]}
                >
                  <Text style={[styles.slotText, active ? styles.slotTextOn : styles.slotTextOff]}>
                    {slot}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>BİLDİRİM</Text>
          <Text style={styles.sectionHint}>
            Digest hazır olduğunda tek bir bildirim göndeririz. Başka hiçbir şey için bildirim
            almazsın. İstemezsen bu adımı atlayabilirsin.
          </Text>
          {notifications.canNotify ? (
            <View style={styles.granted}>
              <Text style={styles.grantedText}>Bildirim izni verildi · {time}</Text>
            </View>
          ) : (
            <Pressable
              onPress={() => void askPermission()}
              accessibilityRole="button"
              style={({ pressed }) => [styles.secondary, pressed && styles.secondaryPressed]}
            >
              <Text style={styles.secondaryText}>Bildirimlere izin ver</Text>
            </Pressable>
          )}
        </View>

        {notice ? (
          <Text style={styles.error} accessibilityRole="alert">
            {notice}
          </Text>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={() => void start()}
          disabled={!canStart}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canStart }}
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: pressed ? palette.accentPressed : palette.accent },
            !canStart && styles.ctaDisabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={palette.onAccent} />
          ) : (
            <Text style={styles.ctaText}>Başla</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (palette: Palette) => ({
  screen: { flex: 1, backgroundColor: palette.appBg },
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 24, gap: 24 },
  hero: { gap: 10 },
  title: { fontSize: 24, fontFamily: fonts.xb, color: palette.text, marginTop: 6 },
  lede: { fontSize: 14, fontFamily: fonts.r, color: palette.text6, lineHeight: 21 },
  section: { gap: 8 },
  sectionLabel: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.5,
    color: palette.text45,
  },
  sectionHint: { fontSize: 13, fontFamily: fonts.r, color: palette.text55, lineHeight: 19.5 },
  group: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    marginTop: 4,
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    minHeight: 60,
  },
  rowDivided: { borderBottomWidth: 1, borderBottomColor: palette.borderRow },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radius.tile,
    backgroundColor: palette.tile,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  tileText: { fontSize: 12, fontFamily: fonts.xb, color: palette.lightAccent },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 15, fontFamily: fonts.sb, color: palette.text },
  rowSub: { fontSize: 12, fontFamily: fonts.r, color: palette.text55 },
  count: { fontSize: 12, fontFamily: fonts.sb, color: palette.accentText, marginTop: 2 },
  slots: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8, marginTop: 4 },
  slot: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: radius.seg,
    borderWidth: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  slotOn: { backgroundColor: palette.accent, borderColor: palette.accent },
  slotOff: { backgroundColor: 'transparent', borderColor: palette.borderChip },
  slotText: { fontFamily: mono, fontSize: 15, fontWeight: '700' as const },
  slotTextOn: { color: palette.onAccent },
  slotTextOff: { color: palette.text75 },
  granted: {
    backgroundColor: palette.accentSoft,
    borderRadius: radius.seg,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 4,
  },
  grantedText: { fontSize: 13, fontFamily: fonts.sb, color: palette.accentText },
  secondary: {
    height: 48,
    borderWidth: 1,
    borderColor: palette.borderChip,
    borderRadius: radius.seg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginTop: 4,
  },
  secondaryPressed: { backgroundColor: palette.accentSoft },
  secondaryText: { fontSize: 14, fontFamily: fonts.sb, color: palette.accentText },
  error: { fontSize: 13, fontFamily: fonts.sb, color: palette.danger, lineHeight: 19.5 },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: palette.borderRow,
    backgroundColor: palette.appBg,
  },
  cta: {
    height: 52,
    borderRadius: radius.seg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { fontSize: 16, fontFamily: fonts.b, color: palette.onAccent },
});
