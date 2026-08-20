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
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Toast } from '../src/components/Toast';
import { StoreProvider } from '../src/store/StoreProvider';
import { dark } from '../src/theme/palettes';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';

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
    // Blank canvas rather than a flash of fallback type. Dark is the primary theme,
    // so the gate paints dark before the stored preference is known.
    return <View style={{ flex: 1, backgroundColor: dark.appBg }} />;
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <StoreProvider>
          <ThemedApp />
        </StoreProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * Inside the provider so it can read the resolved palette. It holds the same blank
 * canvas until the stored preference has been read, so the app never paints one
 * theme and then swaps to the other in front of the user.
 */
function ThemedApp() {
  const { palette, scheme, isReady } = useTheme();

  if (!isReady) {
    return <View style={{ flex: 1, backgroundColor: dark.appBg }} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.appBg }}>
      {/* Light content on a dark ground and vice versa. */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: palette.appBg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="article/[id]" />
        <Stack.Screen name="search" options={{ animation: 'fade' }} />
      </Stack>
      <Toast />
    </View>
  );
}
