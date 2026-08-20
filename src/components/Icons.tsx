import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '../theme/tokens';

type IconProps = {
  size?: number;
  color?: string;
  /** Bookmark only: filled when the article is saved. */
  fill?: string;
  strokeWidth?: number;
};

/** All paths are transcribed from the prototype's inline SVGs. */

export function SearchIcon({ size = 19, color = colors.text, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle
        cx="11"
        cy="11"
        r="6.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Path
        d="M20 20l-4.4-4.4"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function BackIcon({ size = 19, color = colors.text }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 18.5L8.5 12 15 5.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ChevronRightIcon({ size = 16, color = colors.text4 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 5.5l6.5 6.5L9 18.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function BookmarkIcon({
  size = 19,
  color = colors.accentText,
  fill = 'none',
  strokeWidth = 1.8,
}: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <Path
        d="M7 4h10v16l-5-3.5L7 20z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        fill={fill}
      />
    </Svg>
  );
}

export function TrashIcon({ size = 17, color = colors.text45 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 13h9.4l.8-13"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function SparkleIcon({ size = 16, color = colors.accentText, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 4l1.8 5.2 5.2 1.8-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function FeedIcon({ size = 23, color = colors.text, strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 6h16M4 12h16M4 18h9"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function SourcesIcon({ size = 23, color = colors.text, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 11.5a7.5 7.5 0 0 1 7.5 7.5M5 5.5A13.5 13.5 0 0 1 18.5 19"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Circle cx="5.8" cy="18.2" r="1.5" fill={color} />
    </Svg>
  );
}

export function SettingsIcon({ size = 23, color = colors.text, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="M12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function ClockIcon({ size = 16, color = colors.text45 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="8.5" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Path d="M12 7.5V12l3 2" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

export function CloseIcon({ size = 16, color = colors.text5 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 6l12 12M18 6L6 18"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function PlusIcon({ size = 16, color = colors.accentText }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export function ExternalLinkIcon({ size = 16, color = colors.white }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M14 4h6v6"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M20 4l-9 9"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M19 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h5.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The iOS status-bar glyph block from the prototype frame. */
export function StatusGlyphs() {
  return (
    <Svg width={58} height={12} viewBox="0 0 58 12" fill="none">
      <Rect y="6.5" width="3" height="5" rx="1" fill={colors.text} />
      <Rect x="4.5" y="4.5" width="3" height="7" rx="1" fill={colors.text} />
      <Rect x="9" y="2.5" width="3" height="9" rx="1" fill={colors.text} />
      <Path
        d="M20 5.5a7.5 7.5 0 0 1 9.6 0M22.2 8a4.2 4.2 0 0 1 5.2 0"
        stroke={colors.text}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      <Circle cx="24.8" cy="10.4" r="1.1" fill={colors.text} />
      <Rect
        x="36.5"
        y="1"
        width="20"
        height="10"
        rx="3"
        stroke={colors.text}
        strokeOpacity={0.45}
      />
      <Rect x="38.5" y="3" width="12" height="6" rx="1.5" fill={colors.text} />
    </Svg>
  );
}
