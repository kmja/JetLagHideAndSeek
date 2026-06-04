import type { LucideIcon } from "lucide-react";
import {
    Building,
    Building2,
    ChevronsLeftRightEllipsis,
    Church,
    Cloud,
    Film,
    Fish,
    Flag,
    Hospital,
    Landmark,
    Library,
    Map as MapLucide,
    Mountain,
    Plane,
    Rocket,
    Route,
    ShoppingBasket,
    TentTree,
    TrainTrack,
    TreePine,
    Trees,
    User,
    Utensils,
    Waves,
} from "lucide-react";

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

const ML: GameSize[] = ["medium", "large"];
const L: GameSize[] = ["large"];

export const SUBTYPES: Record<
    "matching" | "measuring" | "tentacles" | "photo",
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
    /* Photo subtypes — rulebook pp32–35. Validity scales with game size:
     *   S/M/L  — base set (building visible, widest street, tree, sky, you, tallest in sightline)
     *   M/L    — adds tallest building from station, traced street, 2 buildings, restaurant interior, etc.
     *   L only — adds 1km traced streets, tallest mountain, biggest body of water, 5 buildings */
    photo: [
        { value: "any-building-from-station", label: "Any building from station", icon: Building2, description: "A building visible from a transit station entrance.", validSizes: ALL },
        { value: "widest-street", label: "Widest street", icon: ChevronsLeftRightEllipsis, description: "Both sides of the street; background can be anything.", validSizes: ALL },
        { value: "tree", label: "Tree", icon: TreePine, description: "Must include the entire tree.", validSizes: ALL },
        { value: "tallest-in-sightline", label: "Tallest in sightline", icon: Building, description: "Tallest building from your current perspective.", validSizes: ALL },
        { value: "selfie", label: "You", icon: User, description: "Selfie mode, default lens, arm fully extended.", validSizes: ALL },
        { value: "sky", label: "The sky", icon: Cloud, description: "Phone on ground, shoot directly up.", validSizes: ALL },
        { value: "tallest-building-from-station", label: "Tallest building from station", icon: Building, description: "Tallest building from your transit station's perspective.", validSizes: ML },
        { value: "trace-nearest-street", label: "Trace nearest street", icon: Route, description: "Sketch the nearest intersection on the map app.", validSizes: ML },
        { value: "two-buildings", label: "2 buildings", icon: Building2, description: "Both buildings bottom-to-roof, up to four stories.", validSizes: ML },
        { value: "restaurant-interior", label: "Restaurant interior", icon: Utensils, description: "Shot from outside through the window.", validSizes: ML },
        { value: "park", label: "Park", icon: Trees, description: "Phone perpendicular to ground, 2m from any obstruction.", validSizes: ML },
        { value: "grocery-aisle", label: "Grocery store aisle", icon: ShoppingBasket, description: "Stand at the end of the aisle, shoot down.", validSizes: ML },
        { value: "place-of-worship", label: "Place of worship", icon: Church, description: "2m × 2m section with three distinct elements.", validSizes: ML },
        { value: "train-platform", label: "Train platform", icon: TrainTrack, description: "2m × 2m section with three distinct elements.", validSizes: ML },
        { value: "1km-streets-traced", label: "1 km of streets traced", icon: MapLucide, description: "Continuous trace, 5 turns, no doubling back.", validSizes: L },
        { value: "tallest-mountain-from-station", label: "Tallest mountain from station", icon: Mountain, description: "Tallest mountain from your station's sightline.", validSizes: L },
        { value: "biggest-water-in-zone", label: "Biggest body of water in your zone", icon: Waves, description: "Both sides of the water or the horizon must be visible.", validSizes: L },
        { value: "five-buildings", label: "5 buildings", icon: Building2, description: "All five buildings bottom-to-roof, up to four stories.", validSizes: L },
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
        categoryId === "tentacles" ||
        categoryId === "photo"
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
