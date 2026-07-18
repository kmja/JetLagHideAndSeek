import { z } from "zod";

import { defaultUnit } from "@/lib/context";

import { ICON_COLORS } from "./api/constants";

export const NO_GROUP = "NO_GROUP";

export const determineUnionizedStrings = (
    obj: z.ZodUnion<any> | z.ZodLiteral<any> | z.ZodDefault<any>,
): z.ZodLiteral<any>[] => {
    if (obj instanceof z.ZodUnion) {
        return obj.options.flatMap((option: any) =>
            determineUnionizedStrings(option),
        );
    } else if (obj instanceof z.ZodLiteral) {
        return [obj];
    } else if (obj instanceof z.ZodDefault) {
        return determineUnionizedStrings(obj._def.innerType);
    }
    return [];
};

const unitsSchema = z.union([
    z.literal("miles"),
    z.literal("kilometers"),
    z.literal("meters"),
]);

const iconColorSchema = z.union([
    z.literal("green"),
    z.literal("black"),
    z.literal("blue"),
    z.literal("gold"),
    z.literal("grey"),
    z.literal("orange"),
    z.literal("red"),
    z.literal("violet"),
]);

type IconColor = z.infer<typeof iconColorSchema>;

const randomColor = () =>
    (Object.keys(ICON_COLORS) as IconColor[])[
        Math.floor(Math.random() * Object.keys(ICON_COLORS).length)
    ];

const randomColorExcluding = (excluded: IconColor[] = []) => {
    const options = (Object.keys(ICON_COLORS) as IconColor[]).filter(
        (color) => !excluded.includes(color),
    );

    return options[Math.floor(Math.random() * options.length)];
};

const thermometerQuestionSchema = z
    .object({
        latA: z
            .number()
            .min(-90, "Latitude must not overlap with the poles")
            .max(90, "Latitude must not overlap with the poles"),
        lngA: z
            .number()
            .min(-180, "Longitude must not overlap with the antemeridian")
            .max(180, "Longitude must not overlap with the antemeridian"),
        latB: z
            .number()
            .min(-90, "Latitude must not overlap with the poles")
            .max(90, "Latitude must not overlap with the poles"),
        lngB: z
            .number()
            .min(-180, "Longitude must not overlap with the antemeridian")
            .max(180, "Longitude must not overlap with the antemeridian"),
        warmer: z.boolean().default(true),
        colorA: iconColorSchema.default(() => randomColorExcluding(["green"])),
        colorB: iconColorSchema.default(() => randomColorExcluding(["green"])),
        /** Note that drag is now synonymous with unlocked */
        drag: z.boolean().default(true),
        collapsed: z.boolean().default(true),
        /** Unix ms timestamp of when this question was created. */
        createdAt: z.number().optional(),
        /**
         * Where the thermometer is in its lifecycle:
         *   - "started": latA/lngA are captured but the seeker hasn't
         *     finished moving yet. latB/lngB mirror latA/lngA until finish.
         *   - "finished": both endpoints set, ready to share with hider.
         *
         * Optional so existing saved questions (created before this field
         * existed) keep parsing as finished, which is what they actually
         * were.
         */
        status: z.enum(["started", "finished"]).optional().default("finished"),
        /**
         * The thermometer distance preset used when finishing, e.g. "500m"
         * or "5km". Tracked for cross-question uniqueness — you can't
         * finish two thermometers at the same preset in one game.
         */
        distance: z.string().optional(),
        /** Unix ms timestamp when the thermometer was started (latA/lngA captured). */
        startedAt: z.number().optional(),
        /**
         * v339: target distance preset the seeker chose UP FRONT, e.g.
         * "5km". Set at start (before the seeker moves) and used by the
         * overlay to drive a single-target progress UI. Distinct from
         * `distance` which is only stamped at finish — typically equal,
         * unless the seeker overshoots and finishes at the same target
         * anyway. Optional for backward compat with v338-era thermometers
         * that didn't have a target picker.
         */
        targetSig: z.string().optional(),
        /** Veto / Randomize markers — see ordinaryBaseQuestionSchema. */
        vetoed: z.boolean().optional(),
        randomized: z.boolean().optional(),
        randomizedFrom: z.string().optional(),
    })
    .transform((question) => {
        if (question.colorA === question.colorB) {
            question.colorB = "green";
        }

        return question;
    });

