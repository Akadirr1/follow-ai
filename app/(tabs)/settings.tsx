import Constants from 'expo-constants';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DigestTimeSheet, type DigestTime } from '../../src/components/DigestTimeSheet';
import { ChevronRightIcon } from '../../src/components/Icons';
import { TOASTS, useToast } from '../../src/components/ToastProvider';
import { Toggle } from '../../src/components/Toggle';
import type { Palette } from '../../src/theme/palettes';
import {
  useTheme,
  useThemePreference,
  useThemedStyles,
  type ThemePreference,
} from '../../src/theme/ThemeProvider';
import { fonts, mono, radius, TAB_BAR_SPACE } from '../../src/theme/typography';
import { useUserSettings } from '../../src/user-state/hooks';

const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: 'dark', label: 'Koyu' },
  { value: 'light', label: 'Açık' },
  { value: 'system', label: 'Sistem' },
];

/**
 * The version line. The prototype hard-coded "1.0.0 · Expo SDK 54"; reading it
 * from the manifest means it cannot drift from what actually shipped.
 */
export function versionLine(
  version: string | null | undefined,
  sdkVersion: string | null | undefined,
): string {
  const app = version ?? '1.0.0';
  return sdkVersion ? `${app} · Expo SDK ${sdkVersion.split('.')[0]}` : app;
}

export default function SettingsScreen() {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { preference, setPreference } = useThemePreference();
  const { settings, update } = useUserSettings();
  const { showToast } = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);

  const saveDigestTime = (time: DigestTime) => {
    // P9 owns the notification schedule; P7 only persists the preference.
    update({ digestTime: time });
    setSheetOpen(false);
    showToast(TOASTS.digestTime);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Ayarlar</Text>
      </View>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        <View>
          <Text style={styles.sectionLabel}>ÇEVİRİ</Text>
          <View style={styles.group}>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Otomatik çeviri</Text>
                <Text style={styles.rowSub}>Yabancı içerik Türkçeye çevrilir</Text>
              </View>
              <Toggle
                on={settings.autoTranslate}
                onToggle={() => update({ autoTranslate: !settings.autoTranslate })}
                accessibilityLabel="Otomatik çeviri"
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={[styles.rowTitle, styles.grow]}>Özet uzunluğu</Text>
              <Text style={styles.rowValue}>Orta</Text>
              <ChevronRightIcon color={palette.text4} />
            </View>
          </View>
        </View>

        <View>
          <Text style={styles.sectionLabel}>GÜNLÜK DIGEST</Text>
          <View style={styles.group}>
            <Pressable
              onPress={() => setSheetOpen(true)}
              accessibilityRole="button"
              style={styles.row}
            >
              <Text style={[styles.rowTitle, styles.grow]}>Digest saati</Text>
              <View style={styles.timeBadge}>
                <Text style={styles.timeBadgeText}>{settings.digestTime}</Text>
              </View>
              <ChevronRightIcon color={palette.text4} />
            </Pressable>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Digest bildirimi</Text>
                <Text style={styles.rowSub}>Hazır olunca haber ver</Text>
              </View>
              <Toggle
                on={settings.digestEnabled}
                onToggle={() => update({ digestEnabled: !settings.digestEnabled })}
                accessibilityLabel="Digest bildirimi"
              />
            </View>
          </View>
        </View>

        <View>
          <Text style={styles.sectionLabel}>GÖRÜNÜM</Text>
          <View style={[styles.group, styles.themeGroup]}>
            <Text style={[styles.rowTitle, styles.grow]}>Tema</Text>
            <View style={styles.segment} accessibilityRole="radiogroup" accessibilityLabel="Tema">
              {THEME_OPTIONS.map(({ value, label }) => {
                const active = preference === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => setPreference(value)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active, checked: active }}
                    accessibilityLabel={label}
                    style={[styles.segItem, active && styles.segItemActive]}
                  >
                    <Text style={[styles.segText, active ? styles.segTextOn : styles.segTextOff]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        <View>
          <Text style={styles.sectionLabel}>HAKKINDA</Text>
          <View style={styles.group}>
            <View style={styles.row}>
              <Text style={[styles.rowTitle, styles.grow]}>Hakkında</Text>
              <ChevronRightIcon color={palette.text4} />
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={[styles.rowTitle, styles.grow]}>Sürüm</Text>
              <Text style={styles.version}>
                {versionLine(
                  Constants.expoConfig?.version,
                  Constants.expoConfig?.sdkVersion ?? Constants.expoVersion,
                )}
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>

      <DigestTimeSheet
        visible={sheetOpen}
        value={settings.digestTime}
        onClose={() => setSheetOpen(false)}
        onSave={saveDigestTime}
      />
    </SafeAreaView>
  );
}

const createStyles = (palette: Palette) => ({
  screen: { flex: 1, backgroundColor: palette.appBg },
  header: { paddingHorizontal: 20, paddingTop: 14 },
  title: { fontSize: 21, fontFamily: fonts.xb, color: palette.text },
  list: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: TAB_BAR_SPACE,
    gap: 18,
  },
  sectionLabel: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.5,
    color: palette.text45,
    marginBottom: 8,
  },
  group: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    paddingVertical: 2,
  },
  themeGroup: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingVertical: 14,
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    minHeight: 56,
  },
  rowText: { flex: 1 },
  grow: { flex: 1 },
  rowTitle: { fontSize: 15, fontFamily: fonts.sb, color: palette.text },
  rowSub: { fontSize: 12, fontFamily: fonts.r, color: palette.text55 },
  rowValue: { fontSize: 14, fontFamily: fonts.r, color: palette.text55 },
  divider: { height: 1, backgroundColor: palette.borderRow },
  timeBadge: {
    backgroundColor: palette.accentSoft,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  timeBadgeText: {
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '700' as const,
    color: palette.accentText,
  },
  segment: {
    flexDirection: 'row' as const,
    backgroundColor: palette.inputBg,
    borderWidth: 1,
    borderColor: palette.borderSeg,
    borderRadius: radius.seg,
    padding: 3,
  },
  segItem: { paddingVertical: 7, paddingHorizontal: 13, borderRadius: 9 },
  segItemActive: { backgroundColor: palette.accent },
  segText: { fontSize: 13, fontFamily: fonts.sb },
  segTextOn: { color: palette.onAccent },
  segTextOff: { color: palette.text6 },
  version: { fontFamily: mono, fontSize: 12, color: palette.text5 },
});
