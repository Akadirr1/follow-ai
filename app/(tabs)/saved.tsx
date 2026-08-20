import { useRouter } from 'expo-router';
import React, { useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EmptyState } from '../../src/components/EmptyState';
import { TrashIcon } from '../../src/components/Icons';
import { selectSaved, selectUnreadSavedCount } from '../../src/store/selectors';
import { useDispatch, useStore } from '../../src/store/StoreProvider';
import { colors, fonts, radius } from '../../src/theme/tokens';

export default function SavedScreen() {
  const state = useStore();
  const dispatch = useDispatch();
  const router = useRouter();
  const items = selectSaved(state);
  const unread = selectUnreadSavedCount(state);

  // Prototype `_suppressOpen`: on web the trash press can bubble to the card, which
  // would delete and navigate at once. The 50 ms window swallows that second press.
  const suppressOpen = useRef(false);

  const open = (id: string) => {
    if (suppressOpen.current) {
      console.warn(`[saved] open("${id}") suppressed: a delete press is in flight`);
      return;
    }
    dispatch({ type: 'openArticle', id, markRead: true });
    router.push(`/article/${id}`);
  };

  const remove = (id: string) => {
    suppressOpen.current = true;
    setTimeout(() => {
      suppressOpen.current = false;
    }, 50);
    dispatch({ type: 'deleteSaved', id });
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Kaydedilenler</Text>
        <Text style={styles.meta}>
          {items.length} kayıt · <Text style={styles.unread}>{unread} okunmadı</Text>
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {items.map((a) => {
          const isRead = !!state.read[a.id];
          return (
            <Pressable
              key={a.id}
              onPress={() => open(a.id)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.card,
                { opacity: isRead ? 0.62 : 1 },
                pressed && { borderColor: 'rgba(96,165,250,.55)' },
              ]}
            >
              <View style={styles.row}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: isRead ? 'transparent' : colors.accentText },
                  ]}
                />
                <View style={styles.mid}>
                  <Text style={styles.src}>{a.src}</Text>
                  <Text style={styles.sub}>
                    {a.time} · {a.cat}
                  </Text>
                </View>
                <Pressable
                  onPress={() => remove(a.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${a.src} kaydını sil`}
                  style={({ pressed }) => [
                    styles.trash,
                    pressed && { backgroundColor: 'rgba(229,72,77,.15)' },
                  ]}
                >
                  <TrashIcon />
                </Pressable>
              </View>
              <Text style={styles.cardTitle}>{a.title}</Text>
            </Pressable>
          );
        })}

        {items.length === 0 ? (
          <EmptyState
            iconSize={96}
            iconRadius={22}
            title="Kaydedilen haber yok"
            line="Detaydaki bookmark simgesine dokunarak kaydet."
            lineHeight={21}
            paddingVertical={80}
          >
            <Pressable
              onPress={() => router.replace('/')}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.backButton,
                pressed && { backgroundColor: 'rgba(37,99,235,.15)' },
              ]}
            >
              <Text style={styles.backText}>Feed&apos;e dön</Text>
            </Pressable>
          </EmptyState>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.appBg },
  header: { paddingHorizontal: 20, paddingTop: 14 },
  title: { fontSize: 21, fontFamily: fonts.xb, color: colors.text },
  meta: { fontSize: 12, fontFamily: fonts.r, color: colors.text55, marginTop: 2 },
  unread: { color: colors.accentText, fontFamily: fonts.sb },
  list: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24, gap: 12 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  mid: { flex: 1, minWidth: 0 },
  src: { fontSize: 13, fontFamily: fonts.sb, color: colors.text },
  sub: { fontSize: 12, fontFamily: fonts.r, color: colors.text55 },
  trash: {
    width: 40,
    height: 40,
    borderRadius: radius.tile,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: 16, fontFamily: fonts.sb, color: colors.text, lineHeight: 22 },
  backButton: {
    height: 46,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: colors.borderDashed,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  backText: { fontSize: 14, fontFamily: fonts.sb, color: colors.accentText },
});