const ordinaryBaseQuestionSchema = z.object({
    lat: z
        .number()
        .min(-90, "Latitude must not overlap with the poles")
        .max(90, "Latitude must not overlap with the poles"),
    lng: z
        .number()
        .min(-180, "Longitude must not overlap with the antemeridian")
        .max(180, "Longitude must not overlap with the antemeridian"),
    /** Note that drag is now synonymous with unlocked */
    drag: z.boolean().default(true),
    color: iconColorSchema.default(randomColor),
    collapsed: z.boolean().default(true),
    /** Unix ms timestamp of when this question was created. Optional so older saved questions still parse. */
    createdAt: z.number().optional(),
    /** Hider played the Veto card (rulebook p65): no answer, no reward,
     *  and the seeker eliminates nothing from this question. */
    vetoed: z.boolean().optional(),
    /** Hider played the Randomize card: this question's subtype was
     *  swapped to a random un-asked one of the same category and
     *  auto-answered. `randomizedFrom` keeps the original subtype label
     *  for the log. */
    randomized: z.boolean().optional(),
    randomizedFrom: z.string().optional(),
    /** Seeker-side randomize SPLIT (v597): the ORIGINAL question, kept as
     *  asked but redirected away by Randomize — it carries no answer and
     *  eliminates nothing. The auto-answered substitute is a separate
     *  question (see `substituteFor`). */
    randomizedAway: z.boolean().optional(),
    /** Seeker-side randomize SPLIT: on the SUBSTITUTE question, the label
     *  of the original question it stands in for. */
    substituteFor: z.string().optional(),
});

const getDefaultUnit = () => {
    try {
        return defaultUnit.get();
    } catch {
        return "miles";
    }
};

const radiusQuestionSchema = ordinaryBaseQuestionSchema.extend({
    radius: z.number().min(0, "You cannot have a negative radius").default(50),
    unit: unitsSchema.default(getDefaultUnit),
    within: z.boolean().default(true),
    /** Whether the user picked Custom mode rather than a fixed preset. Optional for backward compat. */
    useCustom: z.boolean().optional(),
});

const tentacleLocationsFifteen = z.union([
    z.literal("theme_park").describe("Theme Parks"),
    z.literal("zoo").describe("Zoos"),
    z.literal("aquarium").describe("Aquariums"),
]);
// v343: rulebook p38 — "Metro Lines Within 25 km" (Large only). Metro
// lines don't fit the POI-point pipeline the other tentacle types use
// (route=subway relations carry LINES, not points), so they get their
// own variant below + dedicated data path in tentacles.ts. The
// representative-point-per-route mapping makes them Voronoi-compatible
// without a true line-Voronoi.
const tentacleLocationsMetro = z.literal("metro").describe("Metro Lines");

const tentacleLocationsOne = z.union([
    z.literal("museum").describe("Museums"),
    z.literal("hospital").describe("Hospitals"),
    z.literal("cinema").describe("Movie Theaters"),
    z.literal("library").describe("Libraries"),
]);

const apiLocationSchema = z.union([
    z.literal("golf_course"),
    z.literal("consulate"),
    z.literal("park"),
    z.literal("peak"),
    tentacleLocationsFifteen,
    tentacleLocationsOne,
]);

const baseTentacleQuestionSchema = ordinaryBaseQuestionSchema.extend({
    radius: z.number().min(0, "You cannot have a negative radius").default(15),
    unit: unitsSchema.default(getDefaultUnit),
    location: z
        .union([
            z.object({
                type: z.literal("Feature"),
                geometry: z.object({
                    type: z.literal("Point"),
                    coordinates: z.array(z.number()),
                }),
                id: z.union([z.string(), z.number(), z.undefined()]).optional(),
                properties: z.object({
                    name: z.any(),
                }),
            }),
            z.literal(false),
        ])
        .default(false),
});
const tentacleQuestionSpecificSchemaFifteen = baseTentacleQuestionSchema.extend(
    {
        locationType: tentacleLocationsFifteen.default("theme_park"),
        places: z.array(z.any()).optional(),
    },
);

