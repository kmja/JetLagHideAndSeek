import { persistentAtom } from "@nanostores/persistent";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { MapShim } from "@/lib/mapShim";
import { atom, computed, onSet } from "nanostores";

import type {
    AdditionalMapGeoLocations,
    CustomStation,
    OpenStreetMap,
    StationCircle,
} from "@/maps/api";
import { extractStationLabel } from "@/maps/geo-utils";
import {
    type DeepPartial,
    type Question,
    type Questions,
    questionSchema,
    questionsSchema,
    type Units,
} from "@/maps/schema";

export const mapGeoLocation = persistentAtom<OpenStreetMap>(
    "mapGeoLocation",
    {
        geometry: {
            coordinates: [36.5748441, 139.2394179],
            type: "Point",
        },
        type: "Feature",
        properties: {
            osm_type: "R",
            osm_id: 382313,
            extent: [45.7112046, 122.7141754, 20.2145811, 154.205541],
            country: "Japan",
            osm_key: "place",
            countrycode: "JP",
            osm_value: "country",
            name: "Japan",
            type: "country",
        },
    },
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);

export const additionalMapGeoLocations = persistentAtom<
    AdditionalMapGeoLocations[]
>("additionalMapGeoLocations", [], {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const permanentOverlay = persistentAtom<FeatureCollection | null>(
    "permanentOverlay",
    null,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);

export const mapGeoJSON = atom<FeatureCollection<
    Polygon | MultiPolygon
> | null>(null);

/**
 * Play-area boundary polygon — the result of the Overpass
 * fan-out + turf union/difference pipeline. Backed by the Cache
 * API (see `mapBoundaryCache.ts`), NOT localStorage: country
 * boundaries blow past localStorage's 5 MB quota and the silent
 * write failure was producing the "ready game but missing map"
 * symptom on reload.
 *
 * The atom is volatile; we hydrate it from Cache on first client
 * mount via the side-effect below. Subscribers also write back to
 * Cache on every change so the next page load can rehydrate
 * without an Overpass round-trip. `polyGeoJSONHydrated` flips
 * true once the initial cache read settles so Map.tsx can wait
 * before deciding the boundary is missing.
 */
export const polyGeoJSON = atom<FeatureCollection<
    Polygon | MultiPolygon
> | null>(null);
export const polyGeoJSONHydrated = atom<boolean>(false);

if (typeof window !== "undefined") {
    void (async () => {
        // One-time migration: previous versions stored the boundary
        // in localStorage under "polyGeoJSON". If we still have it
        // there, move it into Cache, then remove the localStorage
        // copy so future writes don't trip the quota again.
        try {
            const legacy = localStorage.getItem("polyGeoJSON");
            if (legacy) {
                try {
                    const parsed = JSON.parse(legacy);
                    if (parsed) {
                        const { saveBoundary } = await import(
                            "./mapBoundaryCache"
                        );
                        await saveBoundary(parsed);
                        polyGeoJSON.set(parsed);
                    }
                } catch {
                    /* corrupt JSON — drop it */
                }
                localStorage.removeItem("polyGeoJSON");
                polyGeoJSONHydrated.set(true);
                return;
            }
        } catch {
            /* localStorage unavailable — fall through to cache */
        }
        try {
            const { loadBoundary } = await import("./mapBoundaryCache");
            const cached = await loadBoundary<
                FeatureCollection<Polygon | MultiPolygon>
            >();
            if (cached && polyGeoJSON.get() === null) {
                polyGeoJSON.set(cached);
            }
        } catch {
            /* no-op */
        } finally {
            polyGeoJSONHydrated.set(true);
        }
    })();
    // Persist subsequent atom changes back to Cache. We do this
    // dynamically-imported so the SSR build doesn't reach for
    // caches at module-evaluation time.
    polyGeoJSON.subscribe((value) => {
        void import("./mapBoundaryCache").then(({ saveBoundary, clearBoundary }) => {
            if (value === null) void clearBoundary();
            else void saveBoundary(value);
        });
    });
}

export const questions = persistentAtom<Questions>("questions", [], {
    encode: JSON.stringify,
    decode: (x) => questionsSchema.parse(JSON.parse(x)),
});
export const addQuestion = (question: DeepPartial<Question>) =>
    questionModified(questions.get().push(questionSchema.parse(question)));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const questionModified = (..._: any[]) => {
    if (autoSave.get()) {
        questions.set([...questions.get()]);
    } else {
        triggerLocalRefresh.set(Math.random());
    }
};

/**
 * The mounted map, exposed through a Leaflet-shaped facade.
 *
 * Name preserved for backward-compat — every question card,
 * dialog, and side panel reads from it. The renderer is actually
 * MapLibre GL (see MapV2.tsx); the value here is a small shim
 * that translates Leaflet-style getCenter / fitBounds / flyTo /
 * etc. into the MapLibre equivalents. See `lib/mapShim.ts`.
 */
export const mapContext = atom<MapShim | null>(null);

/**
 * Hiding-zones GeoJSON shadow atom. ZoneSidebar's `showGeoJSON`
 * helper writes here in addition to its existing Leaflet
 * rendering so MapV2 (which doesn't have Leaflet layers to
 * piggyback on) can subscribe and render the same data via a
 * MapLibre Source+Layer. Setting null clears the overlay on
 * both paths.
 *
 * Lives in volatile (non-persistent) state: hiding zones get
 * derived from `questions` + `playArea` + `displayHidingZones*`
 * settings on every interaction, so we don't need to persist
 * them. The atom is just an emit-channel from the sidebar.
 */
export const hidingZonesGeoJSON = atom<GeoJSON.FeatureCollection | null>(null);

/**
 * Open-state for the mobile question drawer (the one the bottom-nav
 * "Questions" button opens). Lives here rather than inside `sidebar-l.tsx`'s
 * own atom because the upstream sidebar atom doesn't reliably cross Astro
 * island boundaries — `BottomNav` (client:only) sets it but the
 * `QuestionSidebar` (client:only) reads a different module instance and the
 * change never propagates. A dedicated atom in this widely-shared module
 * sidesteps the issue.
 *
 * Bound to `globalThis` so that Vite HMR re-imports of context.ts return
 * the *same* atom instance — without this, editing this file in dev (or
 * any file in its dependency cone) would create a fresh atom instance and
 * any component that hot-reloaded would see one atom while components that
 * didn't see the other, silently breaking cross-island state propagation.
 */
const __globalAtom = <T>(key: string, initial: T) => {
    const g = globalThis as Record<string, unknown>;
    if (!g[key]) g[key] = atom<T>(initial);
    return g[key] as ReturnType<typeof atom<T>>;
};

export const questionsDrawerOpen = __globalAtom<boolean>(
    "__jlhs_questionsDrawerOpen",
    false,
);

/**
 * Open-state for the right-hand zone-settings drawer (the gear button next
 * to the "Hiding zones" toggle in MapDisplayControls). Same rationale as
 * `questionsDrawerOpen` — sidesteps the upstream sidebar-r module's atom
 * which doesn't reliably cross Astro island boundaries.
 */
export const zoneSidebarOpen = __globalAtom<boolean>(
    "__jlhs_zoneSidebarOpen",
    false,
);

export const defaultUnit = persistentAtom<Units>("defaultUnit", "kilometers");
export const hiderMode = persistentAtom<
    | false
    | {
          latitude: number;
          longitude: number;
      }
>("isHiderMode", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const triggerLocalRefresh = atom<number>(0);
export const displayHidingZones = persistentAtom<boolean>(
    "displayHidingZones",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const displayHidingZonesOptions = persistentAtom<string[]>(
    "displayHidingZonesOptions",
    ["[railway=station]"],
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const displayHidingZonesStyle = persistentAtom<
    "zones" | "stations" | "no-overlap" | "no-display"
>("displayHidingZonesStyle", "zones");
export const questionFinishedMapData = atom<any>(null);

export const trainStations = atom<StationCircle[]>([]);
onSet(trainStations, ({ newValue }) => {
    newValue.sort((a, b) => {
        const aName = (extractStationLabel(a.properties) || "") as string;
        const bName = (extractStationLabel(b.properties) || "") as string;
        return aName.localeCompare(bName);
    });
});

export const useCustomStations = persistentAtom<boolean>(
    "useCustomStations",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const customStations = persistentAtom<CustomStation[]>(
    "customStations",
    [],
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const mergeDuplicates = persistentAtom<boolean>(
    "removeDuplicates",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const includeDefaultStations = persistentAtom<boolean>(
    "includeDefaultStations",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const animateMapMovements = persistentAtom<boolean>(
    "animateMapMovements",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const hidingRadius = persistentAtom<number>("hidingRadius", 0.5, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const hidingRadiusUnits = persistentAtom<Units>(
    "hidingRadiusUnits",
    "kilometers",
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const disabledStations = persistentAtom<string[]>(
    "disabledStations",
    [],
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const autoSave = persistentAtom<boolean>("autoSave", true, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const save = () => {
    questions.set([...questions.get()]);
    const $hiderMode = hiderMode.get();

    if ($hiderMode !== false) {
        hiderMode.set({ ...$hiderMode });
    }
};

/* Presets for custom questions (savable / sharable / editable) */
export type CustomPreset = {
    id: string;
    name: string;
    type: string;
    data: any;
    createdAt: string;
};

export const customPresets = persistentAtom<CustomPreset[]>(
    "customPresets",
    [],
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
onSet(customPresets, ({ newValue }) => {
    newValue.sort((a, b) => a.name.localeCompare(b.name));
});

export const saveCustomPreset = (
    preset: Omit<CustomPreset, "id" | "createdAt">,
) => {
    const id =
        typeof crypto !== "undefined" &&
        typeof (crypto as any).randomUUID === "function"
            ? (crypto as any).randomUUID()
            : String(Date.now());
    const p: CustomPreset = {
        ...preset,
        id,
        createdAt: new Date().toISOString(),
    };
    customPresets.set([...customPresets.get(), p]);
    return p;
};

export const updateCustomPreset = (
    id: string,
    updates: Partial<CustomPreset>,
) => {
    customPresets.set(
        customPresets
            .get()
            .map((p) => (p.id === id ? { ...p, ...updates } : p)),
    );
};

export const deleteCustomPreset = (id: string) => {
    customPresets.set(customPresets.get().filter((p) => p.id !== id));
};

export const hidingZone = computed(
    [
        questions,
        polyGeoJSON,
        mapGeoLocation,
        additionalMapGeoLocations,
        disabledStations,
        hidingRadius,
        hidingRadiusUnits,
        displayHidingZonesOptions,
        useCustomStations,
        customStations,
        includeDefaultStations,
        customPresets,
        permanentOverlay,
    ],
    (
        q,
        geo,
        loc,
        altLoc,
        disabledStations,
        radius,
        hidingRadiusUnits,
        zoneOptions,
        useCustom,
        $customStations,
        includeDefault,
        presets,
        $permanentOverlay,
    ) => {
        if (geo !== null) {
            return {
                ...geo,
                questions: q,
                disabledStations: disabledStations,
                hidingRadius: radius,
                hidingRadiusUnits,
                zoneOptions: zoneOptions,
                useCustomStations: useCustom,
                customStations: $customStations,
                includeDefaultStations: includeDefault,
                presets: structuredClone(presets),
                permanentOverlay: $permanentOverlay,
            };
        } else {
            const $loc = structuredClone(loc);
            $loc.properties.isHidingZone = true;
            $loc.properties.questions = q;
            return {
                ...$loc,
                disabledStations: disabledStations,
                hidingRadius: radius,
                hidingRadiusUnits,
                alternateLocations: structuredClone(altLoc),
                zoneOptions: zoneOptions,
                useCustomStations: useCustom,
                customStations: $customStations,
                includeDefaultStations: includeDefault,
                presets: structuredClone(presets),
                permanentOverlay: $permanentOverlay,
            };
        }
    },
);

export const drawingQuestionKey = atom<number>(-1);
export const planningModeEnabled = persistentAtom<boolean>(
    "planningModeEnabled",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const autoZoom = persistentAtom<boolean>("autoZoom", true, {
    encode: JSON.stringify,
    decode: JSON.parse,
});

export const isLoading = atom<boolean>(false);

export const baseTileLayer = persistentAtom<
    | "auto"
    | "voyager"
    | "light"
    | "dark"
    | "transport"
    | "neighbourhood"
    | "osmcarto"
>("baseTileLayer", "auto");
export const thunderforestApiKey = persistentAtom<string>(
    "thunderforestApiKey",
    "",
    {
        encode: (value: string) => value,
        decode: (value: string) => value,
    },
);
export const followMe = persistentAtom<boolean>("followMe", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});

/**
 * The seeker's most recent GPS fix, written by the main map's always-on
 * watch-position effect. Volatile (not persisted — a stale fix from a
 * previous session shouldn't seed a new game). Used as the default
 * location for matching/measuring question pickers so they start at
 * the player's real position (the same blue dot on the map) instead of
 * the play-area centroid.
 */
export const lastKnownPosition = atom<{ lat: number; lng: number } | null>(
    null,
);
export const defaultCustomQuestions = persistentAtom<boolean>(
    "defaultCustomQuestions",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);

export const pastebinApiKey = persistentAtom<string>("pastebinApiKey", "");
export const alwaysUsePastebin = persistentAtom<boolean>(
    "alwaysUsePastebin",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);

export const showTutorial = persistentAtom<boolean>("showTutorials", true, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const tutorialStep = atom<number>(0);

export const customInitPreference = persistentAtom<"ask" | "blank" | "prefill">(
    "customInitPreference",
    "ask",
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);

export const allowGooglePlusCodes = persistentAtom<boolean>(
    "allowGooglePlusCodes",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
