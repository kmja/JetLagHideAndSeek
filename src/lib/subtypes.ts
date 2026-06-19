import type { LucideIcon } from "lucide-react";
import {
    Anchor,
    BookOpen,
    Building,
    Building2,
    ChevronsLeftRightEllipsis,
    Church,
    Cloud,
    Compass,
    Film,
    Fish,
    Flag,
    Footprints,
    Globe,
    Hospital,
    Landmark,
    Languages,
    Library,
    Map as MapLucide,
    Milestone,
    Mountain,
    Plane,
    Rocket,
    Route,
    Sailboat,
    ShoppingBasket,
    TentTree,
    Train,
    TrainFront,
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
    /* Matching — rulebook p17-19. v339 catalogue brought into full
     * agreement with the rulebook: Transit (airport, transit line,
     * station name length, street or path), Administrative Divisions
     * (1-4), Natural (mountain, landmass, park), Places of Interest
     * (amusement park, zoo, aquarium, golf course, museum, movie
     * theater), Public Utilities (hospital, library, foreign consulate).
     * "Major city" is kept as a useful pre-rulebook extension. */
    matching: [
        // Transit
        { value: "airport", label: "Airport", icon: Plane, description: "Same commercial airport in zone.", validSizes: ALL },
        { value: "same-train-line", label: "Transit line", icon: Train, description: "Hider's station is on the line you're currently riding.", validSizes: ALL },
        { value: "same-length-station", label: "Station name length", icon: Languages, description: "Same number of characters in your nearest station's name.", validSizes: ALL },
        { value: "same-street-or-path", label: "Street or path", icon: Footprints, description: "Hider is on the same named street or path as you.", validSizes: ALL },
        // Administrative Divisions (1st-4th, rulebook p18). Each
        // picker tile commits a `zone` matching question with a
        // pre-filled `cat.adminLevel` (mapped from rulebook tier to
        // OSM admin_level by AddQuestionDialog's runAddMatching). The
        // seeker can still override the level in the configure card
        // — admin_level mapping varies by country and the dropdown
        // is the escape hatch for the unusual cases (Tokyo wards,
        // Zurich Kreise, etc.). Picker shortcuts cover the common
        // tier mapping (1→4, 2→6, 3→8, 4→9).
        { value: "admin-1", label: "1st admin division", icon: MapLucide, description: "Same state / canton / prefecture (largest formal division).", validSizes: ALL },
        { value: "admin-2", label: "2nd admin division", icon: MapLucide, description: "Same county / district / subprefecture.", validSizes: ALL },
        { value: "admin-3", label: "3rd admin division", icon: MapLucide, description: "Same municipality.", validSizes: ALL },
        { value: "admin-4", label: "4th admin division", icon: MapLucide, description: "Same borough / ward / inner-city district (not all areas have one).", validSizes: ALL },
        // Natural
        { value: "peak-full", label: "Mountain", icon: Mountain, description: "Same mountain.", validSizes: SM },
        { value: "same-landmass", label: "Landmass", icon: Globe, description: "Same contiguous landmass (not broken by waterways).", validSizes: ALL },
        { value: "park-full", label: "Park", icon: Trees, description: "Same park (measured to the map icon).", validSizes: SM },
        // Places of Interest
        { value: "theme_park-full", label: "Amusement park", icon: Rocket, description: "Same amusement park.", validSizes: SM },
        { value: "zoo-full", label: "Zoo", icon: TentTree, description: "Same zoo.", validSizes: SM },
        { value: "aquarium-full", label: "Aquarium", icon: Fish, description: "Same aquarium.", validSizes: SM },
        { value: "golf_course-full", label: "Golf course", icon: Flag, description: "Same outdoor golf course (mini-golf and driving ranges don't count).", validSizes: SM },
        { value: "museum-full", label: "Museum", icon: Landmark, description: "Same museum.", validSizes: SM },
        { value: "cinema-full", label: "Movie theater", icon: Film, description: "Same movie theater.", validSizes: SM },
        // Public Utilities
        { value: "hospital-full", label: "Hospital", icon: Hospital, description: "Same hospital.", validSizes: SM },
        { value: "library-full", label: "Library", icon: Library, description: "Same library.", validSizes: SM },
        { value: "consulate-full", label: "Foreign consulate", icon: BookOpen, description: "Same foreign consulate (excludes honorary consulates).", validSizes: SM },
    ],
    /* Measuring — rulebook p23-26. Transit-Related, Borders, Natural,
     * Places of Interest, Public Utilities. */
    measuring: [
        // Transit-Related
        { value: "airport", label: "Airport", icon: Plane, description: "Closer or further to an airport?", validSizes: ALL },
        { value: "highspeed-measure-shinkansen", label: "High-speed train line", icon: TrainFront, description: "Closer or further to a high-speed line? (EU: 250 km/h purpose-built, ~200 km/h upgraded.)", validSizes: ALL },
        { value: "rail-measure-ordinary", label: "Rail station", icon: TrainTrack, description: "Closer or further to any rail station? (Includes metros / subways.)", validSizes: ALL },
        // Borders
        { value: "international-border", label: "International border", icon: Globe, description: "Closer or further to a country border? (Enclaves count.)", validSizes: ALL },
        { value: "admin1-border", label: "1st admin div. border", icon: Milestone, description: "Closer or further to a state / canton / prefecture border?", validSizes: ALL },
        { value: "admin2-border", label: "2nd admin div. border", icon: Milestone, description: "Closer or further to a county / district border?", validSizes: ALL },
        // Natural
        { value: "sea-level", label: "Sea level (altitude)", icon: Compass, description: "Higher or lower altitude? (Phone compass — sometimes inaccurate.)", validSizes: ALL },
        { value: "body-of-water", label: "Body of water", icon: Sailboat, description: "Closer or further to any named body of water (no pools)?", validSizes: ALL },
        { value: "coastline", label: "Coastline", icon: Anchor, description: "Closer or further to the coast? (Straits under 2 km don't count.)", validSizes: ALL },
        { value: "peak-full", label: "Mountain", icon: Mountain, description: "Closer or further to a mountain?", validSizes: SM },
        { value: "park-full", label: "Park", icon: Trees, description: "Closer or further to a park (measured to the icon)?", validSizes: SM },
        // Places of Interest
        { value: "theme_park-full", label: "Amusement park", icon: Rocket, description: "Closer or further to an amusement park?", validSizes: SM },
        { value: "zoo-full", label: "Zoo", icon: TentTree, description: "Closer to a zoo?", validSizes: SM },
        { value: "aquarium-full", label: "Aquarium", icon: Fish, description: "Closer to an aquarium?", validSizes: SM },
        { value: "golf_course-full", label: "Golf course", icon: Flag, description: "Closer to an outdoor golf course?", validSizes: SM },
        { value: "museum-full", label: "Museum", icon: Landmark, description: "Closer to a museum?", validSizes: SM },
        { value: "cinema-full", label: "Movie theater", icon: Film, description: "Closer to a movie theater?", validSizes: SM },
        // Public Utilities
        { value: "hospital-full", label: "Hospital", icon: Hospital, description: "Closer to a hospital?", validSizes: SM },
        { value: "library-full", label: "Library", icon: Library, description: "Closer to a library?", validSizes: SM },
        { value: "consulate-full", label: "Foreign consulate", icon: BookOpen, description: "Closer to a foreign consulate (excludes honorary)?", validSizes: SM },
    ],
    /* Tentacles — rulebook p37-38. Cannot be used in Small games (per
     * SubtypeMeta.validSizes). Medium = 2 km presets, Large adds the
     * 25 km tier including Metro Lines. The radius is enforced by the
     * picker / configure UI, not here. */
    tentacles: [
        // Medium + Large — 2 km tier
        { value: "museum", label: "Museum", icon: Landmark, description: "Closest museum within 2 km.", validSizes: ML },
        { value: "library", label: "Library", icon: Library, description: "Closest library within 2 km.", validSizes: ML },
        { value: "cinema", label: "Movie theater", icon: Film, description: "Closest movie theater within 2 km.", validSizes: ML },
        { value: "hospital", label: "Hospital", icon: Hospital, description: "Closest hospital within 2 km.", validSizes: ML },
        // Large — 25 km tier including Metro Lines (rulebook p38).
        // v343: metro now has its own schema variant + data path
        // (representative-point-per-route fed into the Voronoi
        // pipeline), so it's safe to surface here.
        { value: "metro", label: "Metro line", icon: TrainTrack, description: "Closest metro line within 25 km.", validSizes: L },
        { value: "zoo", label: "Zoo", icon: TentTree, description: "Closest zoo within 25 km.", validSizes: L },
        { value: "aquarium", label: "Aquarium", icon: Fish, description: "Closest aquarium within 25 km.", validSizes: L },
        { value: "theme_park", label: "Amusement park", icon: Rocket, description: "Closest amusement park within 25 km.", validSizes: L },
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
