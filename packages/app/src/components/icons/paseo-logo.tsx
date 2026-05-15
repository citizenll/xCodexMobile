import Svg, { Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const { theme } = useUnistyles();
  const accent = color ?? theme.colors.foreground;

  return (
    <Svg width={size} height={size} viewBox="0 0 512 512" fill="none">
      <Path
        d="M97 165C134 116 174 109 214 144C259 184 279 205 326 193C356 185 382 163 415 130"
        stroke={accent}
        strokeWidth={32}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M135 267C135 349 189 402 256 402C323 402 377 349 377 267"
        stroke={accent}
        strokeWidth={32}
        strokeLinecap="round"
      />
      <Path
        d="M177 267C177 324 212 361 256 361C300 361 335 324 335 267"
        stroke={accent}
        strokeWidth={26}
        strokeLinecap="round"
      />
      <Path
        d="M219 267C219 297 235 316 256 316C277 316 293 297 293 267"
        stroke={accent}
        strokeWidth={22}
        strokeLinecap="round"
      />
    </Svg>
  );
}
