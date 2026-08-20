import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../theme/tokens';
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
  return (
    <View style={[styles.wrap, { paddingVertical }]}>
      <AppIcon size={iconSize} radius={iconRadius} />
      <Text style={[styles.title, { fontSize: titleSize }]}>{title}</Text>
      <Text style={[styles.line, { lineHeight }]}>{line}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 30,
  },
  title: { fontFamily: fonts.b, color: colors.text, textAlign: 'center' },
  line: {
    fontSize: 13,
    fontFamily: fonts.r,
    color: colors.text6,
    textAlign: 'center',
  },
});
