import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AddSourceSheet } from '../../src/components/AddSourceSheet';
import { PlusIcon } from '../../src/components/Icons';
import { ErrorState, LoadingState } from '../../src/components/StateViews';
import { Toggle } from '../../src/components/Toggle';
import { useSources } from '../../src/data-access/hooks';
import type { Palette } from '../../src/theme/palettes';
import { useTheme, useThemedStyles } from '../../src/theme/ThemeProvider';
import { fonts, radius, TAB_BAR_SPACE } from '../../src/theme/typography';
import { useEnabledSources } from '../../src/user-state/hooks';
import { setEnabledSourceIds } from '../../src/user-state/store';

export default function SourcesScreen() {
  const { palette } = useTheme();
  const styles = useThemedStyles(createStyles);
  const sources = useSources();
  const { enabledSourceIds } = useEnabledSources();
  const [sheetOpen, setSheetOpen] = useState(false);

  const catalog = sources.data ?? [];

  /**
   * No stored preference yet means "everything on": the device adopts the
   * catalog's defaults rather than starting with an empty feed (P6 first run).
   *
   * That default has to be *materialised* before the first toggle. Turning one
   * source off while the stored value is still absent would otherwise persist
   * only the survivors of an empty list — i.e. switch every source off at once.
   * So the screen writes the whole next list rather than one delta.
   */
  const [draft, setDraft] = useState<string[] | null>(null);
  const effective = draft ?? enabledSourceIds ?? catalog.map((source) => source.id);
  const isOn = (id: string) => effective.includes(id);
  const activeCount = catalog.filter((source) => isOn(source.id)).length;

  const toggle = (id: string, next: boolean) => {
    const list = next
      ? [...new Set([...effective, id])]
      : effective.filter((current) => current !== id);
    setDraft(list);
    void setEnabledSourceIds(list);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Kaynaklar</Text>
        <Text style={styles.meta}>
          {catalog.length} kaynak · <Text style={styles.active}>{activeCount} aktif</Text>
        </Text>
      </View>

      {sources.isPending ? (
        <LoadingState />
      ) : sources.isError ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {catalog.map((source) => {
            const on = isOn(source.id);
            return (
              <View key={source.id} style={[styles.row, !on && styles.rowOff]}>
                <View style={styles.tile}>
                  <Text style={styles.tileText}>{source.tile}</Text>
                </View>
                <View style={styles.mid}>
                  <Text style={styles.name}>{source.name}</Text>
                  <Text style={styles.sub}>
                    {source.category} · {source.language.toUpperCase()}
                  </Text>
                </View>
                <Toggle
                  on={on}
                  onToggle={() => toggle(source.id, !on)}
                  accessibilityLabel={source.name}
                />
              </View>
            );
          })}

          <Pressable
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.addBox, pressed && styles.addPressed]}
          >
            <PlusIcon color={palette.accentText} />
            <Text style={styles.addText}>Yeni kaynak ekle (RSS / URL)</Text>
          </Pressable>
        </ScrollView>
      )}

      <AddSourceSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onAdded={() => void sources.refetch()}
      />
    </SafeAreaView>
  );
}

const createStyles = (palette: Palette) => ({
  screen: { flex: 1, backgroundColor: palette.appBg },
  header: { paddingHorizontal: 20, paddingTop: 14 },
  title: { fontSize: 21, fontFamily: fonts.xb, color: palette.text },
  meta: { fontSize: 12, fontFamily: fonts.r, color: palette.text55, marginTop: 2 },
  active: { color: palette.accentText, fontFamily: fonts.sb },
  list: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: TAB_BAR_SPACE },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    minHeight: 60,
    borderBottomWidth: 1,
    borderBottomColor: palette.borderRow,
  },
  rowOff: { opacity: 0.55 },
  tile: {
    width: 40,
    height: 40,
    borderRadius: radius.seg,
    backgroundColor: palette.tile,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  tileText: { fontSize: 13, fontFamily: fonts.xb, color: palette.lightAccent },
  mid: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontFamily: fonts.sb, color: palette.text },
  sub: { fontSize: 12, fontFamily: fonts.r, color: palette.text55 },
  addBox: {
    height: 50,
    borderWidth: 1.5,
    borderStyle: 'dashed' as const,
    borderColor: palette.borderDashed,
    borderRadius: radius.seg,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
    marginTop: 16,
  },
  addPressed: { backgroundColor: palette.accentSoft },
  addText: { fontSize: 14, fontFamily: fonts.sb, color: palette.accentText },
});
