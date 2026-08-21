import React from 'react';
import { Text, View } from 'react-native';

import type { Palette } from '../theme/palettes';
import { useThemedStyles } from '../theme/ThemeProvider';
import { fonts } from '../theme/typography';

/**
 * Placeholder for the prototype's app icon (`uploads/ikon1.png` / `ikon3.png`).
 * Both uploads came back truncated on import (AGENTS.md, "Known failure pattern"),
 * so every place the prototype drew the icon draws this rounded "AG" tile instead.
 * Swap this one component when the real asset exists.
 */
export function AppIcon({ size, radius }: { size: number; radius?: number }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View
      style={[
        styles.box,
        { width: size, height: size, borderRadius: radius ?? Math.round(size * 0.26) },
      ]}
    >
      <Text style={[styles.label, { fontSize: Math.max(10, Math.round(size * 0.34)) }]}>
        AG
      </Text>
    </View>
  );
}

const createStyles = (palette: Palette) => ({
  box: {
    backgroundColor: palette.tile,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  label: {
    color: palette.lightAccent,
    fontFamily: fonts.xb,
  },
});
