import React from 'react';
import { Text, View } from 'react-native';

import { useStore } from '../store/StoreProvider';
import type { Palette } from '../theme/palettes';
import { useThemedStyles } from '../theme/ThemeProvider';
import { fonts, radius } from '../theme/typography';

/**
 * The prototype's single floating toast, rendered once above every screen.
 * Its lifetime is owned by `StoreProvider`; this only draws whatever is current.
 * The surface is inverted in both themes (`toastBg`/`toastText`), so it stays
 * readable over a white card as well as a dark one.
 */
export function Toast() {
  const { toast } = useStore();
  const styles = useThemedStyles(createStyles);
  if (!toast) return null;
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View style={styles.pill}>
        <Text style={styles.text} numberOfLines={1}>
          {toast}
        </Text>
      </View>
    </View>
  );
}

const createStyles = (palette: Palette) => ({
  wrap: {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    bottom: 110,
    alignItems: 'center' as const,
    zIndex: 70,
  },
  pill: {
    backgroundColor: palette.toastBg,
    borderWidth: 1,
    borderColor: palette.borderToast,
    borderRadius: radius.pill,
    paddingVertical: 9,
    paddingHorizontal: 18,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  text: {
    fontSize: 13,
    fontFamily: fonts.sb,
    color: palette.toastText,
  },
});
