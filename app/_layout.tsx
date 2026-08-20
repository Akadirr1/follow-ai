import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Toast } from '../src/components/Toast';
import { StoreProvider } from '../src/store/StoreProvider';
import { colors } from '../src/theme/tokens';

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  useEffect(() => {
    if (fontError) {
      // Inter is the prototype's face; the system fallback keeps the app usable but
      // it is a visible regression, so it must not pass unnoticed.
      console.warn('[fonts] Inter failed to load, falling back to system:', fontError);
    }
  }, [fontError]);

  if (!fontsLoaded && !fontError) {
    // Blank canvas rather than a flash of fallback type.
    return <View style={styles.root} />;
  }

  return (
    <SafeAreaProvider>
      <StoreProvider>
        <View style={styles.root}>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.appBg },
              animation: 'slide_from_right',
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="article/[id]" />
            <Stack.Screen name="search" options={{ animation: 'fade' }} />
          </Stack>
          <Toast />
        </View>
      </StoreProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.appBg },
});
