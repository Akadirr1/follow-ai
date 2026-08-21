import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { useRepositories } from '../data-access/hooks';
import type { DataError } from '../domain/errors';
import type { Palette } from '../theme/palettes';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { fonts, radius } from '../theme/typography';

/** The five prototype categories a custom feed can be filed under. */
export const SOURCE_CATEGORIES = [
  'Modeller',
  'Araştırma',
  'Ürün',
  'Açık Kaynak',
  'Türkiye',
] as const;

/**
 * Server codes that all mean the same thing to a reader: the address is fine,
 * there is simply no feed behind it. They are checked ahead of `error.code`
 * because they all arrive as `unsupported_source`, whose generic copy is also
 * used by the local https/credential rejections (P10 N1).
 */
const NO_FEED_SERVER_CODES = new Set([
  'parse_failed',
  'not_a_feed',
  'no_feed_discovered',
  'empty_feed',
]);

const serverCodeOf = (error: DataError): string | null => {
  const code = error.details?.serverCode;
  return typeof code === 'string' ? code : null;
};

/**
 * Turkish copy for the typed errors `addSourceByUrl` can return. Each one names
 * what the user can do about it — "bir hata oluştu" for a bad URL and for a
 * duplicate would make both look like the app's fault.
 */
export function addSourceErrorTr(error: DataError): string {
  const serverCode = serverCodeOf(error);
  if (serverCode !== null && NO_FEED_SERVER_CODES.has(serverCode)) {
    return 'Bu adreste okunabilir bir RSS/Atom akışı bulunamadı.';
  }

  switch (error.code) {
    case 'invalid_input':
      return 'Geçerli bir adres gir (https:// ile başlamalı).';
    case 'unsupported_source':
      return 'Bu adres bir RSS/Atom akışı değil ya da desteklenmiyor.';
    // Reachable in mock mode only: the server answers an existing feed with a
    // 200 and `created:false`, never an error (see CODE_MAP in supabase/edge.ts).
    case 'duplicate_source':
      return 'Bu kaynak zaten ekli.';
    case 'rate_limited':
      return 'Çok fazla deneme yaptın. Biraz sonra tekrar dene.';
    case 'network':
      return 'Bağlantı kurulamadı. İnternetini kontrol et.';
    case 'not_implemented':
      return 'Kaynak ekleme henüz açık değil.';
    default:
      return 'Kaynak eklenemedi.';
  }
}

/**
 * "Yeni kaynak ekle (RSS / URL)". The category and language are hints the server
 * may override — `add-source` re-derives both — so the sheet asks but does not
 * promise.
 */
export function AddSourceSheet({
  visible,
  onClose,
  onAdded,
}: {
  visible: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const repos = useRepositories();

  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<(typeof SOURCE_CATEGORIES)[number]>('Modeller');
  const [language, setLanguage] = useState<'tr' | 'en'>('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setUrl('');
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await repos.sources.addSourceByUrl(url, { category, language });
    setBusy(false);
    if (!result.ok) {
      setError(addSourceErrorTr(result.error));
      return;
    }
    reset();
    onAdded();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        reset();
        onClose();
      }}
    >
      <Pressable
        style={styles.scrim}
        accessibilityLabel="Kapat"
        onPress={() => {
          reset();
          onClose();
        }}
      />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.title}>Yeni kaynak</Text>
        <Text style={styles.sub}>Herkese açık bir RSS/Atom adresi ekle.</Text>

        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://ornek.com/feed.xml"
          placeholderTextColor={palette.text45}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          accessibilityLabel="Kaynak adresi"
        />

        <Text style={styles.label}>KATEGORİ</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {SOURCE_CATEGORIES.map((c) => {
            const active = category === c;
            return (
              <Pressable
                key={c}
                onPress={() => setCategory(c)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                style={[styles.chip, active ? styles.chipOn : styles.chipOff]}
              >
                <Text style={[styles.chipText, active ? styles.chipTextOn : styles.chipTextOff]}>
                  {c}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={styles.label}>DİL</Text>
        <View style={styles.segment}>
          {(['en', 'tr'] as const).map((lang) => {
            const active = language === lang;
            return (
              <Pressable
                key={lang}
                onPress={() => setLanguage(lang)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                style={[styles.segItem, active && styles.segItemActive]}
              >
                <Text style={[styles.segText, active ? styles.segOn : styles.segOff]}>
                  {lang === 'en' ? 'İngilizce' : 'Türkçe'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            onPress={() => {
              reset();
              onClose();
            }}
            accessibilityRole="button"
            style={styles.cancel}
          >
            <Text style={styles.cancelText}>Vazgeç</Text>
          </Pressable>
          <Pressable
            onPress={() => void submit()}
            disabled={busy || url.trim().length === 0}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || url.trim().length === 0 }}
            style={({ pressed }) => [
              styles.save,
              { backgroundColor: pressed ? palette.accentPressed : palette.accent },
              (busy || url.trim().length === 0) && styles.saveDisabled,
            ]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={palette.onAccent} />
            ) : (
              <Text style={styles.saveText}>Ekle</Text>
            )}
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
    gap: 8,
  },
  grabber: {
    width: 40,
    height: 4,
    backgroundColor: palette.text25,
    borderRadius: 2,
    alignSelf: 'center' as const,
    marginBottom: 14,
  },
  title: { fontSize: 17, fontFamily: fonts.b, color: palette.text },
  sub: { fontSize: 13, fontFamily: fonts.r, color: palette.text55, marginBottom: 6 },
  input: {
    height: 46,
    backgroundColor: palette.inputBg,
    borderWidth: 1,
    borderColor: palette.borderSeg,
    borderRadius: radius.seg,
    paddingHorizontal: 14,
    color: palette.text,
    fontSize: 14,
    fontFamily: fonts.r,
  },
  label: {
    fontSize: 11,
    fontFamily: fonts.sb,
    letterSpacing: 1.2,
    color: palette.text45,
    marginTop: 6,
  },
  chips: { gap: 8, paddingVertical: 2 },
  chip: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  chipOn: { backgroundColor: palette.accent, borderColor: palette.accent },
  chipOff: { backgroundColor: 'transparent', borderColor: palette.borderChip },
  chipText: { fontSize: 13, fontFamily: fonts.sb },
  chipTextOn: { color: palette.onAccent },
  chipTextOff: { color: palette.text75 },
  segment: {
    flexDirection: 'row' as const,
    alignSelf: 'flex-start' as const,
    backgroundColor: palette.inputBg,
    borderWidth: 1,
    borderColor: palette.borderSeg,
    borderRadius: radius.seg,
    padding: 3,
  },
  segItem: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 9 },
  segItemActive: { backgroundColor: palette.accent },
  segText: { fontSize: 13, fontFamily: fonts.sb },
  segOn: { color: palette.onAccent },
  segOff: { color: palette.text6 },
  error: { fontSize: 13, fontFamily: fonts.sb, color: palette.danger, marginTop: 4 },
  actions: { flexDirection: 'row' as const, gap: 10, marginTop: 12 },
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
  saveDisabled: { opacity: 0.5 },
  saveText: { fontSize: 15, fontFamily: fonts.b, color: palette.onAccent },
});
