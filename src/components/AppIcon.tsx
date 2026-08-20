import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../theme/tokens';

/**
 * Placeholder for the prototype's app icon (`uploads/ikon1.png` / `ikon3.png`).
 * Both uploads came back truncated on import (AGENTS.md, "Known failure pattern"),
 * so every place the prototype drew the icon draws this rounded "AG" tile instead.
 * Swap this one component when the real asset exists.
 */
export function AppIcon({ size, radius }: { size: number; radius?: number }) {
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

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.tile,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: colors.lightAccent,
    fontFamily: fonts.xb,
  },
});
