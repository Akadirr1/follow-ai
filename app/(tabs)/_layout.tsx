import { Tabs } from 'expo-router';
import React from 'react';

import {
  BookmarkIcon,
  FeedIcon,
  SettingsIcon,
  SourcesIcon,
  SparkleIcon,
} from '../../src/components/Icons';
import { colors, fonts } from '../../src/theme/tokens';

/** Five tabs, in the prototype's order; feed is the default route. */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accentText,
        tabBarInactiveTintColor: colors.tabInactive,
        sceneStyle: { backgroundColor: colors.appBg },
        tabBarStyle: {
          backgroundColor: colors.tabBarBg,
          borderTopWidth: 1,
          borderTopColor: colors.tabBarBorder,
          height: 88,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 10.5, fontFamily: fonts.sb },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color }) => <FeedIcon size={23} color={color} />,
        }}
      />
      <Tabs.Screen
        name="digest"
        options={{
          title: 'Digest',
          tabBarIcon: ({ color }) => <SparkleIcon size={23} color={color} />,
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: 'Kaydedilen',
          tabBarIcon: ({ color }) => <BookmarkIcon size={23} color={color} fill="none" />,
        }}
      />
      <Tabs.Screen
        name="sources"
        options={{
          title: 'Kaynaklar',
          tabBarIcon: ({ color }) => <SourcesIcon size={23} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Ayarlar',
          tabBarIcon: ({ color }) => <SettingsIcon size={23} color={color} />,
        }}
      />
    </Tabs>
  );
}
