import React from 'react';
import { Pressable, View } from 'react-native';

import type { Palette } from '../theme/palettes';
import { useThemedStyles } from '../theme/ThemeProvider';
import { radius } from '../theme/typography';

/**
 * The prototype's 46×28 pill switch. `onToggle` omitted = decorative (the
 * "Digest bildirimi" row is fixed-on in the prototype).
 */
export function Toggle({
  on,
  onToggle,
  accessibilityLabel,
}: {
  on: boolean;
  onToggle?: () => void;
  accessibilityLabel?: string;
}) {
  const styles = useThemedStyles(createStyles);

  const body = (
    <View style={[styles.track, on ? styles.trackOn : styles.trackOff]}>
      <View style={styles.knob} />
    </View>
  );

  if (!onToggle) return body;

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={accessibilityLabel}
    >
      {body}
    </Pressable>
  );
}

const createStyles = (palette: Palette) => ({
  track: {
    width: 46,
    height: 28,
    borderRadius: radius.pill,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    padding: 3,
  },
  trackOn: { backgroundColor: palette.accent, justifyContent: 'flex-end' as const },
  trackOff: { backgroundColor: palette.switchOff, justifyContent: 'flex-start' as const },
  knob: {
    width: 22,
    height: 22,
    backgroundColor: palette.white,
    borderRadius: 11,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
});
