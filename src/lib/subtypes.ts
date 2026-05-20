import {
    Building2,
    Film,
    Fish,
    Flag,
    Hospital,
    Landmark,
    Library,
    Mountain,
    Plane,
    Rocket,
    TentTree,
    Trees,
    Waves,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { GameSize } from "./gameSetup";

/**
 * Metadata for question-subtype selection in the step-2 picker. Per the
 * rulebook, "-full" suffixed variants are aggregated Small+Medium-only
 * questions; in Large games they're unavailable (the entity counts get
 * unmanageable). `validSizes` lets the picker filter accordingly.
 */
export interface SubtypeMeta {
    value: string;
    label: string;
    icon: LucideIcon;
    description?: string;
    validSizes: GameSize[];
}

const ALL: GameSize[] = ["small", "medium", "large"];
const SM: GameSize[] = ["small", "medium"];

export const SUBTYPES: Record<
    "matching" | "measuring" | "tentacles",
    SubtypeMeta[]
> = {
    matching: [
        { value: "airport", label: "Airport", icon: Plane, description: "Same commercial airport in zone.", validSizes: ALL },
        { value: "major-city", label: "Major city", icon: Building2, description: "Same major city (1M+) in zone.", validSizes: ALL },
        { value: "aquarium-full", label: "Aquarium", icon: Fish, description: "Same aquarium.", validSizes: SM },
        { value: "zoo-full", label: "Zoo", icon: TentTree, description: "Same zoo.", validSizes: SM },
        { value: "theme_park-full", label: "Theme park", icon: Rocket, description: "Same theme park.", validSizes: SM },
        { value: "peak-full", label: "Mountain", icon: Mountain, description: "Same mountain.", validSizes: SM },
        { value: "museum-full", label: "Museum", icon: Landmark, description: "Same museum.", validSizes: SM },
        { value: "hospital-full", label: "Hospital", icon: Hospital, description: "Same hospital.", validSizes: SM },
    ],
    measuring: [
        { value: "coastline", label: "Coastline", icon: Waves, description: "Closer or further to the coast?", validSizes: ALL },
        { value: "airport", label: "Airport", icon: Plane, description: "Closer or further to an airport?", validSizes: ALL },
        { value: "city", label: "Major city", icon: Building2, description: "Closer or further to a major city?", validSizes: ALL },
        { value: "aquarium-full", label: "Aquarium", icon: Fish, description: "Closer to an aquarium?", validSizes: SM },
        { value: "zoo-full", label: "Zoo", icon: TentTree, description: "Closer to a zoo?", validSizes: SM },
        { value: "theme_park-full", label: "Theme park", icon: Rocket, description: "Closer to a theme park?", validSizes: SM },
        { value: "peak-full", label: "Mountain", icon: Mountain, description: "Closer to a mountain?", validSizes: SM },
        { value: "museum-full", label: "Museum", icon: Landmark, description: "Closer to a museum?", validSizes: SM },
        { value: "hospital-full", label: "Hospital", icon: Hospital, description: "Closer to a hospital?", validSizes: SM },
    ],
    tentacles: [
        { value: "aquarium", label: "Aquarium", icon: Fish, description: "Closest aquarium within range.", validSizes: ALL },
        { value: "zoo", label: "Zoo", icon: TentTree, description: "Closest zoo within range.", validSizes: ALL },
        { value: "museum", label: "Museum", icon: Landmark, description: "Closest museum within range.", validSizes: ALL },
        { value: "hospital", label: "Hospital", icon: Hospital, description: "Closest hospital within range.", validSizes: ALL },
        { value: "theme_park", label: "Theme park", icon: Rocket, description: "Closest theme park within range.", validSizes: ALL },
        { value: "cinema", label: "Cinema", icon: Film, description: "Closest movie theater within range.", validSizes: ALL },
        { value: "library", label: "Library", icon: Library, description: "Closest library within range.", validSizes: ALL },
        { value: "golf_course", label: "Golf course", icon: Flag, description: "Closest golf course within range.", validSizes: ALL },
        { value: "park", label: "Park", icon: Trees, description: "Closest park within range.", validSizes: ALL },
        { value: "peak", label: "Mountain", icon: Mountain, description: "Closest peak within range.", validSizes: ALL },
    ],
};

/**
 * Return subtypes valid for the given game size, in display order.
 * Returns null for categories with no step-2 picker.
 */
export function getSubtypes(
    categoryId: string,
    size: GameSize,
): SubtypeMeta[] | null {
    if (
        categoryId === "matching" ||
        categoryId === "measuring" ||
        categoryId === "tentacles"
    ) {
        return SUBTYPES[categoryId].filter((s) => s.validSizes.includes(size));
    }
    return null;
}

/**
 * Whether a given subtype value is allowed in the given game size.
 *
 * - If the subtype is in our catalog: returns true iff its `validSizes`
 *   contains `size`.
 * - If the subtype isn't tracked: returns true (permissive default —
 *   we don't manage size constraints for niche/legacy variants, so we
 *   leave them visible rather than over-hide).
 */
export function isSubtypeAllowed(value: string, size: GameSize): boolean {
    for (const list of Object.values(SUBTYPES)) {
        for (const s of list) {
            if (s.value === value) return s.validSizes.includes(size);
        }
    }
    return true;
}

/**
 * Strip schema-description instructional suffixes for clean display.
 * Removes " Question" trailing marker and any " (X Games)" annotation.
 */
export function cleanDescription(desc: string | undefined): string {
    return (desc ?? "")
        .replace(/\s*\([^)]*\b[Gg]ames?\)\s*$/, "")
        .replace(/ Question$/, "")
        .trim();
}