const tentacleQuestionSpecificSchemaOne = baseTentacleQuestionSchema.extend({
    locationType: tentacleLocationsOne,
    places: z.array(z.any()).optional(),
});

// v343: dedicated metro-tentacle variant (rulebook p38, Large only).
// Same shape as the other tentacle schemas; the differentiator is
// `locationType: "metro"`, which routes the data fetch to the
// representative-points-per-route helper instead of POI fetch.
const tentacleQuestionSpecificSchemaMetro =
    baseTentacleQuestionSchema.extend({
        locationType: tentacleLocationsMetro,
        places: z.array(z.any()).optional(),
    });

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const encompassingTentacleQuestionSchema = baseTentacleQuestionSchema.extend({
    locationType: apiLocationSchema,
    places: z.array(z.any()).optional(),
});

const customTentacleQuestionSchema = baseTentacleQuestionSchema.extend({
    locationType: z.literal("custom").describe("Custom Locations"),
    places: z.array(
        z.object({
            type: z.literal("Feature"),
            geometry: z.object({
                type: z.literal("Point"),
                coordinates: z.array(z.number()),
            }),
            id: z.union([z.string(), z.number(), z.undefined()]).optional(),
            properties: z.object({
                name: z.any(),
            }),
        }),
    ),
});

export const tentacleQuestionSchema = z.union([
    customTentacleQuestionSchema.describe(NO_GROUP),
    tentacleQuestionSpecificSchemaFifteen.describe("15 Miles (Typically)"),
    tentacleQuestionSpecificSchemaOne.describe("1 Mile (Typically)"),
    tentacleQuestionSpecificSchemaMetro.describe("25 km (Metro Lines)"),
]);

const baseMatchingQuestionSchema = ordinaryBaseQuestionSchema.extend({
    same: z.boolean().default(true),
    lengthComparison: z.enum(["shorter", "longer", "same"]).optional(),
    /**
     * v966: the transit ROUTE the seekers are currently riding, for the
     * `same-train-line` question. Per the rulebook the answer is "yes if the
     * transit the seekers are currently riding would stop at the hider's
     * station" — so the seeker PICKS the route they're on (it can't be auto-
     * detected), and its stops are baked in here. `stops` drives both the
     * elimination (keep/cut zones whose station is one of these stops) and the
     * hider's auto-grade; `geometry` (a flattened [lng,lat] line) draws the
     * route on the preview. Declared on the base schema so it survives the
     * wire (Zod strips undeclared keys) even though only same-train-line
     * populates it. Optional — absent on every other matching type.
     */
    transitRoute: z
        .object({
            id: z.string(),
            name: z.string(),
            ref: z.string().optional(),
            mode: z.string(),
            stops: z.array(
                z.object({
                    lat: z.number(),
                    lng: z.number(),
                    name: z.string().optional(),
                }),
            ),
            geometry: z.array(z.array(z.number())).optional(),
        })
        .optional(),
});

const ordinaryMatchingQuestionSchema = baseMatchingQuestionSchema.extend({
    type: z
        .union([
            z
                .literal("airport")
                .describe("Commercial Airport In Zone Question"),
            z
                .literal("major-city")
                .describe("Major City (1,000,000+ people) In Zone Question"),
            z
                .literal("aquarium-full")
                .describe("Aquarium Question (Small+Medium Games)"),
            z.literal("zoo-full").describe("Zoo Question (Small+Medium Games)"),
            z
                .literal("theme_park-full")
                .describe("Theme Park Question (Small+Medium Games)"),
            z
                .literal("peak-full")
                .describe("Mountain Question (Small+Medium Games)"),
            z
                .literal("museum-full")
                .describe("Museum Question (Small+Medium Games)"),
            z
                .literal("hospital-full")
                .describe("Hospital Question (Small+Medium Games)"),
            z
                .literal("cinema-full")
                .describe("Cinema Question (Small+Medium Games)"),
            z
                .literal("library-full")
                .describe("Library Question (Small+Medium Games)"),
            z
                .literal("golf_course-full")
                .describe("Golf Course Question (Small+Medium Games)"),
            z
                .literal("consulate-full")
                .describe("Foreign Consulate Question (Small+Medium Games)"),
            z
                .literal("park-full")
                .describe("Park Question (Small+Medium Games)"),
        ])
        .default("airport"),
});

const zoneMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("zone").describe("Zone Question"),
        z
            .literal("letter-zone")
            .describe("Zone Starts With Same Letter Question"),
    ]),
    cat: z
        .object({
            adminLevel: z.union([
                z.literal(2),
                z.literal(3),
                z.literal(4),
                z.literal(5),
                z.literal(6),
                z.literal(7),
                z.literal(8),
                z.literal(9),
                z.literal(10),
            ]),
        })
        .default(() => ({ adminLevel: 3 }) as { adminLevel: 3 }),
});

const homeGameMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("aquarium").describe("Aquarium Question"),
        z.literal("zoo").describe("Zoo Question"),
        z.literal("theme_park").describe("Theme Park Question"),
        z.literal("peak").describe("Mountain Question"),
        z.literal("museum").describe("Museum Question"),
        z.literal("hospital").describe("Hospital Question"),
        z.literal("cinema").describe("Cinema Question"),
        z.literal("library").describe("Library Question"),
        z.literal("golf_course").describe("Golf Course Question"),
        z.literal("consulate").describe("Foreign Consulate Question"),
        z.literal("park").describe("Park Question"),
    ]),
});

const hidingZoneMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z
            .literal("same-first-letter-station")
            .describe("Station Starts With Same Letter Question"),
        z
            .literal("same-length-station")
            .describe("Station Name Has Same Length Question"),
        z
            .literal("same-train-line")
            .describe("Station On Same Transit Line Question"),
        // v339: rulebook p18 additions. "Street or Path" and "Landmass"
        // round out the rulebook's Matching catalogue. They share the
        // base shape; the matching engine routes by `type`.
        z
            .literal("same-street-or-path")
            .describe("Same Street Or Path Question"),
        z.literal("same-landmass").describe("Same Landmass Question"),
    ]),
});

const customMatchingQuestionSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("custom-zone").describe("Custom Zone Question"),
        z.literal("custom-points").describe("Custom Points Question"),
    ]),
    geo: z.any(),
});

export const matchingQuestionSchema = z.union([
    zoneMatchingQuestionsSchema.describe(NO_GROUP),
    ordinaryMatchingQuestionSchema.describe(NO_GROUP),
    customMatchingQuestionSchema.describe(NO_GROUP),
    hidingZoneMatchingQuestionsSchema.describe("Hiding Zone Mode"),
    homeGameMatchingQuestionsSchema.describe("Hiding Zone Mode"),
]);

const baseMeasuringQuestionSchema = ordinaryBaseQuestionSchema.extend({
    hiderCloser: z.boolean().default(true),
    /**
     * v346: manual reference-point fallback. When the data path for a
     * measuring question fails (Overpass / elevation down AND not
     * cached), the seeker can tap the map to mark where the reference
     * (nearest airport / station / etc.) actually is. When set, the
     * elimination uses this point directly — the "closer" region is the
     * circle of radius |seeker→ref| around it — bypassing the data
     * fetch entirely. Optional; absent = normal automatic path.
     */
    manualReference: z
        .object({ lat: z.number(), lng: z.number() })
        .optional(),
});

