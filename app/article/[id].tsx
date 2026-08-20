import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  BackIcon,
  BookmarkIcon,
  ExternalLinkIcon,
  SparkleIcon,
} from '../../src/components/Icons';
import { selectArticle, selectBody } from '../../src/store/selectors';
import { useDispatch, useStore } from '../../src/store/StoreProvider';
import { TOASTS } from '../../src/store/types';
import { colors, fonts, mono, radius } from '../../src/theme/tokens';

export default function ArticleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useStore();
  const dispatch = useDispatch();
  const router = useRouter();

  // `selectArticle` warns and falls back to the prototype's default when the route
  // parameter matches nothing, so a bad deep link cannot render a blank screen.
  const article = selectArticle(id ?? '');
  const { text, label } = selectBody(article, state.seg);
  const saved = !!state.saved[article.id];

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Geri"
          style={({ pressed }) => [
            styles.iconButton,
            pressed && { backgroundColor: 'rgba(37,99,235,.15)' },
          ]}
        >
          <BackIcon />
        </Pressable>
        <View style={styles.headerMid}>
          <Text style={styles.headerSrc}>{article.src}</Text>
          <Text style={styles.headerTime}>{article.time}</Text>
        </View>
        <Pressable
          onPress={() => dispatch({ type: 'toggleSave', id: article.id })}
          accessibilityRole="button"
          accessibilityLabel={saved ? 'Kaydı kaldır' : 'Kaydet'}
          accessibilityState={{ selected: saved }}
          style={[
            styles.iconButton,
            styles.bookmarkButton,
            { backgroundColor: saved ? colors.accentSoft : 'transparent' },
          ]}
        >
          <BookmarkIcon fill={saved ? colors.accentText : 'none'} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.tagRow}>
          <View style={styles.catPill}>
            <Text style={styles.catText}>{article.cat}</Text>
          </View>
          <View style={styles.trPill}>
            <Text style={styles.trText}>EN→TR</Text>
          </View>
        </View>

        <Text style={styles.title}>{article.title}</Text>

        <View style={styles.summaryCard}>
          <View style={styles.summaryHead}>
            <SparkleIcon />
            <Text style={styles.summaryLabel}>AI TR ÖZET</Text>
            <View style={styles.countPill}>
              <Text style={styles.countText}>{article.sum.length} madde</Text>
            </View>
          </View>
          {article.sum.map((b) => (
            <View key={b} style={styles.bulletRow}>
              <View style={styles.bullet} />
              <Text style={styles.bulletText}>{b}</Text>
            </View>
          ))}
          <Text style={styles.credit}>Claude ile çevrildi ve özetlendi · 09:41</Text>
        </View>

        <View style={styles.segment}>
          <Pressable
            onPress={() => dispatch({ type: 'setSeg', seg: 'en' })}
            accessibilityRole="button"
            style={[
              styles.segItem,
              state.seg === 'en' && { backgroundColor: colors.accent },
            ]}
          >
            <Text
              style={[
                styles.segText,
                { color: state.seg === 'en' ? colors.white : colors.text6 },
              ]}
            >
              Orijinal
            </Text>
          </Pressable>
          <Pressable
            onPress={() => dispatch({ type: 'setSeg', seg: 'tr' })}
            accessibilityRole="button"
            style={[
              styles.segItem,
              state.seg === 'tr' && { backgroundColor: colors.accent },
            ]}
          >
            <Text
              style={[
                styles.segText,
                { color: state.seg === 'tr' ? colors.white : colors.text6 },
              ]}
            >
              Çeviri
            </Text>
          </Pressable>
        </View>

        <Text style={styles.bodyLabel}>{label}</Text>
        <Text style={styles.bodyText}>{text}</Text>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={() => dispatch({ type: 'toast', text: TOASTS.openSource })}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: pressed ? colors.accentPressed : colors.accent },
          ]}
        >
          <Text style={styles.ctaText}>Kaynağa git </Text>
          <ExternalLinkIcon />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.appBg },
  header: {
    paddingHorizontal: 16,
    paddingTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: colors.borderControl,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bookmarkButton: { borderColor: colors.borderBookmark },
  headerMid: { flex: 1, minWidth: 0, alignItems: 'center' },
  headerSrc: { fontSize: 14, fontFamily: fonts.sb, color: colors.text },
  headerTime: { fontSize: 11, fontFamily: fonts.r, color: colors.text5 },
  body: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 110, gap: 12 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  catPill: {
    borderWidth: 1,
    borderColor: colors.borderChip,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  catText: { fontSize: 11, fontFamily: fonts.sb, color: colors.accentText },
  trPill: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  trText: { fontSize: 11, fontFamily: fonts.b, color: colors.accentText },
  title: { fontSize: 20, fontFamily: fonts.xb, color: colors.text, lineHeight: 26.4 },
  summaryCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderDetailCard,
    borderRadius: radius.card,
    padding: 16,
    gap: 11,
  },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryLabel: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.3,
    color: colors.accentText,
  },
  countPill: {
    backgroundColor: colors.paleChip,
    borderRadius: radius.pill,
    paddingVertical: 3,
    paddingHorizontal: 8,
    marginLeft: 'auto',
  },
  countText: { fontSize: 10, fontFamily: fonts.b, color: colors.appBg },
  bulletRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  bullet: { width: 6, height: 6, backgroundColor: colors.accentText, marginTop: 7 },
  bulletText: {
    flex: 1,
    fontSize: 14,
    fontFamily: fonts.r,
    lineHeight: 21.7,
    color: colors.textStrong,
  },
  credit: {
    fontSize: 11,
    fontFamily: fonts.r,
    color: colors.text45,
    borderTopWidth: 1,
    borderTopColor: 'rgba(37,99,235,.2)',
    paddingTop: 10,
  },
  segment: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.borderSeg,
    borderRadius: 12,
    padding: 3,
  },
  segItem: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 9 },
  segText: { fontSize: 13, fontFamily: fonts.sb },
  bodyLabel: { fontSize: 11, fontFamily: fonts.sb, color: colors.text45 },
  bodyText: { fontSize: 14, fontFamily: fonts.r, lineHeight: 23.1, color: colors.textBody },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 34,
    backgroundColor: 'rgba(11,18,32,.96)',
  },
  cta: {
    height: 50,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  ctaText: { fontSize: 15, fontFamily: fonts.b, color: colors.white },
});
