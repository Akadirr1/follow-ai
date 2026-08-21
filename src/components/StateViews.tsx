import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { asDataError } from '../data-access/hooks';
import { relativeTimeTr } from '../format/relativeTime';
import type { Palette } from '../theme/palettes';
import { useTheme, useThemedStyles } from '../theme/ThemeProvider';
import { fonts, radius } from '../theme/typography';

/**
 * The four states every data-backed screen owes the user: busy, broken,
 * showing-stale-data, and nothing-here. Sharing them keeps the copy identical
 * across screens rather than drifting per screen.
 */

export function LoadingState({ label = 'Yükleniyor…' }: { label?: string }) {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.centered} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={palette.accentText} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

/**
 * Turkish copy per error code. A `DataError` already carries a code and a
 * `retryable` flag, so the UI can say something true instead of "bir hata oluştu"
 * for everything — and only offer "Tekrar dene" when a retry could work.
 */
export function errorMessageTr(thrown: unknown): string {
  const error = asDataError(thrown);
  switch (error?.code) {
    case 'network':
      return 'Bağlantı kurulamadı. İnternetini kontrol et.';
    case 'rate_limited':
      return 'Çok fazla istek gönderildi. Biraz sonra tekrar dene.';
    case 'not_found':
      return 'İçerik bulunamadı.';
    case 'not_implemented':
      return 'Bu özellik henüz hazır değil.';
    case 'invalid_input':
      return 'İstek geçersiz.';
    case 'unsupported_source':
      return 'Bu kaynak desteklenmiyor.';
    case 'duplicate_source':
      return 'Bu kaynak zaten ekli.';
    default:
      return 'Bir şeyler ters gitti.';
  }
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const retryable = asDataError(error)?.retryable ?? true;
  return (
    <View style={styles.centered}>
      <Text style={styles.errorTitle}>{errorMessageTr(error)}</Text>
      {onRetry && retryable ? (
        <Pressable onPress={onRetry} accessibilityRole="button" style={styles.retry}>
          <Text style={styles.retryText}>Tekrar dene</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Shown when the list on screen came from the persisted cache and the refetch
 * failed. The rule from arch-001 §4 is that stale data renders immediately and
 * the staleness is *visible* — a silent stale feed is indistinguishable from a
 * fresh one.
 */
export function OfflineBanner({ updatedAt }: { updatedAt: number | null }) {
  const styles = useThemedStyles(createStyles);
  const label = updatedAt ? relativeTimeTr(new Date(updatedAt).toISOString()) : 'bilinmiyor';
  return (
    <View style={styles.offline} accessibilityRole="alert">
      <Text style={styles.offlineText} numberOfLines={1}>
        Çevrimdışı — son güncelleme {label}
      </Text>
    </View>
  );
}

const createStyles = (palette: Palette) => ({
  centered: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 10,
    paddingVertical: 48,
    paddingHorizontal: 30,
  },
  muted: { fontSize: 13, fontFamily: fonts.r, color: palette.text55 },
  errorTitle: {
    fontSize: 15,
    fontFamily: fonts.sb,
    color: palette.text,
    textAlign: 'center' as const,
  },
  retry: {
    height: 44,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: palette.borderChip,
    borderRadius: radius.seg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  retryText: { fontSize: 14, fontFamily: fonts.sb, color: palette.accentText },
  offline: {
    backgroundColor: palette.accentSoft,
    borderWidth: 1,
    borderColor: palette.borderChip,
    borderRadius: radius.seg,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginBottom: 4,
  },
  offlineText: { fontSize: 12, fontFamily: fonts.sb, color: palette.accentText },
});