const ordinaryMeasuringQuestionSchema = baseMeasuringQuestionSchema.extend({
    type: z
        .union([
            z.literal("coastline").describe("Coastline Question"),
            z
                .literal("airport")
                .describe("Commercial Airport In Zone Question"),
            z
                .literal("city")
                .describe("Major City (1,000,000+ people) Question"),
            z
                .literal("highspeed-measure-shinkansen")
                .describe("High-Speed Rail Question"),
            z
                .literal("aquarium-full")
                .describe("Aquarium Question (Small+Medium Games)"),
            z.literal("zoo-full").describe("Zoo Question (Small+Medium Games)"),
            z
                .literal("theme_park-full")
                .describe("Theme Park Question (Small+Medium Games)"),
            z
                .literal("peak-full")
                .describe("Mountain Question (Small+Medium Games)"),
            z
                .literal("museum-full")
                .describe("Museum Question (Small+Medium Games)"),
            z
                .literal("hospital-full")
                .describe("Hospital Question (Small+Medium Games)"),
            z
                .literal("cinema-full")
                .describe("Cinema Question (Small+Medium Games)"),
            z
                .literal("library-full")
                .describe("Library Question (Small+Medium Games)"),
            z
                .literal("golf_course-full")
                .describe("Golf Course Question (Small+Medium Games)"),
            z
                .literal("consulate-full")
                .describe("Foreign Consulate Question (Small+Medium Games)"),
            z
                .literal("park-full")
                .describe("Park Question (Small+Medium Games)"),
            // v339: rulebook p23 — additional Measuring categories that
            // were in the rulebook but missing from the schema.
            z.literal("rail-measure-ordinary").describe("Rail Station Question"),
            z
                .literal("international-border")
                .describe("International Border Question"),
            z
                .literal("admin1-border")
                .describe("1st Administrative Division Border Question"),
            z
                .literal("admin2-border")
                .describe("2nd Administrative Division Border Question"),
            z.literal("sea-level").describe("Sea Level (Altitude) Question"),
            z.literal("body-of-water").describe("Body Of Water Question"),
        ])
        .default("coastline"),
});

const hidingZoneMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("mcdonalds").describe("McDonald's Question"),
        z.literal("seven11").describe("7-Eleven Question"),
        z.literal("rail-measure").describe("Train Station Question"),
    ]),
});

const homeGameMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("aquarium").describe("Aquarium Question"),
        z.literal("zoo").describe("Zoo Question"),
        z.literal("theme_park").describe("Theme Park Question"),
        z.literal("peak").describe("Mountain Question"),
        z.literal("museum").describe("Museum Question"),
        z.literal("hospital").describe("Hospital Question"),
        z.literal("cinema").describe("Cinema Question"),
        z.literal("library").describe("Library Question"),
        z.literal("golf_course").describe("Golf Course Question"),
        z.literal("consulate").describe("Foreign Consulate Question"),
        z.literal("park").describe("Park Question"),
    ]),
});

const customMeasuringQuestionSchema = baseMeasuringQuestionSchema.extend({
    type: z.literal("custom-measure").describe("Custom Measuring Question"),
    geo: z.any(),
});

export const measuringQuestionSchema = z.union([
    ordinaryMeasuringQuestionSchema.describe(NO_GROUP),
    customMeasuringQuestionSchema.describe(NO_GROUP),
    hidingZoneMeasuringQuestionsSchema.describe("Hiding Zone Mode"),
    homeGameMeasuringQuestionsSchema.describe("Hiding Zone Mode"),
]);

/**
 * Photo questions (rulebook p32–35) — "Send me a photo of ___".
 *
 * Photo subtype values match the rulebook's prompts. Validity per game
 * size is enforced via `src/lib/subtypes.ts`, not here, so older saved
 * questions of any subtype keep parsing.
 *
 * Photos are informational only — they don't trigger any map elimination
 * (see `adjustMapGeoDataForQuestion`, where unknown ids fall through to
 * a no-op `return mapGeoData`). The photo itself rides as an optional
 * base64 data URI on the question record; sharing the photo out-of-band
 * is also supported (the seeker can flip the question to "answered"
 * without attaching, e.g. when they receive the photo via SMS).
 */
