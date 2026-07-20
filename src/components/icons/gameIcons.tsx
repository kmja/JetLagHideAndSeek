import { createLucideIcon, type LucideIcon } from "lucide-react";

/**
 * Custom brand icons authored in the Lucide format (`createLucideIcon`), so
 * they're drop-in `LucideIcon`s — same `size` / `className` / `strokeWidth`
 * API as every other icon in the app, and they inherit Lucide's round
 * caps/joins + `currentColor`. (Lucide's `IconNode` takes attribute VALUES as
 * strings, so every coordinate below is a string.)
 */

/**
 * Skull &amp; crossbones — the curse glyph. Lucide has no skull-and-crossbones
 * (only a plain `Skull`), so this is a hand-authored FILLED skull (big round
 * eye holes + a small nose, chunky rounded cranium) over a thick crossbones X,
 * matching the Jet Lag: The Game curse mark. The skull path is `fillRule
 * evenodd` so the eyes/nose read as holes; the bones are stroked with round
 * lobed ends. (Overrides Lucide's `fill:none` per element.)
 */
export const SkullCrossbones: LucideIcon = createLucideIcon("SkullCrossbones", [
    [
        "line",
        {
            x1: "6",
            y1: "17.5",
            x2: "18",
            y2: "22.5",
            strokeWidth: "2.6",
            strokeLinecap: "round",
            key: "bone-a",
        },
    ],
    [
        "line",
        {
            x1: "18",
            y1: "17.5",
            x2: "6",
            y2: "22.5",
            strokeWidth: "2.6",
            strokeLinecap: "round",
            key: "bone-b",
        },
    ],
    ["circle", { cx: "6", cy: "17.5", r: "1.35", fill: "currentColor", stroke: "none", key: "lobe-1" }],
    ["circle", { cx: "18", cy: "17.5", r: "1.35", fill: "currentColor", stroke: "none", key: "lobe-2" }],
    ["circle", { cx: "6", cy: "22.5", r: "1.35", fill: "currentColor", stroke: "none", key: "lobe-3" }],
    ["circle", { cx: "18", cy: "22.5", r: "1.35", fill: "currentColor", stroke: "none", key: "lobe-4" }],
    [
        "path",
        {
            d: "M12 2.2C7.4 2.2 4 5.7 4 10.1c0 2.5 1.2 4.6 3 5.9v1.6c0 .5.2.9.6 1.2q.7 1.2 1.4 0 .7 1.2 1.4 0 .7 1.2 1.4 0 .7 1.2 1.4 0c.4-.3.6-.7.6-1.2V16c1.8-1.3 3-3.4 3-5.9 0-4.4-3.4-7.9-8-7.9ZM8.7 7.6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm6.6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM12 12.6l1.3 2.4h-2.6Z",
            fill: "currentColor",
            stroke: "none",
            fillRule: "evenodd",
            key: "skull",
        },
    ],
]);

/**
 * Golf flag on a green — the "golf course" matching/measuring subtype. A hollow
 * pennant on a pole planted in an elliptical green with a ball beside it, so it
 * reads as a golf COURSE (not a generic flag). Stroke-only, so it sits cleanly
 * among the other Lucide subtype glyphs.
 */
export const GolfFlag: LucideIcon = createLucideIcon("GolfFlag", [
    ["path", { d: "M9 19V4", key: "pole" }],
    ["path", { d: "M9 4l8 2.5L9 9", key: "pennant" }],
    ["ellipse", { cx: "10", cy: "19.5", rx: "6.5", ry: "1.8", key: "green" }],
    ["circle", { cx: "15.5", cy: "18.6", r: "1.2", key: "ball" }],
]);
