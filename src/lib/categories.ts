import {
    BrainCircuit,
    Equal,
    Radar,
    Ruler,
    Thermometer,
    type LucideIcon,
} from "lucide-react";

/**
 * Visual identity for the five question categories.
 *
 * Colors are sampled from the official Hide + Seek physical game cards
 * (Matching grey, Measuring green, Radius peach, Thermometer yellow,
 * Tentacles purple). Icons are from lucide-react, chosen to evoke the
 * card-art glyphs without copying them.
 *
 * Keys match the `id` field of each question schema in `src/maps/schema.ts`.
 */
export const CATEGORIES = {
    matching: {
        color: "#7d8087",
        icon: Equal,
        label: "Matching",
    },
    measuring: {
        color: "#9dc99e",
        icon: Ruler,
        label: "Measuring",
    },
    radius: {
        color: "#f5a888",
        icon: Radar,
        label: "Radius",
    },
    thermometer: {
        color: "#f5d268",
        icon: Thermometer,
        label: "Thermometer",
    },
    tentacles: {
        color: "#b09cd5",
        icon: BrainCircuit,
        label: "Tentacles",
    },
} as const satisfies Record<
    string,
    { color: string; icon: LucideIcon; label: string }
>;

export type CategoryId = keyof typeof CATEGORIES;
