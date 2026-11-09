import { useId } from "react";

/**
 * The HOLO logo: a projector throws a cone of light, with a wireframe crystal hanging in it.
 * The tile is always dark, so the mark reads the same in the dark and light themes.
 * The master file is apps/desktop/build/icon.svg; keep the two in step.
 */
export function HoloMark({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const u = (n: string) => `url(#${id}${n})`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}bg`} cx=".3" cy=".2" r="1">
          <stop offset="0" stopColor="#1E1638" />
          <stop offset="1" stopColor="#07070D" />
        </radialGradient>
        <linearGradient id={`${id}cone`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#22D3EE" stopOpacity=".75" />
          <stop offset="1" stopColor="#8B5CF6" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}w`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#22D3EE" />
          <stop offset="1" stopColor="#F05BDC" />
        </linearGradient>
        <filter id={`${id}g`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="64" height="64" rx="14" fill={u("bg")} />
      <g transform="translate(7 7) scale(.78125)">
        <path d="M26 54 L4 4 L60 4 L38 54 Z" fill={u("cone")} opacity=".55" />
        <path
          d={CRYSTAL}
          fill="none"
          stroke={u("w")}
          strokeWidth="1.8"
          strokeLinejoin="round"
          filter={u("g")}
        />
        <path d="M4 46 H14 M4 42 H10 M50 46 H60 M54 42 H60" stroke="#22D3EE" strokeWidth="1" opacity=".55" />
        <ellipse cx="32" cy="55" rx="13" ry="3.6" fill="none" stroke="#22D3EE" strokeWidth="2.2" filter={u("g")} />
        <ellipse cx="32" cy="55" rx="5" ry="1.4" fill="#fff" />
      </g>
    </svg>
  );
}

const CRYSTAL =
  "M32 10.6 L42.4 16.3 L42.4 27.7 L32 33.4 L21.6 27.7 L21.6 16.3 Z M32 10.6 L32 16 M42.4 16.3 L32 16 M42.4 27.7 L37.2 25 M32 33.4 L37.2 25 M21.6 27.7 L26.8 25 M21.6 16.3 L26.8 25 M32 16 L37.2 25 L26.8 25 Z";
