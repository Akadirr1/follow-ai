import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radius } from '../theme/tokens';

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
  const body = (
    <View
      style={[
        styles.track,
        {
          backgroundColor: on ? colors.accent : colors.switchOff,
          justifyContent: on ? 'flex-end' : 'flex-start',
        },
      ]}
    >
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

const styles = StyleSheet.create({
  track: {
    width: 46,
    height: 28,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 3,
  },
  knob: {
    width: 22,
    height: 22,
    backgroundColor: colors.white,
    borderRadius: 11,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
});
