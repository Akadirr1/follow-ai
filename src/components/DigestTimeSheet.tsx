import React, { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import type { Palette } from '../theme/palettes';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { fonts, mono, radius } from '../theme/typography';

/** The five slots the prototype offers. */
export const DIGEST_TIMES = ['07:00', '07:30', '08:00', '08:30', '09:00'] as const;
export type DigestTime = (typeof DIGEST_TIMES)[number];

export const isDigestTime = (value: string): value is DigestTime =>
  (DIGEST_TIMES as readonly string[]).includes(value);

/**
 * Bottom sheet for the digest hour.
 *
 * The draft lives here now rather than in a global store (arch-001 §4: "the
 * sheet owns open + draft, the settings mutation commits a validated slot"), so
 * Vazgeç simply unmounts the draft and Kaydet hands one value up.
 */
export function DigestTimeSheet({
  visible,
  value,
  onClose,
  onSave,
}: {
  visible: boolean;
  value: string;
  onClose: () => void;
  onSave: (time: DigestTime) => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [draft, setDraft] = useState<DigestTime>(isDigestTime(value) ? value : '08:00');

  // Reopening reseeds the draft from the committed value; a stale draft would
  // silently offer to save a slot the user already cancelled.
  useEffect(() => {
    if (visible) setDraft(isDigestTime(value) ? value : '08:00');
  }, [visible, value]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Kapat" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.title}>Digest saati</Text>
        <Text style={styles.sub}>Günlük özet her gün bu saatte hazırlanır.</Text>

        <View style={styles.times}>
          {DIGEST_TIMES.map((time) => {
            const picked = draft === time;
            return (
              <Pressable
                key={time}
                onPress={() => setDraft(time)}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked }}
                style={[styles.time, picked && styles.timePicked]}
              >
                <Text style={[styles.timeText, picked ? styles.timeOn : styles.timeOff]}>
                  {time}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.actions}>
          <Pressable onPress={onClose} accessibilityRole="button" style={styles.cancel}>
            <Text style={styles.cancelText}>Vazgeç</Text>
          </Pressable>
          <Pressable
            onPress={() => onSave(draft)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.save,
              { backgroundColor: pressed ? palette.accentPressed : palette.accent },
            ]}
          >
            <Text style={styles.saveText}>Kaydet</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (palette: Palette) => ({
  scrim: { flex: 1, backgroundColor: palette.scrim },
  sheet: {
    backgroundColor: palette.card,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderTopWidth: 1,
    borderTopColor: palette.borderSheet,
    paddingTop: 10,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  grabber: {
    width: 40,
    height: 4,
    backgroundColor: palette.text25,
    borderRadius: 2,
    alignSelf: 'center' as const,
    marginBottom: 14,
  },
  title: { fontSize: 17, fontFamily: fonts.b, color: palette.text, marginBottom: 4 },
  sub: { fontSize: 13, fontFamily: fonts.r, color: palette.text55, marginBottom: 12 },
  times: { gap: 4 },
  time: {
    height: 46,
    borderRadius: radius.seg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  timePicked: { backgroundColor: palette.accentSheetPick },
  timeText: { fontFamily: mono },
  timeOn: { color: palette.text, fontSize: 22, fontWeight: '800' as const },
  timeOff: { color: palette.text45, fontSize: 17, fontWeight: '600' as const },
  actions: { flexDirection: 'row' as const, gap: 10, marginTop: 16 },
  cancel: {
    flex: 1,
    height: 50,
    borderWidth: 1,
    borderColor: palette.borderChip,
    borderRadius: radius.seg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  cancelText: { fontSize: 15, fontFamily: fonts.sb, color: palette.text75 },
  save: {
    flex: 1,
    height: 50,
    borderRadius: radius.seg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  saveText: { fontSize: 15, fontFamily: fonts.b, color: palette.onAccent },
});
