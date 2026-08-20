import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useStore } from '../store/StoreProvider';
import { colors, fonts, radius } from '../theme/tokens';

/**
 * The prototype's single floating toast, rendered once above every screen.
 * Its lifetime is owned by `StoreProvider`; this only draws whatever is current.
 */
export function Toast() {
  const { toast } = useStore();
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

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 110,
    alignItems: 'center',
    zIndex: 70,
  },
  pill: {
    backgroundColor: colors.tile,
    borderWidth: 1,
    borderColor: colors.borderToast,
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
    color: colors.text,
  },
});
