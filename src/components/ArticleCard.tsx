import React from 'react';
import { Pressable, Text, View } from 'react-native';

import type { Article } from '../data/articles';
import type { Palette } from '../theme/palettes';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { fonts, radius } from '../theme/typography';

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
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, pressed && { borderColor: palette.borderChip }]}
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

const createStyles = (palette: Palette) => ({
  card: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.border,
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
  row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radius.tile,
    backgroundColor: palette.tile,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  tileText: { fontSize: 12, fontFamily: fonts.xb, color: palette.lightAccent },
  mid: { flex: 1, minWidth: 0 },
  src: { fontSize: 13, fontFamily: fonts.sb, color: palette.text },
  meta: { fontSize: 12, fontFamily: fonts.r, color: palette.text55 },
  catPill: {
    borderWidth: 1,
    borderColor: palette.borderChip,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  catText: { fontSize: 11, fontFamily: fonts.sb, color: palette.accentText },
  title: { fontSize: 16, fontFamily: fonts.sb, color: palette.text, lineHeight: 22 },
});
