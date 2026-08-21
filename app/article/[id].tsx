import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  BackIcon,
  BookmarkIcon,
  ExternalLinkIcon,
  SparkleIcon,
} from '../../src/components/Icons';
import { ErrorState, LoadingState } from '../../src/components/StateViews';
import { TOASTS, useToast } from '../../src/components/ToastProvider';
import { useArticle, useEnrichment } from '../../src/data-access/hooks';
import type { Article, ArticleSummary } from '../../src/domain/types';
import { relativeTimeTr } from '../../src/format/relativeTime';
import type { Palette } from '../../src/theme/palettes';
import { useTheme, useThemedStyles } from '../../src/theme/ThemeProvider';
import { fonts, mono, radius } from '../../src/theme/typography';
import { useSavedArticles } from '../../src/user-state/hooks';

type Segment = 'tr' | 'en';

/**
 * The Orijinal / Çeviri rule, kept as a pure function so the test can state it
 * without rendering: a Turkish source has no translation to switch to, and an
 * English one cannot switch until Claude has produced the Turkish text.
 */
export function segmentState(article: Article | undefined, summary: ArticleSummary | undefined) {
  const state = summary?.translationState ?? article?.summary?.translationState;
  if (!article || article.language === 'tr' || state === 'not_required') {
    return { visible: false, enabled: false } as const;
  }
  return { visible: true, enabled: state === 'ready' } as const;
}

/** The body the segment selects, with its label. */
export function bodyFor(
  article: Article,
  summary: ArticleSummary | undefined,
  segment: Segment,
): { text: string; label: string } {
  const translation = summary?.translationTr ?? article.summary?.translationTr ?? null;
  return segment === 'tr' && translation
    ? { text: translation, label: 'Çeviri · Türkçe' }
    : { text: article.bodyOriginal, label: 'Orijinal · English' };
}

