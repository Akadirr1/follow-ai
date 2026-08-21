import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Text, View } from 'react-native';

import type { Palette } from '../theme/palettes';
import { useThemedStyles } from '../theme/ThemeProvider';
import { fonts, radius, TOAST_MS } from '../theme/typography';

/**
 * The prototype's single floating toast, now owned locally instead of by the
 * store (arch-001 §4: "replace by local `{id,text}` plus `showToast`/
 * `dismissToast(id)`; no durable persistence").
 *
 * Only four toasts survive P7 — save, unsave, delete, digest time. "Kaynak
 * tarayıcıda açılır" is gone because the button now actually opens the URL, and
 * the theme toast went in P8 when the control became real.
 */

export const TOASTS = {
  saved: 'Kaydedildi',
  unsaved: 'Kayıt kaldırıldı',
  deleted: 'Kayıt silindi',
  digestTime: 'Digest saati güncellendi',
} as const;

type Toast = { id: number; text: string };

type ToastApi = {
  toast: Toast | null;
  showToast: (text: string) => void;
  dismissToast: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const nextId = useRef(1);

  const showToast = useCallback((text: string) => {
    if (!text) {
      console.warn('[toast] showToast called with an empty message; ignoring.');
      return;
    }
    setToast({ id: nextId.current++, text });
  }, []);

  const dismissToast = useCallback((id: number) => {
    // Only the toast the timer was started for; a newer one owns its own clock.
    setToast((current) => (current && current.id === id ? null : current));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dismissToast(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, dismissToast]);

  const value = useMemo(
    () => ({ toast, showToast, dismissToast }),
    [toast, showToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastHost />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}

function ToastHost() {
  const { toast } = useToast();
  const styles = useThemedStyles(createStyles);
  if (!toast) return null;
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View style={styles.pill}>
        <Text style={styles.text} numberOfLines={1}>
          {toast.text}
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
