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
    // ── Crossbones (behind the skull): two thick rounded bones forming an X in
    //    the lower half, each with a knob at both ends. ──
    [
        "line",
        {
            x1: "5.5",
            y1: "17.8",
            x2: "18.5",
            y2: "22.8",
            strokeWidth: "2.8",
            strokeLinecap: "round",
            key: "bone-a",
        },
    ],
    [
        "line",
        {
            x1: "18.5",
            y1: "17.8",
            x2: "5.5",
            y2: "22.8",
            strokeWidth: "2.8",
            strokeLinecap: "round",
            key: "bone-b",
        },
    ],
    ["circle", { cx: "5.5", cy: "17.8", r: "1.5", fill: "currentColor", stroke: "none", key: "knob-1" }],
    ["circle", { cx: "18.5", cy: "17.8", r: "1.5", fill: "currentColor", stroke: "none", key: "knob-2" }],
    ["circle", { cx: "5.5", cy: "22.8", r: "1.5", fill: "currentColor", stroke: "none", key: "knob-3" }],
    ["circle", { cx: "18.5", cy: "22.8", r: "1.5", fill: "currentColor", stroke: "none", key: "knob-4" }],
    // ── Skull (one evenodd path: outer cranium+jaw outline, then the eye
    //    sockets, nose, and two tooth gaps cut out as holes). ──
    [
        "path",
        {
            d: [
                // Outer outline (symmetric about x=12): rounded cranium tapering
                // to a jaw.
                "M12 2.6",
                "C16 2.6 19.4 5.6 19.4 10",
                "C19.4 12.8 18.2 14.4 16.2 15.4",
                "L16 17.3",
                "C16 18.3 15.3 18.9 14.4 18.9",
                "L9.6 18.9",
                "C8.7 18.9 8 18.3 8 17.3",
                "L7.8 15.4",
                "C5.8 14.4 4.6 12.8 4.6 10",
                "C4.6 5.6 8 2.6 12 2.6 Z",
                // Left + right eye sockets (round holes).
                "M7.3 10.3 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 Z",
                "M12.7 10.3 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 Z",
                // Nose (inverted triangle hole).
                "M12 12.4 L11 14.2 L13 14.2 Z",
                // Two tooth gaps in the lower jaw.
                "M10.7 17.7 L11.2 17.7 L11.2 18.6 L10.7 18.6 Z",
                "M12.8 17.7 L13.3 17.7 L13.3 18.6 L12.8 18.6 Z",
            ].join(" "),
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