const photoQuestionSchema = z.object({
    /** Photo subtype — what the seeker asked for ("tree", "selfie", etc.). */
    type: z.string().default("tree"),
    /**
     * Base64 data URI of the hider's reply photo. In multiplayer this
     * holds a small *thumbnail* (full detail lives at `photoUrl`); in
     * solo/offline play it holds the full-resolution image. Empty when
     * unanswered.
     */
    photoUri: z.string().optional(),
    /**
     * URL of the full-resolution photo stored in the game's R2 bucket
     * (multiplayer only). When present this is the canonical image the
     * seekers view — it can be multiple megabytes, well beyond what the
     * data-URI-over-WebSocket path could ever carry. Falls back to
     * `photoUri` when absent (solo play, or an upload that failed).
     */
    photoUrl: z.string().optional(),
    /** Optional note the hider left alongside the photo. */
    note: z.string().optional(),
    /**
     * Hider declined the question with "I cannot answer" (rulebook p32).
     * Valid when the subject doesn't exist in the hiding zone, or — most
     * commonly — during the end game, when the hider is locked to their
     * final spot and can't move to where the photo would be taken
     * (rulebook p7, "The End Game"). The hider still pulls a card for a
     * declined photo, so this resolves the question without a photoUri.
     */
    declined: z.boolean().optional(),
    /** Question lifecycle — same semantics as the other categories. */
    drag: z.boolean().default(true),
    collapsed: z.boolean().default(true),
    color: iconColorSchema.default(randomColor),
    /** Unix ms timestamp of when this question was created. */
    createdAt: z.number().optional(),
    /** Veto / Randomize markers — see ordinaryBaseQuestionSchema. */
    vetoed: z.boolean().optional(),
    randomized: z.boolean().optional(),
    randomizedFrom: z.string().optional(),
    randomizedAway: z.boolean().optional(),
    substituteFor: z.string().optional(),
});

export const questionSchema = z.union([
    z.object({
        id: z.literal("radius"),
        key: z.number().default(Math.random),
        data: radiusQuestionSchema,
    }),
    z.object({
        id: z.literal("thermometer"),
        key: z.number().default(Math.random),
        data: thermometerQuestionSchema,
    }),
    z.object({
        id: z.literal("tentacles"),
        key: z.number().default(Math.random),
        data: tentacleQuestionSchema,
    }),
    z.object({
        id: z.literal("measuring"),
        key: z.number().default(Math.random),
        data: measuringQuestionSchema,
    }),
    z.object({
        id: z.literal("matching"),
        key: z.number().default(Math.random),
        data: matchingQuestionSchema,
    }),
    z.object({
        id: z.literal("photo"),
        key: z.number().default(Math.random),
        data: photoQuestionSchema,
    }),
]);

export const questionsSchema = z.array(questionSchema);

export type Units = z.infer<typeof unitsSchema>;
export type RadiusQuestion = z.infer<typeof radiusQuestionSchema>;
export type ThermometerQuestion = z.infer<typeof thermometerQuestionSchema>;
export type TentacleQuestion = z.infer<typeof tentacleQuestionSchema>;
export type APILocations = z.infer<typeof apiLocationSchema>;
export type MatchingQuestion = z.infer<typeof matchingQuestionSchema>;
export type HomeGameMatchingQuestions = z.infer<
    typeof homeGameMatchingQuestionsSchema
>;
export type ZoneMatchingQuestions = z.infer<typeof zoneMatchingQuestionsSchema>;
export type CustomMatchingQuestion = z.infer<
    typeof customMatchingQuestionSchema
>;
export type CustomMeasuringQuestion = z.infer<
    typeof customMeasuringQuestionSchema
>;
export type MeasuringQuestion = z.infer<typeof measuringQuestionSchema>;
export type HomeGameMeasuringQuestions = z.infer<
    typeof homeGameMeasuringQuestionsSchema
>;
export type PhotoQuestion = z.infer<typeof photoQuestionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Questions = z.infer<typeof questionsSchema>;
export type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
export type TraditionalTentacleQuestion =
    | z.infer<typeof tentacleQuestionSpecificSchemaFifteen>
    | z.infer<typeof tentacleQuestionSpecificSchemaOne>;
export type EncompassingTentacleQuestionSchema = z.infer<
    typeof encompassingTentacleQuestionSchema
>;
export type CustomTentacleQuestion = z.infer<
    typeof customTentacleQuestionSchema
>;
