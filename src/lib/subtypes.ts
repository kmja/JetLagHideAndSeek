import {
    Building2,
    Bus,
    Castle,
    Cross,
    Drama,
    Film,
    Fish,
    Flag,
    Flame,
    GraduationCap,
    Hospital,
    Hotel,
    Landmark,
    Library,
    LucideIcon,
    MapPin,
    Mountain,
    Plane,
    Rocket,
    Ship,
    Star,
    TentTree,
    Trees,
    Trophy,
    Waves,
} from "lucide-react";

/**
 * Metadata for question-subtype selection: matching/measuring/tentacles each
 * have many sub-types (airport, hospital, museum, ...). The new step-2 picker
 * in AddQuestionDialog displays these as larger icon tiles so the choice is
 * tactile and visual rather than buried in a dropdown.
 *
 * Coverage strategy: this catalog focuses on the common "Ordinary" question
 * types (the ones a typical seeker uses). Game-mode-specific variants like
 * "thames-path" or "highspeed-measure-shinkansen" still work via the
 * configure-dialog dropdown — they just won't appear as their own tile in
 * step 2. Power users can always change to those from the dropdown.
 */
export interface SubtypeMeta {
    /** The schema literal value, e.g. "airport" or "aquarium-full". */
    value: string;
    /** Display label shown on the tile. */
    label: string;
    /** Lucide icon for the tile. */
    icon: LucideIcon;
    /** One-line description shown under the label on each tile. */
    description?: string;
}

/** Map: category id → ordered list of subtypes shown in the step-2 picker. */
export const SUBTYPES: Record<
    "matching" | "measuring" | "tentacles",
    SubtypeMeta[]
> = {
    matching: [
        {
            value: "airport",
            label: "Airport",
            icon: Plane,
            description: "Same commercial airport in zone.",
        },
        {
            value: "major-city",
            label: "Major city",
            icon: Building2,
            description: "Same major city (1M+) in zone.",
        },
        {
            value: "aquarium-full",
            label: "Aquarium",
            icon: Fish,
            description: "Same aquarium (Small+Medium).",
        },
        {
            value: "zoo-full",
            label: "Zoo",
            icon: TentTree,
            description: "Same zoo (Small+Medium).",
        },
        {
            value: "theme_park-full",
            label: "Theme park",
            icon: Rocket,
            description: "Same theme park (Small+Medium).",
        },
        {
            value: "peak-full",
            label: "Mountain",
            icon: Mountain,
            description: "Same mountain (Small+Medium).",
        },
        {
            value: "museum-full",
            label: "Museum",
            icon: Landmark,
            description: "Same museum (Small+Medium).",
        },
        {
            value: "hospital-full",
            label: "Hospital",
            icon: Hospital,
            description: "Same hospital (Small+Medium).",
        },
    ],
    measuring: [
        {
            value: "coastline",
            label: "Coastline",
            icon: Waves,
            description: "Closer or further to the coast?",
        },
        {
            value: "airport",
            label: "Airport",
            icon: Plane,
            description: "Closer or further to an airport?",
        },
        {
            value: "city",
            label: "Major city",
            icon: Building2,
            description: "Closer or further to a major city?",
        },
        {
            value: "aquarium-full",
            label: "Aquarium",
            icon: Fish,
            description: "Closer to an aquarium?",
        },
        {
            value: "zoo-full",
            label: "Zoo",
            icon: TentTree,
            description: "Closer to a zoo?",
        },
        {
            value: "theme_park-full",
            label: "Theme park",
            icon: Rocket,
            description: "Closer to a theme park?",
        },
        {
            value: "peak-full",
            label: "Mountain",
            icon: Mountain,
            description: "Closer to a mountain peak?",
        },
        {
            value: "museum-full",
            label: "Museum",
            icon: Landmark,
            description: "Closer to a museum?",
        },
        {
            value: "hospital-full",
            label: "Hospital",
            icon: Hospital,
            description: "Closer to a hospital?",
        },
    ],
    tentacles: [
        {
            value: "aquarium",
            label: "Aquarium",
            icon: Fish,
            description: "Closest aquarium within range.",
        },
        {
            value: "zoo",
            label: "Zoo",
            icon: TentTree,
            description: "Closest zoo within range.",
        },
        {
            value: "museum",
            label: "Museum",
            icon: Landmark,
            description: "Closest museum within range.",
        },
        {
            value: "hospital",
            label: "Hospital",
            icon: Hospital,
            description: "Closest hospital within range.",
        },
        {
            value: "theme_park",
            label: "Theme park",
            icon: Rocket,
            description: "Closest theme park within range.",
        },
        {
            value: "cinema",
            label: "Cinema",
            icon: Film,
            description: "Closest movie theater within range.",
        },
        {
            value: "library",
            label: "Library",
            icon: Library,
            description: "Closest library within range.",
        },
        {
            value: "golf_course",
            label: "Golf course",
            icon: Flag,
            description: "Closest golf course within range.",
        },
        {
            value: "park",
            label: "Park",
            icon: Trees,
            description: "Closest park within range.",
        },
        {
            value: "peak",
            label: "Mountain",
            icon: Mountain,
            description: "Closest peak within range.",
        },
    ],
};

/**
 * Lookup an ordered list by category id. Returns null for categories that
 * don't have a step-2 picker (radius, thermometer).
 */
export function getSubtypes(categoryId: string): SubtypeMeta[] | null {
    if (
        categoryId === "matching" ||
        categoryId === "measuring" ||
        categoryId === "tentacles"
    ) {
        return SUBTYPES[categoryId];
    }
    return null;
}
