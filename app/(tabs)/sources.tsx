import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PlusIcon } from '../../src/components/Icons';
import { Toggle } from '../../src/components/Toggle';
import { SOURCES } from '../../src/data/sources';
import { selectActiveSourceCount } from '../../src/store/selectors';
import { useDispatch, useStore } from '../../src/store/StoreProvider';
import { colors, fonts } from '../../src/theme/tokens';

export default function SourcesScreen() {
  const state = useStore();
  const dispatch = useDispatch();
  const active = selectActiveSourceCount(state);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Kaynaklar</Text>
        <Text style={styles.meta}>
          {SOURCES.length} kaynak · <Text style={styles.active}>{active} aktif</Text>
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {SOURCES.map((s) => {
          const on = !!state.srcOn[s.k];
          return (
            <View key={s.k} style={[styles.row, { opacity: on ? 1 : 0.55 }]}>
              <View style={styles.tile}>
                <Text style={styles.tileText}>{s.tile}</Text>
              </View>
              <View style={styles.mid}>
                <Text style={styles.name}>{s.name}</Text>
                <Text style={styles.sub}>{s.meta}</Text>
              </View>
              <Toggle
                on={on}
                onToggle={() => dispatch({ type: 'toggleSource', key: s.k })}
                accessibilityLabel={s.name}
              />
            </View>
          );
        })}

        <View style={styles.addBox}>
          <PlusIcon />
          <Text style={styles.addText}>Yeni kaynak ekle (RSS / URL)</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.appBg },
  header: { paddingHorizontal: 20, paddingTop: 14 },
  title: { fontSize: 21, fontFamily: fonts.xb, color: colors.text },
  meta: { fontSize: 12, fontFamily: fonts.r, color: colors.text55, marginTop: 2 },
  active: { color: colors.accentText, fontFamily: fonts.sb },
  list: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 60,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderRow,
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.tile,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileText: { fontSize: 13, fontFamily: fonts.xb, color: colors.lightAccent },
  mid: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontFamily: fonts.sb, color: colors.text },
  sub: { fontSize: 12, fontFamily: fonts.r, color: colors.text55 },
  addBox: {
    height: 50,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.borderDashed,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
  },
  addText: { fontSize: 14, fontFamily: fonts.sb, color: colors.accentText },
});