export default function ArticleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const articleId = id ?? '';
  const router = useRouter();
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { showToast } = useToast();
  const { isSaved, setArticleSaved } = useSavedArticles();

  const query = useArticle(articleId);
  const enrichment = useEnrichment(articleId, { enabled: Boolean(articleId) });
  const article = query.data;

  const summary =
    enrichment.data?.status === 'ready' ? enrichment.data.summary : article?.summary;
  /**
   * Terminal: the server looked and there is no body to summarise (an
   * excerpt-only feed item). Only when nothing else can be shown — a summary
   * already carried on the feed row still wins over a later `unavailable`.
   */
  const unavailable = enrichment.data?.status === 'unavailable' && !summary;
  const pending = !unavailable && (summary?.translationState === 'pending' || !summary);

  const segment = segmentState(article, summary);
  // Default to the Turkish rendering when there is one, as the prototype did.
  const [chosen, setChosen] = useState<Segment>('tr');
  const active: Segment = segment.enabled ? chosen : segment.visible ? 'en' : 'tr';

  if (query.isPending) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <LoadingState />
      </SafeAreaView>
    );
  }

  if (query.isError || !article) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Geri"
            style={styles.iconButton}
          >
            <BackIcon color={palette.text} />
          </Pressable>
        </View>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </SafeAreaView>
    );
  }

  const saved = isSaved(article.id);
  const body = bodyFor(article, summary, active);

  const toggleSave = () => {
    const next = !saved;
    setArticleSaved(article.id, next);
    showToast(next ? TOASTS.saved : TOASTS.unsaved);
  };

  const openSource = () => {
    // The prototype could only toast; the real button opens the publisher.
    Linking.openURL(article.url).catch((error: unknown) => {
      console.warn(`[article] could not open "${article.url}":`, error);
    });
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Geri"
          style={styles.iconButton}
        >
          <BackIcon color={palette.text} />
        </Pressable>
        <View style={styles.headerMid}>
          <Text style={styles.headerSrc}>{article.sourceName}</Text>
          <Text style={styles.headerTime}>{relativeTimeTr(article.publishedAt)}</Text>
        </View>
        <Pressable
          onPress={toggleSave}
          accessibilityRole="button"
          accessibilityLabel={saved ? 'Kaydı kaldır' : 'Kaydet'}
          accessibilityState={{ selected: saved }}
          style={[
            styles.iconButton,
            styles.bookmarkButton,
            saved && { backgroundColor: palette.accentSoft },
          ]}
        >
          <BookmarkIcon
            color={palette.accentText}
            fill={saved ? palette.accentText : 'none'}
          />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.tagRow}>
          <View style={styles.catPill}>
            <Text style={styles.catText}>{article.category}</Text>
          </View>
          {article.language !== 'tr' ? (
            <View style={styles.trPill}>
              <Text style={styles.trText}>EN→TR</Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.title}>{article.title}</Text>

        <View style={styles.summaryCard}>
          <View style={styles.summaryHead}>
            <SparkleIcon color={palette.accentText} />
            <Text style={styles.summaryLabel}>AI TR ÖZET</Text>
            {pending || unavailable ? null : (
              <View style={styles.countPill}>
                <Text style={styles.countText}>{summary?.bullets.length ?? 3} madde</Text>
              </View>
            )}
          </View>

          {unavailable ? (
            // No spinner and no "hazırlanıyor": this will not change by waiting,
            // so the card says so once and points at the footer's "Kaynağa git".
            <Text style={styles.pendingText}>
              Bu haber için özet üretilemiyor; kaynağa git.
            </Text>
          ) : pending ? (
            // addendum §E: with no Anthropic key the job stays queued. This is a
            // first-class state, and the article body below stays readable.
            <View style={styles.pendingRow}>
              <ActivityIndicator size="small" color={palette.accentText} />
              <Text style={styles.pendingText}>Özet hazırlanıyor</Text>
            </View>
          ) : (
            summary?.bullets.map((bullet, index) => (
              <View key={`${index}-${bullet}`} style={styles.bulletRow}>
                <View style={styles.bullet} />
                <Text style={styles.bulletText}>{bullet}</Text>
              </View>
            ))
          )}

          {pending || unavailable ? null : (
            <Text style={styles.credit}>Claude ile çevrildi ve özetlendi</Text>
          )}
        </View>

        {segment.visible ? (
          <View style={[styles.segment, !segment.enabled && styles.segmentDisabled]}>
            <Pressable
              onPress={() => setChosen('en')}
              disabled={!segment.enabled}
              accessibilityRole="button"
              accessibilityState={{ selected: active === 'en', disabled: !segment.enabled }}
              style={[styles.segItem, active === 'en' && styles.segItemActive]}
            >
              <Text style={[styles.segText, active === 'en' ? styles.segOn : styles.segOff]}>
                Orijinal
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setChosen('tr')}
              disabled={!segment.enabled}
              accessibilityRole="button"
              accessibilityState={{ selected: active === 'tr', disabled: !segment.enabled }}
              style={[styles.segItem, active === 'tr' && styles.segItemActive]}
            >
              <Text style={[styles.segText, active === 'tr' ? styles.segOn : styles.segOff]}>
                Çeviri
              </Text>
            </Pressable>
          </View>
        ) : null}

        <Text style={styles.bodyLabel}>{body.label}</Text>
        <Text style={styles.bodyText}>{body.text}</Text>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={openSource}
          accessibilityRole="link"
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: pressed ? palette.accentPressed : palette.accent },
          ]}
        >
          <Text style={styles.ctaText}>Kaynağa git </Text>
          <ExternalLinkIcon color={palette.onAccent} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (palette: Palette) => ({
  screen: { flex: 1, backgroundColor: palette.appBg },
  header: {
    paddingHorizontal: 16,
    paddingTop: 10,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: palette.borderControl,
    borderRadius: radius.control,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  bookmarkButton: { borderColor: palette.borderBookmark },
  headerMid: { flex: 1, minWidth: 0, alignItems: 'center' as const },
  headerSrc: { fontSize: 14, fontFamily: fonts.sb, color: palette.text },
  headerTime: { fontSize: 11, fontFamily: fonts.r, color: palette.text5 },
  body: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 110, gap: 12 },
  tagRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
  catPill: {
    borderWidth: 1,
    borderColor: palette.borderChip,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  catText: { fontSize: 11, fontFamily: fonts.sb, color: palette.accentText },
  trPill: {
    backgroundColor: palette.accentSoft,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  trText: { fontSize: 11, fontFamily: fonts.b, color: palette.accentText },
  title: { fontSize: 20, fontFamily: fonts.xb, color: palette.text, lineHeight: 26.4 },
  summaryCard: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.borderDetailCard,
    borderRadius: radius.card,
    padding: 16,
    gap: 11,
  },
  summaryHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
  summaryLabel: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.3,
    color: palette.accentText,
  },
  countPill: {
    backgroundColor: palette.paleChip,
    borderRadius: radius.pill,
    paddingVertical: 3,
    paddingHorizontal: 8,
    marginLeft: 'auto' as const,
  },
  countText: { fontSize: 10, fontFamily: fonts.b, color: palette.appBg },
  pendingRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 },
  pendingText: { fontSize: 14, fontFamily: fonts.sb, color: palette.text6 },
  bulletRow: { flexDirection: 'row' as const, gap: 10, alignItems: 'flex-start' as const },
  bullet: { width: 6, height: 6, backgroundColor: palette.accentText, marginTop: 7 },
  bulletText: {
    flex: 1,
    fontSize: 14,
    fontFamily: fonts.r,
    lineHeight: 21.7,
    color: palette.textStrong,
  },
  credit: {
    fontSize: 11,
    fontFamily: fonts.r,
    color: palette.text45,
    borderTopWidth: 1,
    borderTopColor: palette.borderRow,
    paddingTop: 10,
  },
  segment: {
    flexDirection: 'row' as const,
    alignSelf: 'flex-start' as const,
    backgroundColor: palette.inputBg,
    borderWidth: 1,
    borderColor: palette.borderSeg,
    borderRadius: radius.seg,
    padding: 3,
  },
  segmentDisabled: { opacity: 0.5 },
  segItem: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 9 },
  segItemActive: { backgroundColor: palette.accent },
  segText: { fontSize: 13, fontFamily: fonts.sb },
  segOn: { color: palette.onAccent },
  segOff: { color: palette.text6 },
  bodyLabel: { fontSize: 11, fontFamily: fonts.sb, color: palette.text45 },
  bodyText: { fontSize: 14, fontFamily: fonts.r, lineHeight: 23.1, color: palette.textBody },
  footer: {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 34,
    backgroundColor: palette.appBg,
  },
  cta: {
    height: 50,
    borderRadius: radius.seg,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
  },
  ctaText: { fontSize: 15, fontFamily: fonts.b, color: palette.onAccent },
});
