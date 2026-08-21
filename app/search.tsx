import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ArticleCard } from '../src/components/ArticleCard';
import { EmptyState } from '../src/components/EmptyState';
import { BackIcon, ClockIcon, CloseIcon, SearchIcon } from '../src/components/Icons';
import { ErrorState, LoadingState } from '../src/components/StateViews';
import { useSearch } from '../src/data-access/hooks';
import { openArticle } from '../src/navigation/openArticle';
import type { Palette } from '../src/theme/palettes';
import { useTheme, useThemedStyles } from '../src/theme/ThemeProvider';
import { fonts, mono, radius } from '../src/theme/typography';
import { useRecentSearches } from '../src/user-state/hooks';

/** Typing shouldn't fire a query per keystroke. */
export const SEARCH_DEBOUNCE_MS = 250;

export default function SearchScreen() {
  const router = useRouter();
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { recentSearches, pushRecentSearch } = useRecentSearches();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useSearch(debounced);
  const hasQuery = query.trim().length > 0;
  const results = search.data?.items ?? [];

  const open = (id: string) => {
    // Prototype parity: opening from search does not mark the article read.
    const pushed = openArticle(router, id);
    if (pushed && debounced.trim()) pushRecentSearch(debounced.trim());
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
        <View style={styles.field}>
          <SearchIcon size={17} color={palette.accentText} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="AI gündeminde ara…"
            placeholderTextColor={palette.text45}
            style={styles.input}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="AI gündeminde ara"
          />
          {hasQuery ? (
            <Pressable
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Aramayı temizle"
            >
              <CloseIcon color={palette.text5} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {hasQuery ? (
        <ScrollView contentContainerStyle={styles.results} showsVerticalScrollIndicator={false}>
          {search.isFetching && results.length === 0 ? (
            <LoadingState />
          ) : search.isError ? (
            <ErrorState error={search.error} onRetry={() => void search.refetch()} />
          ) : (
            <>
              {results.map((article) => (
                <ArticleCard
                  key={article.id}
                  article={article}
                  onPress={() => open(article.id)}
                  showTranslationTag={false}
                />
              ))}
              {results.length === 0 && !search.isFetching ? (
                <EmptyState
                  iconSize={84}
                  iconRadius={19}
                  title="Sonuç bulunamadı"
                  line="Farklı bir anahtar kelime dene."
                  titleSize={15}
                />
              ) : null}
            </>
          )}
        </ScrollView>
      ) : (
        <View style={styles.recent}>
          <Text style={styles.recentLabel}>SON ARAMALAR</Text>
          {recentSearches.map((q) => (
            <Pressable
              key={q}
              onPress={() => setQuery(q)}
              accessibilityRole="button"
              style={styles.recentRow}
            >
              <ClockIcon color={palette.text45} />
              <Text style={styles.recentText}>{q}</Text>
            </Pressable>
          ))}
          <View style={styles.hint}>
            <SearchIcon size={38} color={palette.accentText} strokeWidth={1.6} />
            <Text style={styles.hintText}>
              Aramak için yaz — başlık, kaynak veya kategori.
            </Text>
          </View>
        </View>
      )}
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
  field: {
    flex: 1,
    height: 44,
    backgroundColor: palette.inputBg,
    borderWidth: 1,
    borderColor: palette.accent,
    borderRadius: radius.seg,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: palette.text,
    fontSize: 14,
    fontFamily: fonts.r,
    padding: 0,
  },
  results: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40, gap: 12 },
  recent: { flex: 1, paddingHorizontal: 20, paddingTop: 24 },
  recentLabel: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.5,
    color: palette.text45,
    marginBottom: 6,
  },
  recentRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    height: 48,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderRow,
  },
  recentText: { flex: 1, fontSize: 14, fontFamily: fonts.r, color: palette.text },
  hint: { alignItems: 'center' as const, gap: 10, marginTop: 80 },
  hintText: {
    fontSize: 14,
    fontFamily: fonts.r,
    color: palette.text55,
    textAlign: 'center' as const,
  },
});
