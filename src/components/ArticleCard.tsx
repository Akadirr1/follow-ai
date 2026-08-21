import React from 'react';
import { Pressable, Text, View } from 'react-native';

import type { Article } from '../domain/types';
import { relativeTimeTr } from '../format/relativeTime';
import type { Palette } from '../theme/palettes';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { fonts, radius } from '../theme/typography';

/**
 * Feed and search share one card. It now takes the domain `Article` (P1 DTO)
 * rather than the prototype fixture, so `publishedAt` is an ISO instant and the
 * "2 saat önce" label is produced here by the formatter.
 *
 * The only difference between the two screens is the second line: the feed
 * appends " · EN→TR" for a translated source, search shows the time alone.
 */
export function ArticleCard({
  article,
  onPress,
  showTranslationTag,
  dimmed = false,
  trailing,
}: {
  article: Article;
  onPress: () => void;
  showTranslationTag: boolean;
  /** Saved list dims articles already read (prototype opacity .62). */
  dimmed?: boolean;
  /** Saved list puts its delete control here. */
  trailing?: React.ReactNode;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  // A Turkish source is not translated, so the EN→TR tag would be a lie there.
  const translated = showTranslationTag && article.language !== 'tr';
  const time = relativeTimeTr(article.publishedAt);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={article.title}
      style={({ pressed }) => [
        styles.card,
        dimmed && styles.dimmed,
        pressed && { borderColor: palette.borderChip },
      ]}
    >
      <View style={styles.row}>
        <View style={styles.tile}>
          <Text style={styles.tileText}>{article.tile}</Text>
        </View>
        <View style={styles.mid}>
          <Text style={styles.src}>{article.sourceName}</Text>
          <Text style={styles.meta}>{translated ? `${time} · EN→TR` : time}</Text>
        </View>
        {trailing ?? (
          <View style={styles.catPill}>
            <Text style={styles.catText}>{article.category}</Text>
          </View>
        )}
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
  dimmed: { opacity: 0.62 },
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
