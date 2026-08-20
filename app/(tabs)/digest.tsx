import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppIcon } from '../../src/components/AppIcon';
import {
  DIGEST,
  DIGEST_DATE,
  DIGEST_HEADLINE,
  DIGEST_META,
} from '../../src/data/digest';
import { useStore } from '../../src/store/StoreProvider';
import { colors, fonts, mono, radius } from '../../src/theme/tokens';

/** Static in the prototype apart from the digest time badge. */
export default function DigestScreen() {
  const { digestTime } = useStore();

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.date}>{DIGEST_DATE}</Text>
          <Text style={styles.headline}>{DIGEST_HEADLINE}</Text>
          <View style={styles.badgeRow}>
            <View style={styles.readyBadge}>
              <Text style={styles.readyText}>Hazır · {digestTime}</Text>
            </View>
            <Text style={styles.meta}>{DIGEST_META}</Text>
          </View>
        </View>
        <AppIcon size={56} radius={14} />
      </View>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {DIGEST.map((d, i) => (
          <View key={d.no} style={styles.card}>
            <View style={[styles.no, i === 0 ? styles.noLead : styles.noRest]}>
              <Text style={[styles.noText, i === 0 ? styles.noTextLead : styles.noTextRest]}>
                {d.no}
              </Text>
            </View>
            <View style={styles.cardBody}>
              <Text style={styles.title}>{d.title}</Text>
              <Text style={styles.line}>{d.line}</Text>
              <Text style={styles.source}>{d.meta}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.appBg },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerText: { flex: 1 },
  date: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.accentText,
  },
  headline: { fontSize: 24, fontFamily: fonts.xb, color: colors.text, marginTop: 6 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  readyBadge: {
    backgroundColor: colors.paleChip,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  readyText: { color: colors.appBg, fontSize: 11, fontFamily: fonts.b },
  meta: { fontSize: 12, fontFamily: fonts.r, color: colors.text55 },
  list: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 24, gap: 10 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 12,
  },
  no: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noLead: { backgroundColor: colors.paleChip },
  noRest: { backgroundColor: colors.accentSoft },
  noText: { fontFamily: mono, fontSize: 13, fontWeight: '800' },
  noTextLead: { color: colors.appBg },
  noTextRest: { color: colors.accentText },
  cardBody: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontFamily: fonts.sb, color: colors.text, lineHeight: 21 },
  line: {
    fontSize: 13,
    fontFamily: fonts.r,
    color: colors.text6,
    lineHeight: 19.5,
    marginTop: 4,
  },
  source: { fontSize: 11, fontFamily: fonts.r, color: colors.text45, marginTop: 6 },
});
