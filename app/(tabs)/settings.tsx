import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DigestTimeSheet } from '../../src/components/DigestTimeSheet';
import { ChevronRightIcon } from '../../src/components/Icons';
import { Toggle } from '../../src/components/Toggle';
import { useDispatch, useStore } from '../../src/store/StoreProvider';
import { TOASTS } from '../../src/store/types';
import { colors, fonts, mono, radius } from '../../src/theme/tokens';

const THEMES = ['Koyu', 'Açık', 'Sistem'] as const;

export default function SettingsScreen() {
  const state = useStore();
  const dispatch = useDispatch();
  const themeTap = () => dispatch({ type: 'toast', text: TOASTS.theme });

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
                on={state.translate}
                onToggle={() => dispatch({ type: 'toggleTranslate' })}
                accessibilityLabel="Otomatik çeviri"
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={[styles.rowTitle, styles.grow]}>Özet uzunluğu</Text>
              <Text style={styles.rowValue}>Orta</Text>
              <ChevronRightIcon />
            </View>
          </View>
        </View>

        <View>
          <Text style={styles.sectionLabel}>GÜNLÜK DIGEST</Text>
          <View style={styles.group}>
            <Pressable
              onPress={() => dispatch({ type: 'openSheet' })}
              accessibilityRole="button"
              style={styles.row}
            >
              <Text style={[styles.rowTitle, styles.grow]}>Digest saati</Text>
              <View style={styles.timeBadge}>
                <Text style={styles.timeBadgeText}>{state.digestTime}</Text>
              </View>
              <ChevronRightIcon />
            </Pressable>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Digest bildirimi</Text>
                <Text style={styles.rowSub}>Hazır olunca haber ver</Text>
              </View>
              {/* Fixed on in the prototype — no handler, so it stays decorative. */}
              <Toggle on />
            </View>
          </View>
        </View>

        <View>
          <Text style={styles.sectionLabel}>GÖRÜNÜM</Text>
          <View style={[styles.group, styles.themeGroup]}>
            <Text style={[styles.rowTitle, styles.grow]}>Tema</Text>
            <View style={styles.segment}>
              {THEMES.map((t) => {
                const active = t === 'Koyu';
                return (
                  <Pressable
                    key={t}
                    onPress={active ? undefined : themeTap}
                    accessibilityRole="button"
                    style={[
                      styles.segItem,
                      active && { backgroundColor: colors.accent },
                    ]}
                  >
                    <Text
                      style={[
                        styles.segText,
                        { color: active ? colors.white : colors.text6 },
                      ]}
                    >
                      {t}
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
              <ChevronRightIcon />
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={[styles.rowTitle, styles.grow]}>Sürüm</Text>
              <Text style={styles.version}>1.0.0 · Expo SDK 54</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      <DigestTimeSheet />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.appBg },
  header: { paddingHorizontal: 20, paddingTop: 14 },
  title: { fontSize: 21, fontFamily: fonts.xb, color: colors.text },
  list: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24, gap: 18 },
  sectionLabel: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.text45,
    marginBottom: 8,
  },
  group: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    paddingVertical: 2,
  },
  themeGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 },
  rowText: { flex: 1 },
  grow: { flex: 1 },
  rowTitle: { fontSize: 15, fontFamily: fonts.sb, color: colors.text },
  rowSub: { fontSize: 12, fontFamily: fonts.r, color: colors.text55 },
  rowValue: { fontSize: 14, fontFamily: fonts.r, color: colors.text55 },
  divider: { height: 1, backgroundColor: colors.borderRow },
  timeBadge: {
    backgroundColor: colors.accentSoft,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  timeBadgeText: {
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '700',
    color: colors.accentText,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.borderSeg,
    borderRadius: 12,
    padding: 3,
  },
  segItem: { paddingVertical: 7, paddingHorizontal: 13, borderRadius: 9 },
  segText: { fontSize: 13, fontFamily: fonts.sb },
  version: { fontFamily: mono, fontSize: 12, color: colors.text5 },
});
