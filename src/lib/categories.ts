import {
    BrainCircuit,
    Camera,
    Equal,
    type LucideIcon,
    Radar,
    Ruler,
    Thermometer,
} from "lucide-react";

/**
 * Visual identity for the five question categories.
 *
 * Colors are sampled from the official Hide + Seek physical game cards.
 * Icons are from lucide-react.
 *
 * `iconSvgPaths` carries the raw inner SVG of the Lucide icon for use
 * in places where rendering a React component isn't practical
 * (e.g., Leaflet DivIcon HTML strings). 24x24 viewBox, stroke-based.
 *
 * Keys match the `id` field of each question schema in `src/maps/schema.ts`.
 */
export const CATEGORIES = {
    matching: {
        color: "#7d8087",
        icon: Equal,
        label: "Matching",
        iconSvgPaths: `<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/>`,
    },
    measuring: {
        color: "#9dc99e",
        icon: Ruler,
        label: "Measuring",
        iconSvgPaths: `<path d="M21.3 8.7 8.7 21.3a2.41 2.41 0 0 1-3.4 0l-2.6-2.6a2.41 2.41 0 0 1 0-3.4L15.3 2.7a2.41 2.41 0 0 1 3.4 0l2.6 2.6a2.41 2.41 0 0 1 0 3.4Z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/><path d="m4.5 13.5 2 2"/>`,
    },
    radius: {
        // Internal id stays `radius` for save-game compatibility, but the
        // user-facing label is "Radar" — that's what the rulebook calls
        // the category ("Are you within ___ of me?" questions, p28).
        color: "#f5a888",
        icon: Radar,
        label: "Radar",
        iconSvgPaths: `<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>`,
    },
    thermometer: {
        color: "#f5d268",
        icon: Thermometer,
        label: "Thermometer",
        iconSvgPaths: `<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>`,
    },
    tentacles: {
        color: "#b09cd5",
        icon: BrainCircuit,
        label: "Tentacles",
        iconSvgPaths: `<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M12 13h4"/><path d="M12 18h6a2 2 0 0 1 2 2v1"/><path d="M12 8h8"/><path d="M16 8V5a2 2 0 0 1 2-2"/><circle cx="16" cy="13" r=".5"/><circle cx="18" cy="3" r=".5"/><circle cx="20" cy="21" r=".5"/><circle cx="20" cy="8" r=".5"/>`,
    },
    photo: {
        // Cool blue — distinct from the other category colors so the
        // photo tile reads at a glance against matching grey, measuring
        // green, radar peach, thermometer yellow, tentacles purple.
        color: "#7fbcd6",
        icon: Camera,
        label: "Photo",
        iconSvgPaths: `<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>`,
    },
} as const satisfies Record<
    string,
    {
        color: string;
        icon: LucideIcon;
        label: string;
        iconSvgPaths: string;
    }
>;

export type CategoryId = keyof typeof CATEGORIES;

/**
 * Build a Leaflet DivIcon HTML string for a category marker.
 * Teardrop pin filled with the category color, white border,
 * drop shadow, with the Lucide icon centered in the head.
 *
 * When `pending` is true (the question's `drag` is still set — i.e. the
 * hider hasn't replied yet), we draw a "?" badge in the upper-right of
 * the pin and add a `jl-marker-pulse` class to the wrap so CSS can
 * animate a halo. Helps the seeker spot which markers are still
 * awaiting an answer vs. answered.
 */
export function buildMarkerHtml(
    category: CategoryId,
    pending: boolean = false,
): string {
    const meta = CATEGORIES[category];
    return `
<div class="jl-marker-wrap${pending ? " jl-marker-pulse" : ""}">
  <svg width="34" height="46" viewBox="0 0 34 46" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="jl-marker-shadow-${category}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="1.4"/>
        <feOffset dx="0" dy="1.5"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
        <feMerge>
          <feMergeNode/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    <path
      d="M 17 2 C 9.8 2, 4 7.8, 4 15 C 4 24, 17 43, 17 43 C 17 43, 30 24, 30 15 C 30 7.8, 24.2 2, 17 2 Z"
      fill="${meta.color}"
      stroke="white"
      stroke-width="2.5"
      filter="url(#jl-marker-shadow-${category})"
    />
    <svg x="11" y="9" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      ${meta.iconSvgPaths}
    </svg>
    ${
        pending
            ? `<g>
        <circle cx="26" cy="9" r="6" fill="#0f172a" stroke="white" stroke-width="1.8"/>
        <text x="26" y="13" font-family="Inter Tight, system-ui, sans-serif" font-weight="900" font-size="10" fill="white" text-anchor="middle">?</text>
      </g>`
            : ""
    }
  </svg>
</div>
    `.trim();
}
