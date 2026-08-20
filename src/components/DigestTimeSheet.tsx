import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useDispatch, useStore } from '../store/StoreProvider';
import { DIGEST_TIMES } from '../store/types';
import { colors, fonts, mono, radius } from '../theme/tokens';

/**
 * Bottom sheet for the digest hour. The pick is staged in `tmpTime`: Vazgeç closes
 * without committing, Kaydet commits and toasts.
 */
export function DigestTimeSheet() {
  const { sheet, tmpTime } = useStore();
  const dispatch = useDispatch();

  return (
    <Modal
      visible={sheet}
      transparent
      animationType="slide"
      onRequestClose={() => dispatch({ type: 'closeSheet' })}
    >
      <Pressable
        style={styles.scrim}
        onPress={() => dispatch({ type: 'closeSheet' })}
        accessibilityLabel="Kapat"
      />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.title}>Digest saati</Text>
        <Text style={styles.sub}>Günlük özet her gün bu saatte hazırlanır.</Text>

        <View style={styles.times}>
          {DIGEST_TIMES.map((t) => {
            const picked = tmpTime === t;
            return (
              <Pressable
                key={t}
                onPress={() => dispatch({ type: 'pickTime', time: t })}
                accessibilityRole="button"
                accessibilityState={{ selected: picked }}
                style={[
                  styles.time,
                  { backgroundColor: picked ? colors.accentSheetPick : 'transparent' },
                ]}
              >
                <Text
                  style={[
                    styles.timeText,
                    {
                      color: picked ? colors.text : colors.text45,
                      fontSize: picked ? 22 : 17,
                      fontWeight: picked ? '800' : '600',
                    },
                  ]}
                >
                  {t}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => dispatch({ type: 'closeSheet' })}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.cancel,
              pressed && { backgroundColor: 'rgba(37,99,235,.12)' },
            ]}
          >
            <Text style={styles.cancelText}>Vazgeç</Text>
          </Pressable>
          <Pressable
            onPress={() => dispatch({ type: 'saveTime' })}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.save,
              { backgroundColor: pressed ? colors.accentPressed : colors.accent },
            ]}
          >
            <Text style={styles.saveText}>Kaydet</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderTopWidth: 1,
    borderTopColor: colors.borderSheet,
    paddingTop: 10,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  grabber: {
    width: 40,
    height: 4,
    backgroundColor: colors.text25,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 14,
  },
  title: { fontSize: 17, fontFamily: fonts.b, color: colors.text, marginBottom: 4 },
  sub: { fontSize: 13, fontFamily: fonts.r, color: colors.text55, marginBottom: 12 },
  times: { gap: 4 },
  time: {
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeText: { fontFamily: mono },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancel: {
    flex: 1,
    height: 50,
    borderWidth: 1,
    borderColor: colors.borderChip,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { fontSize: 15, fontFamily: fonts.sb, color: colors.text75 },
  save: {
    flex: 1,
    height: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveText: { fontSize: 15, fontFamily: fonts.b, color: colors.white },
});
