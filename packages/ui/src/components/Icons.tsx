/**
 * Line icons.
 *
 * Why not glyphs.
 *
 * The UI mixed text characters (`+`, `×`, `⧉`, `⚙`, `⏱`) with emoji (`🗑`). Those
 * come from different typefaces, so they render at different weights, different
 * optical sizes, and different baselines — and `🗑` renders as a full-colour
 * glossy pictogram next to hairline characters, which is what made the delete
 * affordance read as a different design language from everything beside it.
 *
 * These are stroked SVG paths on a 24-unit grid with a consistent stroke width, so
 * every icon has the same optical weight at any size and inherits `currentColor`.
 *
 * Geometry rules, so a new icon matches the set:
 *   - 24×24 viewBox, drawn inside a 20×20 area (2 units of padding all round)
 *   - 1.6 stroke width on a 24 grid, round caps and joins
 *   - no fills except where a shape is genuinely solid (a dot)
 *   - `vector-effect: non-scaling-stroke` is deliberately NOT used: these are sized
 *     in whole pixels, so scaling the stroke with them keeps the weight consistent
 */

export interface IconProps {
  /** Pixel size of the square. Defaults to 16, which pairs with 12–13px text. */
  size?: number;
  className?: string;
  /** Accessible label. Omit for decorative icons next to visible text. */
  title?: string;
}

/**
 * Shared wrapper.
 *
 * `aria-hidden` unless a title is given: an icon beside a text label is decoration,
 * and announcing both makes screen readers repeat themselves.
 */
function Svg({ size = 16, className, title, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      style={{ flexShrink: 0, display: 'block' }}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>
);

export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4.5l3 1.8" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.56 1.03z" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
  </Svg>
);

export const IconWindows = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M12 3.5v17" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="M7.5 10.5L12 15l4.5-4.5" />
    <path d="M4.5 19.5h15" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="M6 9.5l6 6 6-6" /></Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="M9.5 6l6 6-6 6" /></Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7" /></Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20 4v4h-4" />
  </Svg>
);

/**
 * Two shapes joining: used for the shared / merged knowledge base.
 *
 * A link glyph would suggest a URL, and a single merge arrow would not convey that the point is
 * two libraries becoming one that several workspaces share.
 */
export const IconMerge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h4l4 6 4-6h4" />
    <path d="M4 18h4l4-6" />
    <path d="M16 18h4" />
  </Svg>
);

export const IconSend = (p: IconProps) => (
  <Svg {...p}><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></Svg>
);

/** Solid square, for "stop". Filled because the shape means "halt the flow". */
export const IconStop = ({ size = 16, className, title }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={className}
    aria-hidden={title ? undefined : true}
    role={title ? 'img' : undefined}
    style={{ flexShrink: 0, display: 'block' }}
  >
    {title ? <title>{title}</title> : null}
    {/* Rounded rect rather than a hard square — a 90° corner is the one shape that
        reads as "unfinished" beside the rest of the set. */}
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" />
  </svg>
);
