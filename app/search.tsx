import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ArticleCard } from '../src/components/ArticleCard';
import { EmptyState } from '../src/components/EmptyState';
import { BackIcon, ClockIcon, CloseIcon, SearchIcon } from '../src/components/Icons';
import { selectResults } from '../src/store/selectors';
import { useDispatch, useStore } from '../src/store/StoreProvider';
import { RECENT_QUERIES } from '../src/store/types';
import { colors, fonts, mono, radius } from '../src/theme/tokens';

export default function SearchScreen() {
  const state = useStore();
  const dispatch = useDispatch();
  const router = useRouter();

  const results = selectResults(state);
  const hasQuery = state.q.trim().length > 0;

  const open = (id: string) => {
    // The prototype's search result does NOT mark the article read — only the feed
    // and saved list do. Kept deliberately identical.
    dispatch({ type: 'openArticle', id, markRead: false });
    router.push(`/article/${id}`);
  };

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
        <View style={styles.field}>
          <SearchIcon size={17} color={colors.accentText} />
          <TextInput
            value={state.q}
            onChangeText={(q) => dispatch({ type: 'setQuery', q })}
            placeholder="AI gündeminde ara…"
            placeholderTextColor={colors.text45}
            style={styles.input}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="AI gündeminde ara"
          />
          {hasQuery ? (
            <Pressable
              onPress={() => dispatch({ type: 'clearQuery' })}
              accessibilityRole="button"
              accessibilityLabel="Aramayı temizle"
            >
              <CloseIcon />
            </Pressable>
          ) : null}
        </View>
      </View>

      {hasQuery ? (
        <ScrollView contentContainerStyle={styles.results} showsVerticalScrollIndicator={false}>
          {results.map((a) => (
            <ArticleCard
              key={a.id}
              article={a}
              onPress={() => open(a.id)}
              showTranslationTag={false}
            />
          ))}
          {results.length === 0 ? (
            <EmptyState
              iconSize={84}
              iconRadius={19}
              title="Sonuç bulunamadı"
              line="Farklı bir anahtar kelime dene."
              titleSize={15}
            />
          ) : null}
        </ScrollView>
      ) : (
        <View style={styles.recent}>
          <Text style={styles.recentLabel}>SON ARAMALAR</Text>
          {RECENT_QUERIES.map((q) => (
            <Pressable
              key={q}
              onPress={() => dispatch({ type: 'setQuery', q })}
              accessibilityRole="button"
              style={styles.recentRow}
            >
              <ClockIcon />
              <Text style={styles.recentText}>{q}</Text>
            </Pressable>
          ))}
          <View style={styles.hint}>
            <SearchIcon size={38} color="rgba(96,165,250,.5)" strokeWidth={1.6} />
            <Text style={styles.hintText}>
              Aramak için yaz — başlık, kaynak veya kategori.
            </Text>
          </View>
        </View>
      )}
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
  field: {
    flex: 1,
    height: 44,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 14,
    fontFamily: fonts.r,
    padding: 0,
  },
  results: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 40, gap: 12 },
  recent: { flex: 1, paddingHorizontal: 20, paddingTop: 24 },
  recentLabel: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.text45,
    marginBottom: 6,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 48,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderRow,
  },
  recentText: { flex: 1, fontSize: 14, fontFamily: fonts.r, color: colors.text },
  hint: { alignItems: 'center', gap: 10, marginTop: 80 },
  hintText: { fontSize: 14, fontFamily: fonts.r, color: colors.text55, textAlign: 'center' },
});
