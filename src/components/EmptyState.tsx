import React from 'react';
import { Text, View } from 'react-native';

import type { Palette } from '../theme/palettes';
import { useThemedStyles } from '../theme/ThemeProvider';
import { fonts } from '../theme/typography';
import { AppIcon } from './AppIcon';

/** The three empty states in the prototype share this shape. */
export function EmptyState({
  iconSize,
  iconRadius,
  title,
  line,
  titleSize = 16,
  lineHeight = 20,
  paddingVertical = 60,
  children,
}: {
  iconSize: number;
  iconRadius: number;
  title: string;
  line: string;
  titleSize?: number;
  lineHeight?: number;
  paddingVertical?: number;
  children?: React.ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.wrap, { paddingVertical }]}>
      <AppIcon size={iconSize} radius={iconRadius} />
      <Text style={[styles.title, { fontSize: titleSize }]}>{title}</Text>
      <Text style={[styles.line, { lineHeight }]}>{line}</Text>
      {children}
    </View>
  );
}

const createStyles = (palette: Palette) => ({
  wrap: {
    alignItems: 'center' as const,
    gap: 10,
    paddingHorizontal: 30,
  },
  title: { fontFamily: fonts.b, color: palette.text, textAlign: 'center' as const },
  line: {
    fontSize: 13,
    fontFamily: fonts.r,
    color: palette.text6,
    textAlign: 'center' as const,
  },
});
