import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

import type { Palette } from '../theme/palettes';
import { useTheme } from '../theme/ThemeProvider';

type IconProps = {
  size?: number;
  color?: string;
  /** Bookmark only: filled when the article is saved. */
  fill?: string;
  strokeWidth?: number;
};

/**
 * All paths are transcribed from the prototype's inline SVGs.
 *
 * Each icon falls back to the *active palette* rather than a fixed dark token
 * when the caller passes no colour (P8 left these on the dark shim; P7 finishes
 * the migration), so an icon dropped into a light screen is never a dark glyph.
 */
const useIconColor = (color: string | undefined, slot: keyof Palette): string => {
  const { palette } = useTheme();
  return color ?? palette[slot];
};

export function SearchIcon({ size = 19, color, strokeWidth = 1.8 }: IconProps) {
  const stroke = useIconColor(color, 'text');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="11" cy="11" r="6.5" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Path d="M20 20l-4.4-4.4" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

export function BackIcon({ size = 19, color }: IconProps) {
  const stroke = useIconColor(color, 'text');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18.5L8.5 12 15 5.5"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ChevronRightIcon({ size = 16, color }: IconProps) {
  const stroke = useIconColor(color, 'text4');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 5.5l6.5 6.5L9 18.5"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function BookmarkIcon({ size = 19, color, fill = 'none', strokeWidth = 1.8 }: IconProps) {
  const stroke = useIconColor(color, 'accentText');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <Path
        d="M7 4h10v16l-5-3.5L7 20z"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        fill={fill}
      />
    </Svg>
  );
}

export function TrashIcon({ size = 17, color }: IconProps) {
  const stroke = useIconColor(color, 'text45');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 13h9.4l.8-13"
        stroke={stroke}
        strokeWidth={1.9}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function SparkleIcon({ size = 16, color, strokeWidth = 1.8 }: IconProps) {
  const stroke = useIconColor(color, 'accentText');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 4l1.8 5.2 5.2 1.8-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function FeedIcon({ size = 23, color, strokeWidth = 1.9 }: IconProps) {
  const stroke = useIconColor(color, 'text');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 6h16M4 12h16M4 18h9" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}

export function SourcesIcon({ size = 23, color, strokeWidth = 1.8 }: IconProps) {
  const stroke = useIconColor(color, 'text');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 11.5a7.5 7.5 0 0 1 7.5 7.5M5 5.5A13.5 13.5 0 0 1 18.5 19"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Circle cx="5.8" cy="18.2" r="1.5" fill={stroke} />
    </Svg>
  );
}

export function SettingsIcon({ size = 23, color, strokeWidth = 1.8 }: IconProps) {
  const stroke = useIconColor(color, 'text');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="3" stroke={stroke} strokeWidth={strokeWidth} />
      <Path
        d="M12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function ClockIcon({ size = 16, color }: IconProps) {
  const stroke = useIconColor(color, 'text45');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="8.5" stroke={stroke} strokeWidth={1.8} strokeLinecap="round" />
      <Path d="M12 7.5V12l3 2" stroke={stroke} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

export function CloseIcon({ size = 16, color }: IconProps) {
  const stroke = useIconColor(color, 'text5');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M6 6l12 12M18 6L6 18" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export function PlusIcon({ size = 16, color }: IconProps) {
  const stroke = useIconColor(color, 'accentText');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14M5 12h14" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export function ExternalLinkIcon({ size = 16, color }: IconProps) {
  const stroke = useIconColor(color, 'onAccent');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M14 4h6v6" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M20 4l-9 9" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M19 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h5.5"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
