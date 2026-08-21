import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppIcon } from '../../src/components/AppIcon';
import { EmptyState } from '../../src/components/EmptyState';
import { ErrorState, LoadingState } from '../../src/components/StateViews';
import { useDigest } from '../../src/data-access/hooks';
import { openArticle } from '../../src/navigation/openArticle';
import type { Palette } from '../../src/theme/palettes';
import { useThemedStyles } from '../../src/theme/ThemeProvider';
import { fonts, mono, radius, TAB_BAR_SPACE } from '../../src/theme/typography';
import { useUserSettings } from '../../src/user-state/hooks';

const MONTHS_TR_UPPER = [
  'OCAK', 'ŞUBAT', 'MART', 'NİSAN', 'MAYIS', 'HAZİRAN',
  'TEMMUZ', 'AĞUSTOS', 'EYLÜL', 'EKİM', 'KASIM', 'ARALIK',
];
const DAYS_TR_UPPER = [
  'PAZAR', 'PAZARTESİ', 'SALI', 'ÇARŞAMBA', 'PERŞEMBE', 'CUMA', 'CUMARTESİ',
];

/** "20 AĞUSTOS 2026 · PERŞEMBE" from the digest's own `YYYY-MM-DD`. */
export function digestDateLine(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    console.warn(`[digest] "${isoDate}" is not a parseable date.`);
    return '';
  }
  return `${date.getDate()} ${MONTHS_TR_UPPER[date.getMonth()]} ${date.getFullYear()} · ${
    DAYS_TR_UPPER[date.getDay()]
  }`;
}

export default function DigestScreen() {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const digest = useDigest();
  const { settings } = useUserSettings();

  if (digest.isPending) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <LoadingState />
      </SafeAreaView>
    );
  }

  if (digest.isError) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <ErrorState error={digest.error} onRetry={() => void digest.refetch()} />
      </SafeAreaView>
    );
  }

  // addendum §E: with no Anthropic key the digest legitimately never finalises.
  if (digest.data?.status !== 'ready') {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <EmptyState
          iconSize={90}
          iconRadius={21}
          title="Digest hazırlanıyor"
          line={`Günlük özet her gün ${settings.digestTime} civarında hazır olur.`}
          paddingVertical={100}
        />
      </SafeAreaView>
    );
  }

  const { digest: ready } = digest.data;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.date}>{digestDateLine(ready.date)}</Text>
          <Text style={styles.headline}>Bugünün AI Gündemi</Text>
          <View style={styles.badgeRow}>
            <View style={styles.readyBadge}>
              <Text style={styles.readyText}>Hazır · {settings.digestTime}</Text>
            </View>
            <Text style={styles.meta}>{ready.items.length} haber · ~3 dk</Text>
          </View>
        </View>
        <AppIcon size={56} radius={14} />
      </View>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {ready.items.map((item, index) => (
          <Pressable
            key={`${item.position}-${item.articleId}`}
            onPress={() => openArticle(router, item.articleId)}
            accessibilityRole="button"
            style={styles.card}
          >
            <View style={[styles.no, index === 0 ? styles.noLead : styles.noRest]}>
              <Text style={[styles.noText, index === 0 ? styles.noTextLead : styles.noTextRest]}>
                {String(item.position).padStart(2, '0')}
              </Text>
            </View>
            <View style={styles.cardBody}>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.line}>{item.blurb}</Text>
              <Text style={styles.source}>
                {item.sourceName} · {item.category}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (palette: Palette) => ({
  screen: { flex: 1, backgroundColor: palette.appBg },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: 12,
  },
  headerText: { flex: 1 },
  date: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.5,
    color: palette.accentText,
  },
  headline: { fontSize: 24, fontFamily: fonts.xb, color: palette.text, marginTop: 6 },
  badgeRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    marginTop: 8,
  },
  readyBadge: {
    backgroundColor: palette.paleChip,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  readyText: { color: palette.appBg, fontSize: 11, fontFamily: fonts.b },
  meta: { fontSize: 12, fontFamily: fonts.r, color: palette.text55 },
  list: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: TAB_BAR_SPACE,
    gap: 10,
  },
  card: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.card,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row' as const,
    gap: 12,
  },
  no: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  noLead: { backgroundColor: palette.paleChip },
  noRest: { backgroundColor: palette.accentSoft },
  noText: { fontFamily: mono, fontSize: 13, fontWeight: '800' as const },
  noTextLead: { color: palette.appBg },
  noTextRest: { color: palette.accentText },
  cardBody: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontFamily: fonts.sb, color: palette.text, lineHeight: 21 },
  line: {
    fontSize: 13,
    fontFamily: fonts.r,
    color: palette.text6,
    lineHeight: 19.5,
    marginTop: 4,
  },
  source: { fontSize: 11, fontFamily: fonts.r, color: palette.text45, marginTop: 6 },
});
