import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ArticleCard } from '../../src/components/ArticleCard';
import { EmptyState } from '../../src/components/EmptyState';
import { TrashIcon } from '../../src/components/Icons';
import { ErrorState, LoadingState } from '../../src/components/StateViews';
import { TOASTS, useToast } from '../../src/components/ToastProvider';
import { useFeed } from '../../src/data-access/hooks';
import type { Article } from '../../src/domain/types';
import { openArticle } from '../../src/navigation/openArticle';
import type { Palette } from '../../src/theme/palettes';
import { useTheme, useThemedStyles } from '../../src/theme/ThemeProvider';
import { fonts, radius, TAB_BAR_SPACE } from '../../src/theme/typography';
import { useReadArticles, useSavedArticles } from '../../src/user-state/hooks';

/**
 * Saved articles are device-local ids (addendum §A); their content comes from the
 * feed cache. Ordering follows the save order, newest first, which is what the
 * user just did — not the publish order.
 */
export function orderBySaved(articles: Article[], savedIds: string[]): Article[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  return savedIds.map((id) => byId.get(id)).filter((a): a is Article => a !== undefined);
}

export default function SavedScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { showToast } = useToast();
  const { saved, setArticleSaved } = useSavedArticles();
  const { isRead, markRead } = useReadArticles();

  // The saved list needs the article bodies, and the feed query already holds
  // them; asking the repository per id would be N round trips for one screen.
  const feed = useFeed();
  const articles = useMemo(
    () => feed.data?.pages.flatMap((page) => page.items) ?? [],
    [feed.data],
  );

  const savedIds = saved.map((entry) => entry.articleId);
  const items = orderBySaved(articles, savedIds);
  const unread = items.filter((a) => !isRead(a.id)).length;

  const remove = (id: string) => {
    setArticleSaved(id, false);
    showToast(TOASTS.deleted);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Kaydedilenler</Text>
        <Text style={styles.meta}>
          {items.length} kayıt · <Text style={styles.unread}>{unread} okunmadı</Text>
        </Text>
      </View>

      {feed.isPending && savedIds.length > 0 ? (
        <LoadingState />
      ) : feed.isError && articles.length === 0 && savedIds.length > 0 ? (
        <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {items.map((article) => (
            <ArticleCard
              key={article.id}
              article={article}
              onPress={() => openArticle(router, article.id, { onOpen: () => markRead(article.id) })}
              showTranslationTag={false}
              dimmed={isRead(article.id)}
              trailing={
                <Pressable
                  onPress={() => remove(article.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${article.sourceName} kaydını sil`}
                  // Nested Pressable: RN does not bubble to the card, and on web
                  // the card's own press is what a stray bubble would trigger, so
                  // the delete stays a delete (impl-001's suppress-open lesson).
                  style={({ pressed }) => [styles.trash, pressed && styles.trashPressed]}
                >
                  <TrashIcon color={palette.text45} />
                </Pressable>
              }
            />
          ))}

          {items.length === 0 ? (
            <EmptyState
              iconSize={96}
              iconRadius={22}
              title="Kaydedilen haber yok"
              line="Detaydaki bookmark simgesine dokunarak kaydet."
              lineHeight={21}
              paddingVertical={80}
            >
              <Pressable
                onPress={() => router.replace('/')}
                accessibilityRole="button"
                style={({ pressed }) => [styles.backButton, pressed && styles.backPressed]}
              >
                <Text style={styles.backText}>Feed&apos;e dön</Text>
              </Pressable>
            </EmptyState>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const createStyles = (palette: Palette) => ({
  screen: { flex: 1, backgroundColor: palette.appBg },
  header: { paddingHorizontal: 20, paddingTop: 14 },
  title: { fontSize: 21, fontFamily: fonts.xb, color: palette.text },
  meta: { fontSize: 12, fontFamily: fonts.r, color: palette.text55, marginTop: 2 },
  unread: { color: palette.accentText, fontFamily: fonts.sb },
  list: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: TAB_BAR_SPACE,
    gap: 12,
    flexGrow: 1,
  },
  trash: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  trashPressed: { backgroundColor: palette.accentSoft },
  backButton: {
    height: 46,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: palette.borderDashed,
    borderRadius: radius.seg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginTop: 10,
  },
  backPressed: { backgroundColor: palette.accentSoft },
  backText: { fontSize: 14, fontFamily: fonts.sb, color: palette.accentText },
});
