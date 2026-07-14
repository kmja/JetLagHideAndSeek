import type { LucideIcon } from "lucide-react";
import {
    Anchor,
    Beef,
    BookOpen,
    Building,
    Building2,
    ChevronsLeftRightEllipsis,
    Church,
    Cloud,
    Compass,
    FerrisWheel,
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
    PawPrint,
    Plane,
    Route,
    Sailboat,
    ShoppingBag,
    ShoppingBasket,
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
 * Metadata for question-subtype selection in the step-2 picker.
 * `validSizes` lets the picker filter by game size where the RULEBOOK
 * itself gates a category (Thermometer, Photo, Tentacle). Matching and
 * Measuring have NO size gating in the rulebook — all 20 of each are
 * available at every size (v670: the earlier Small+Medium-only cap on
 * the "-full" POI variants was an app deviation, now lifted for full
 * rulebook parity; a Large game may surface many reference instances,
 * which the Voronoi/nearest pipeline handles).
 */
export interface SubtypeMeta {
    value: string;
    label: string;
    icon: LucideIcon;
    description?: string;
    validSizes: GameSize[];
}

const ALL: GameSize[] = ["small", "medium", "large"];

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
     * The picker mirrors the rulebook EXACTLY — no more, no less. Note
     * `same-first-letter-station` is deliberately NOT offered: it's not a
     * rulebook question (the rulebook only has "Station Name's Length").
     * Its elimination is still implemented (matching.ts) so a save-game /
     * share-link using it grades app-side rather than falling back to the
     * hider, but it isn't a selectable tile. */
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
        { value: "peak-full", label: "Mountain", icon: Mountain, description: "Same mountain.", validSizes: ALL },
        { value: "same-landmass", label: "Landmass", icon: Globe, description: "Same contiguous landmass (not broken by waterways).", validSizes: ALL },
        { value: "park-full", label: "Park", icon: Trees, description: "Same park (measured to the map icon).", validSizes: ALL },
        // Places of Interest
        { value: "theme_park-full", label: "Amusement park", icon: FerrisWheel, description: "Same amusement park.", validSizes: ALL },
        { value: "zoo-full", label: "Zoo", icon: PawPrint, description: "Same zoo.", validSizes: ALL },
        { value: "aquarium-full", label: "Aquarium", icon: Fish, description: "Same aquarium.", validSizes: ALL },
        { value: "golf_course-full", label: "Golf course", icon: Flag, description: "Same outdoor golf course (mini-golf and driving ranges don't count).", validSizes: ALL },
        { value: "museum-full", label: "Museum", icon: Landmark, description: "Same museum.", validSizes: ALL },
        { value: "cinema-full", label: "Movie theater", icon: Film, description: "Same movie theater.", validSizes: ALL },
        // Public Utilities
        { value: "hospital-full", label: "Hospital", icon: Hospital, description: "Same hospital.", validSizes: ALL },
        { value: "library-full", label: "Library", icon: Library, description: "Same library.", validSizes: ALL },
        { value: "consulate-full", label: "Foreign consulate", icon: BookOpen, description: "Same foreign consulate (excludes honorary consulates).", validSizes: ALL },
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
        { value: "peak-full", label: "Mountain", icon: Mountain, description: "Closer or further to a mountain?", validSizes: ALL },
        { value: "park-full", label: "Park", icon: Trees, description: "Closer or further to a park (measured to the icon)?", validSizes: ALL },
        // Places of Interest
        { value: "theme_park-full", label: "Amusement park", icon: FerrisWheel, description: "Closer or further to an amusement park?", validSizes: ALL },
        { value: "zoo-full", label: "Zoo", icon: PawPrint, description: "Closer to a zoo?", validSizes: ALL },
        { value: "aquarium-full", label: "Aquarium", icon: Fish, description: "Closer to an aquarium?", validSizes: ALL },
        { value: "golf_course-full", label: "Golf course", icon: Flag, description: "Closer to an outdoor golf course?", validSizes: ALL },
        { value: "museum-full", label: "Museum", icon: Landmark, description: "Closer to a museum?", validSizes: ALL },
        { value: "cinema-full", label: "Movie theater", icon: Film, description: "Closer to a movie theater?", validSizes: ALL },
        // Public Utilities
        { value: "hospital-full", label: "Hospital", icon: Hospital, description: "Closer to a hospital?", validSizes: ALL },
        { value: "library-full", label: "Library", icon: Library, description: "Closer to a library?", validSizes: ALL },
        { value: "consulate-full", label: "Foreign consulate", icon: BookOpen, description: "Closer to a foreign consulate (excludes honorary)?", validSizes: ALL },
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
        { value: "zoo", label: "Zoo", icon: PawPrint, description: "Closest zoo within 25 km.", validSizes: L },
        { value: "aquarium", label: "Aquarium", icon: Fish, description: "Closest aquarium within 25 km.", validSizes: L },
        { value: "theme_park", label: "Amusement park", icon: FerrisWheel, description: "Closest amusement park within 25 km.", validSizes: L },
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
 * Find a subtype meta by its `value` across every category. v371: used
 * by the configure-dialog impact preview to render each candidate
 * point with the subtype's Lucide icon (museum→Landmark, park→Trees,
 * …) instead of a generic dot. Categories are mutually-exclusive on
 * subtype values, so the first match is the right one.
 */
export function findSubtypeMeta(value: string): SubtypeMeta | null {
    for (const list of Object.values(SUBTYPES)) {
        const hit = list.find((s) => s.value === value);
        if (hit) return hit;
    }
    return null;
}

/**
 * Legacy / non-picker subtype values that still appear in saved games,
 * share links, or the elimination engine but aren't selectable tiles in
 * `SUBTYPES`. Their icons are kept in agreement with the nearest picker
 * equivalent so the header card and the map markers never disagree.
 * Bare forms that DO resolve through `findSubtypeMeta` (e.g. tentacle
 * `zoo`, photo `selfie`) are intentionally omitted — they resolve there.
 */
const LEGACY_SUBTYPE_ICONS: Record<string, LucideIcon> = {
    city: Building2,
    "major-city": Building2,
    mcdonalds: Beef,
    seven11: ShoppingBag,
    // bare "rail-measure" predates "rail-measure-ordinary"
    "rail-measure": TrainTrack,
    // bare "peak" predates "peak-full"
    peak: Mountain,
};

/**
 * THE single source of truth for a question subtype's icon — used by
 * BOTH the on-map markers (`InlineLocationPicker`) and the question
 * header card (`QuestionOverlayCard`) so every question has exactly one
 * icon shown everywhere. Resolves in order: exact `SUBTYPES` value →
 * the `-full`-stripped value → the legacy table above. Returns null when
 * nothing matches (caller falls back to the category icon).
 */
export function iconForSubtype(value: string | undefined): LucideIcon | null {
    if (!value) return null;
    const direct = findSubtypeMeta(value);
    if (direct) return direct.icon;
    const stripped = value.endsWith("-full")
        ? value.slice(0, -"-full".length)
        : value;
    if (stripped !== value) {
        const strippedMeta = findSubtypeMeta(stripped);
        if (strippedMeta) return strippedMeta.icon;
    }
    return LEGACY_SUBTYPE_ICONS[stripped] ?? null;
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
