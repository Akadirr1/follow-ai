import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Article } from '../data/articles';
import { colors, fonts, radius } from '../theme/tokens';

/**
 * Feed and search share one card. The only difference in the prototype is the
 * second line: the feed appends " · EN→TR", search shows the time alone.
 */
export function ArticleCard({
  article,
  onPress,
  showTranslationTag,
}: {
  article: Article;
  onPress: () => void;
  showTranslationTag: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.card,
        pressed && { borderColor: 'rgba(96,165,250,.55)' },
      ]}
    >
      <View style={styles.row}>
        <View style={styles.tile}>
          <Text style={styles.tileText}>{article.tile}</Text>
        </View>
        <View style={styles.mid}>
          <Text style={styles.src}>{article.src}</Text>
          <Text style={styles.meta}>
            {showTranslationTag ? `${article.time} · EN→TR` : article.time}
          </Text>
        </View>
        <View style={styles.catPill}>
          <Text style={styles.catText}>{article.cat}</Text>
        </View>
      </View>
      <Text style={styles.title}>{article.title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radius.tile,
    backgroundColor: colors.tile,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileText: { fontSize: 12, fontFamily: fonts.xb, color: colors.lightAccent },
  mid: { flex: 1, minWidth: 0 },
  src: { fontSize: 13, fontFamily: fonts.sb, color: colors.text },
  meta: { fontSize: 12, fontFamily: fonts.r, color: colors.text55 },
  catPill: {
    borderWidth: 1,
    borderColor: colors.borderChip,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  catText: { fontSize: 11, fontFamily: fonts.sb, color: colors.accentText },
  title: { fontSize: 16, fontFamily: fonts.sb, color: colors.text, lineHeight: 22 },
});
