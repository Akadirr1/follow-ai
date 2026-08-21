import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppIcon } from '../../src/components/AppIcon';
import { ArticleCard } from '../../src/components/ArticleCard';
import { EmptyState } from '../../src/components/EmptyState';
import { SearchIcon } from '../../src/components/Icons';
import { ErrorState, LoadingState, OfflineBanner } from '../../src/components/StateViews';
import { useFeed } from '../../src/data-access/hooks';
import type { Article } from '../../src/domain/types';
import { openArticle } from '../../src/navigation/openArticle';
import type { Palette } from '../../src/theme/palettes';
import { useTheme, useThemedStyles } from '../../src/theme/ThemeProvider';
import { fonts, radius, TAB_BAR_SPACE } from '../../src/theme/typography';
import { useEnabledSources, useReadArticles } from '../../src/user-state/hooks';

/** Chips: "Tümü" plus the five prototype categories. */
const CATEGORIES = ['Tümü', 'Modeller', 'Araştırma', 'Ürün', 'Açık Kaynak', 'Türkiye'] as const;
type Filter = (typeof CATEGORIES)[number];

/** The day line, in the prototype's format ("Perşembe, 20 Ağustos"). */
const DAYS_TR = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const MONTHS_TR = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];
export const todayLineTr = (now: Date = new Date()): string =>
  `${DAYS_TR[now.getDay()]}, ${now.getDate()} ${MONTHS_TR[now.getMonth()]}`;

/** "N yeni" counts what this device has not opened yet. */
export const unseenCount = (articles: Article[], isRead: (id: string) => boolean): number =>
  articles.filter((a) => !isRead(a.id)).length;

export default function FeedScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [filter, setFilter] = useState<Filter>('Tümü');

  const { enabledSourceIds } = useEnabledSources();
  const { isRead, markRead } = useReadArticles();

  const feed = useFeed({
    category: filter === 'Tümü' ? null : filter,
    // Undefined (not []) means "every active source" — an empty array would ask
    // for a feed with no sources at all.
    ...(enabledSourceIds && enabledSourceIds.length > 0 ? { sourceIds: enabledSourceIds } : {}),
  });

  const articles = useMemo(
    () => feed.data?.pages.flatMap((page) => page.items) ?? [],
    [feed.data],
  );

  const open = (id: string) => {
    openArticle(router, id, { onOpen: () => markRead(id) });
  };

  // Cached rows on screen while the refetch is failing: show them, and say so.
  const isStale = feed.isError && articles.length > 0;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <AppIcon size={34} radius={9} />
        <View style={styles.headerText}>
          <Text style={styles.appName}>AI Gündem</Text>
          <Text style={styles.dateLine}>
            {todayLineTr()} ·{' '}
            <Text style={styles.newCount}>{unseenCount(articles, isRead)} yeni</Text>
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/search')}
          accessibilityRole="button"
          accessibilityLabel="Ara"
          style={styles.iconButton}
        >
          <SearchIcon color={palette.text} />
        </Pressable>
      </View>

      <View style={styles.chipsRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {CATEGORIES.map((c) => {
            const active = filter === c;
            return (
              <Pressable
                key={c}
                onPress={() => setFilter(c)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.chip, active ? styles.chipOn : styles.chipOff]}
              >
                <Text style={[styles.chipText, active ? styles.chipTextOn : styles.chipTextOff]}>
                  {c}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {isStale ? <OfflineBanner updatedAt={feed.dataUpdatedAt || null} /> : null}

      {feed.isPending ? (
        <LoadingState />
      ) : feed.isError && articles.length === 0 ? (
        <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
      ) : (
        <FlatList
          data={articles}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <ArticleCard article={item} onPress={() => open(item.id)} showTranslationTag />
          )}
          refreshControl={
            <RefreshControl
              refreshing={feed.isRefetching && !feed.isFetchingNextPage}
              onRefresh={() => void feed.refetch()}
              tintColor={palette.accentText}
            />
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
          }}
          ListEmptyComponent={
            <EmptyState
              iconSize={90}
              iconRadius={21}
              title="Bu filtrede haber yok"
              line="Kategoriyi değiştir veya kaynaklarını kontrol et."
            />
          }
          ListFooterComponent={
            feed.hasNextPage ? (
              <Pressable
                onPress={() => void feed.fetchNextPage()}
                accessibilityRole="button"
                disabled={feed.isFetchingNextPage}
                style={styles.more}
              >
                <Text style={styles.moreText}>
                  {feed.isFetchingNextPage ? 'Yükleniyor…' : 'Daha fazla'}
                </Text>
              </Pressable>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

const createStyles = (palette: Palette) => ({
  screen: { flex: 1, backgroundColor: palette.appBg },
  header: {
    paddingHorizontal: 20,
    paddingTop: 14,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
  },
  headerText: { flex: 1 },
  appName: { fontSize: 20, fontFamily: fonts.xb, color: palette.text },
  dateLine: { fontSize: 12, fontFamily: fonts.r, color: palette.text55 },
  newCount: { color: palette.accentText, fontFamily: fonts.sb },
  iconButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: palette.borderControl,
    borderRadius: radius.control,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  chipsRow: { paddingTop: 14, paddingBottom: 12 },
  chips: { gap: 8, paddingLeft: 20, paddingRight: 12 },
  chip: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  chipOn: { backgroundColor: palette.accent, borderColor: palette.accent },
  chipOff: { backgroundColor: 'transparent', borderColor: palette.borderChip },
  chipText: { fontSize: 13, fontFamily: fonts.sb },
  chipTextOn: { color: palette.onAccent },
  chipTextOff: { color: palette.text75 },
  list: {
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: TAB_BAR_SPACE,
    gap: 12,
    flexGrow: 1,
  },
  more: {
    height: 46,
    borderWidth: 1,
    borderColor: palette.borderChip,
    borderRadius: radius.seg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginTop: 4,
  },
  moreText: { fontSize: 14, fontFamily: fonts.sb, color: palette.accentText },
});
