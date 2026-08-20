import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppIcon } from '../../src/components/AppIcon';
import { ArticleCard } from '../../src/components/ArticleCard';
import { EmptyState } from '../../src/components/EmptyState';
import { SearchIcon } from '../../src/components/Icons';
import { CATEGORIES } from '../../src/data/articles';
import { selectFeed } from '../../src/store/selectors';
import { useDispatch, useStore } from '../../src/store/StoreProvider';
import { colors, fonts, radius } from '../../src/theme/tokens';

export default function FeedScreen() {
  const state = useStore();
  const dispatch = useDispatch();
  const router = useRouter();
  const items = selectFeed(state);

  const open = (id: string) => {
    // Opening from the feed marks the article read (prototype `feedItems[].open`).
    dispatch({ type: 'openArticle', id, markRead: true });
    router.push(`/article/${id}`);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <AppIcon size={34} radius={9} />
        <View style={styles.headerText}>
          <Text style={styles.appName}>AI Gündem</Text>
          <Text style={styles.dateLine}>
            Perşembe, 20 Ağustos · <Text style={styles.newCount}>12 yeni</Text>
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/search')}
          accessibilityRole="button"
          accessibilityLabel="Ara"
          style={styles.iconButton}
        >
          <SearchIcon />
        </Pressable>
      </View>

      <View style={styles.chipsRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {CATEGORIES.map((c) => {
            const active = state.filter === c;
            return (
              <Pressable
                key={c}
                onPress={() => dispatch({ type: 'setFilter', filter: c })}
                accessibilityRole="button"
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? colors.accent : 'transparent',
                    borderColor: active ? colors.accent : colors.borderChip,
                  },
                ]}
              >
                <Text style={[styles.chipText, { color: active ? colors.white : colors.text75 }]}>
                  {c}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {items.map((a) => (
          <ArticleCard key={a.id} article={a} onPress={() => open(a.id)} showTranslationTag />
        ))}
        {items.length === 0 ? (
          <EmptyState
            iconSize={90}
            iconRadius={21}
            title="Bu filtrede haber yok"
            line="Kategoriyi değiştir veya kaynaklarını kontrol et."
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.appBg },
  header: {
    paddingHorizontal: 20,
    paddingTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerText: { flex: 1 },
  appName: { fontSize: 20, fontFamily: fonts.xb, color: colors.text },
  dateLine: { fontSize: 12, fontFamily: fonts.r, color: colors.text55 },
  newCount: { color: colors.accentText, fontFamily: fonts.sb },
  iconButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: colors.borderControl,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipsRow: { paddingTop: 14, paddingBottom: 12 },
  chips: { gap: 8, paddingLeft: 20, paddingRight: 12 },
  chip: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 13, fontFamily: fonts.sb },
  list: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 24, gap: 12 },
});
