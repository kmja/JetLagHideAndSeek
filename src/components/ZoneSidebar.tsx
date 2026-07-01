import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection } from "geojson";
import type { MapShim } from "@/lib/mapShim";
import find from "lodash/find";
import isEqual from "lodash/isEqual";
import minBy from "lodash/minBy";
import { SidebarCloseIcon } from "lucide-react";
import osmtogeojson from "osmtogeojson";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { Drawer as VaulDrawer } from "vaul";

import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
} from "@/components/ui/sidebar-r";
import { useIsMobile } from "@/hooks/use-mobile";
import {
    animateMapMovements,
    autoZoom,
    customStations as customStationsAtom,
    disabledStations,
    displayHidingZones,
    displayHidingZonesOptions,
    displayHidingZonesStyle,
    hidingRadius,
    hidingRadiusUnits,
    hidingZonesAutoFromTransit,
    hidingZonesGeoJSON,
    includeDefaultStations as includeDefaultStationsAtom,
    isLoading,
    mapContext,
    mergeDuplicates as mergeDuplicatesAtom,
    planningModeEnabled,
    questionFinishedMapData,
    questions,
    trainStations,
    useCustomStations as useCustomStationsAtom,
    zoneSidebarOpen,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import {
    BLANK_GEOJSON,
    findPlacesInZone,
    findPlacesSpecificInZone,
    findTentacleLocations,
    nearestToQuestion,
    normalizeToStationFeatures,
    parseCustomStationsFromText,
    QuestionSpecificLocation,
    type StationCircle,
    type StationPlace,
    trainLineNodeFinder,
} from "@/maps/api";
import {
    extractStationLabel,
    extractStationName,
    geoSpatialVoronoi,
    holedMask,
    lngLatToText,
    mergeDuplicateStation,
    safeUnion,
} from "@/maps/geo-utils";

import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "./ui/command";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { MultiSelect } from "./ui/multi-select";
import { ScrollToTop } from "./ui/scroll-to-top";
import { MENU_ITEM_CLASSNAME } from "./ui/sidebar-l";
import { UnitSelect } from "./UnitSelect";

function _previewText(count: number) {
    return `${count} custom station${count === 1 ? "" : "s"} imported`;
}

let buttonJustClicked = false;

export const ZoneSidebar = () => {
    const $displayHidingZones = useStore(displayHidingZones);
    const $questionFinishedMapData = useStore(questionFinishedMapData);
    const $displayHidingZonesOptions = useStore(displayHidingZonesOptions);
    const $autoFromTransit = useStore(hidingZonesAutoFromTransit);
    const $displayHidingZonesStyle = useStore(displayHidingZonesStyle);
    const $hidingRadius = useStore(hidingRadius);
    const $hidingRadiusUnits = useStore(hidingRadiusUnits);
    const $isLoading = useStore(isLoading);
    const map = useStore(mapContext);
    const stations = useStore(trainStations);
    const $disabledStations = useStore(disabledStations);
    const useCustomStations = useStore(useCustomStationsAtom);
    const mergeDuplicates = useStore(mergeDuplicatesAtom);
    const includeDefaultStations = useStore(includeDefaultStationsAtom);
    const $customStations = useStore(customStationsAtom);
    const [hidingZoneModeStationID, setHidingZoneModeStationID] =
        useState<string>("");
    const [stationSearch, setStationSearch] = useState<string>("");
    const isStationSearchActive = stationSearch.trim().length > 0;
    const setStations = trainStations.set;
    const sidebarRef = useRef<HTMLDivElement>(null);
    // Re-entrancy guard for the hiding-zone computation. We used to gate
    // on the shared `isLoading` atom, but that atom is ALSO raised by the
    // play-area boundary load, the transit overlays and the travel-times
    // pass — so toggling "Hiding zones" while any of those were in flight
    // bailed the effect, and because `isLoading`/`map` weren't deps it
    // never retried (the overlay silently did nothing). A dedicated ref
    // decouples "a zone computation is already running" from "the app is
    // loading something else".
    const zoneComputingRef = useRef(false);
    // v630: cache key for the last successful station computation. When the
    // seeker toggles the overlay OFF then ON with nothing else changed, the
    // computed `trainStations` circles are still valid — so we skip the
    // whole Overpass-fetch + circle/Voronoi + per-question-filter pipeline
    // and let the (cheap) render effect repaint from the cached circles.
    // Only a genuine input change (options, radius, custom list, remaining
    // area, or the question set) busts the cache and recomputes.
    const lastComputeSigRef = useRef<string | null>(null);
    const lastAreaRef = useRef<unknown>(null);
    const [importUrl, setImportUrl] = useState("");

    const removeHidingZones = () => {
        // Single source of truth: clear the shadow atom and MapV2
        // re-renders without the overlay. The old Leaflet
        // map.eachLayer(...).removeLayer(...) dance is gone with
        // the Leaflet renderer (v80).
        hidingZonesGeoJSON.set(null);
    };

    const showGeoJSON = (
        geoJSONData: any,
        // The two parameters below are vestigial from the Leaflet
        // path's L.geoJSON options object — kept in the signature
        // so the half-dozen call sites don't all need rewrites,
        // but ignored on MapLibre. The MapV2 Source/Layer pair
        // styles the overlay declaratively from the shadow atom
        // (see MapV2.tsx for the paint config).
        _nonOverlappingStations: boolean = false,
        _additionalOptions: unknown = {},
    ) => {
        if (!geoJSONData) return;
        // Normalize whatever the caller passed (FeatureCollection,
        // single Feature, or bare Geometry) into a FeatureCollection
        // so MapV2's Source binding sees a consistent shape.
        if (geoJSONData.type === "FeatureCollection") {
            hidingZonesGeoJSON.set(geoJSONData);
        } else if (geoJSONData.type === "Feature") {
            hidingZonesGeoJSON.set({
                type: "FeatureCollection",
                features: [geoJSONData],
            });
        } else {
            hidingZonesGeoJSON.set({
                type: "FeatureCollection",
                features: [
                    {
                        type: "Feature",
                        geometry: geoJSONData,
                        properties: {},
                    },
                ],
            });
        }
    };

    useEffect(() => {
        if (!map) return;

        // Signature of every input the station computation reads. If it's
        // unchanged since the last successful compute (and we still hold
        // the computed circles), toggling the overlay back ON doesn't need
        // to refetch/recompute — the render effect repaints from cache.
        const computeSig = JSON.stringify({
            options: $displayHidingZonesOptions,
            useCustomStations,
            includeDefaultStations,
            customStations: $customStations,
            mergeDuplicates,
            radius: $hidingRadius,
            radiusUnits: $hidingRadiusUnits,
            planning: planningModeEnabled.get(),
            questions: questions
                .get()
                .map(
                    (q) =>
                        `${q.key}:${(q.data as any).type ?? ""}:${(q.data as any).same ?? ""}:${(q.data as any).lengthComparison ?? ""}:${(q.data as any).hiderCloser ?? ""}:${q.data.drag ? 1 : 0}`,
                ),
        });
        const upToDate =
            stations.length > 0 &&
            computeSig === lastComputeSigRef.current &&
            $questionFinishedMapData === lastAreaRef.current;

        const initializeHidingZones = async () => {
            zoneComputingRef.current = true;
            isLoading.set(true);

            const needsDefault = !useCustomStations || includeDefaultStations;
            if (needsDefault && $displayHidingZonesOptions.length === 0) {
                toast.error("At least one place type must be selected");
                zoneComputingRef.current = false;
                isLoading.set(false);
                return;
            }

            let places: StationPlace[] = [];

            if (!needsDefault) {
                // Custom only
                places = normalizeToStationFeatures(
                    $customStations,
                ).features.map((f) => ({
                    type: "Feature",
                    geometry: f.geometry,
                    properties: {
                        id:
                            f.properties?.id ||
                            `${(f.geometry as any).coordinates[1]},${(f.geometry as any).coordinates[0]}`,
                        name: f.properties?.name,
                    },
                }));
            } else {
                // Fetch default, optionally merge custom. We deliberately
                // don't pass a `loadingText` here so the toast doesn't fire —
                // a compact "Finding stations" pill in the map-display
                // controls already covers the loading affordance (driven by
                // `isLoading`).
                // @ts-expect-error osmtogeojson always defines properties with an "id" string
                places = osmtogeojson(
                    await findPlacesInZone(
                        $displayHidingZonesOptions[0],
                        undefined,
                        "nwr",
                        "center",
                        $displayHidingZonesOptions.slice(1),
                    ),
                ).features;

                if (
                    useCustomStations &&
                    $customStations.length > 0 &&
                    includeDefaultStations
                ) {
                    const customFeatures = normalizeToStationFeatures(
                        $customStations,
                    ).features.map(
                        (f) =>
                            ({
                                type: "Feature",
                                geometry: f.geometry,
                                properties: {
                                    id:
                                        f.properties?.id ||
                                        `${f.geometry.coordinates[1]},${f.geometry.coordinates[0]}`,
                                    name: f.properties?.name,
                                },
                            }) as StationPlace,
                    );
                    const seen = new Set<string>();
                    const merged: StationPlace[] = [];
                    const add = (feat: StationPlace) => {
                        const id = feat.properties.id as string | undefined;
                        const key =
                            id && id.includes("/")
                                ? `id:${id}`
                                : `pt:${feat.geometry.coordinates[1]},${feat.geometry.coordinates[0]}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            merged.push(feat);
                        }
                    };
                    places.forEach(add);
                    customFeatures.forEach(add);
                    places = merged;
                }
            }

            // merge duplicate stations if selected
            if (mergeDuplicates) {
                places = mergeDuplicateStation(
                    places,
                    $hidingRadius,
                    $hidingRadiusUnits,
                );
            }

            const unionized = safeUnion(
                turf.simplify($questionFinishedMapData, {
                    tolerance: 0.001,
                }),
            );

            let circles = places
                .map((place) => {
                    const radius = $hidingRadius;
                    const center = turf.getCoord(place);
                    // 512 segments → ~6 m chord on a 500 m radius
                    // (under one CSS pixel even at zoom 18). The
                    // previous 256-segment circles still showed
                    // visible facets at city zoom over the dashed
                    // primary-red border (which highlights the
                    // polygon edges); doubling resolution removes
                    // them without meaningful perf cost — even a
                    // 1000-station network only adds ~250 K vertex
                    // updates total, which Leaflet handles fine
                    // on the canvas/SVG side.
                    const circle = turf.circle(center, radius, {
                        steps: 512,
                        units: $hidingRadiusUnits,
                        properties: place,
                    });

                    return circle;
                })
                .filter((circle) => {
                    // Keep a station if its hiding zone still overlaps the
                    // remaining valid area (interior OR boundary-straddling).
                    // `unionized` is the play area MINUS every eliminated
                    // region (questionFinishedMapData), so a station is a
                    // live candidate iff its circle intersects it.
                    //
                    // The old test `!booleanWithin(circle, unionized)` was
                    // inverted: booleanWithin is true only when the circle
                    // sits ENTIRELY inside the area, so negating it DROPPED
                    // every fully-interior zone and kept only the ones poking
                    // out past the boundary. Early-game (whole area still
                    // valid) that painted a ring of stations around the edge
                    // with an empty middle. Guard against a failed union so a
                    // null polygon never silently drops every candidate.
                    if (!unionized) return true;
                    return turf.booleanIntersects(circle, unionized);
                });

            for (const question of questions.get()) {
                if (planningModeEnabled.get() && question.data.drag) {
                    continue;
                }

                if (
                    question.id === "matching" &&
                    (question.data.type === "same-first-letter-station" ||
                        question.data.type === "same-length-station" ||
                        question.data.type === "same-train-line")
                ) {
                    const location = turf.point([
                        question.data.lng,
                        question.data.lat,
                    ]);

                    const nearestTrainStation = turf.nearestPoint(
                        location,
                        turf.featureCollection(
                            circles.map((x) => x.properties),
                        ) as any,
                    );

                    if (question.data.type === "same-train-line") {
                        // Custom-only lists don't have reliable OSM IDs
                        if (useCustomStations && !includeDefaultStations) {
                            toast.warning(
                                "'Same train line' isn't supported with custom-only station lists; skipping this filter.",
                            );
                        } else {
                            const nid = nearestTrainStation.properties.id as
                                | string
                                | undefined;
                            if (!nid || !nid.includes("/")) {
                                toast.warning(
                                    "Nearest station has no OSM id; skipping 'same train line' filter.",
                                );
                                continue;
                            }

                            const nodes = await trainLineNodeFinder(nid);

                            if (nodes.length === 0) {
                                toast.warning(
                                    `No train line found for ${extractStationName(
                                        nearestTrainStation,
                                    )}`,
                                );
                                continue;
                            } else {
                                circles = circles.filter((circle) => {
                                    const idProp =
                                        circle.properties.properties.id;
                                    if (!idProp || !idProp.includes("/"))
                                        return false;
                                    const id = parseInt(idProp.split("/")[1]);

                                    return question.data.same
                                        ? nodes.includes(id)
                                        : !nodes.includes(id);
                                });
                            }
                        }
                    }

                    const englishName = extractStationName(nearestTrainStation);

                    if (!englishName)
                        return toast.error("No English name found");

                    if (question.data.type === "same-first-letter-station") {
                        const letter = englishName[0].toUpperCase();

                        circles = circles.filter((circle) => {
                            const name = extractStationName(circle.properties);
                            if (!name) return false;

                            return question.data.same
                                ? name[0].toUpperCase() === letter
                                : name[0].toUpperCase() !== letter;
                        });
                    } else if (question.data.type === "same-length-station") {
                        const seekerLength = englishName.length;
                        const comparison = question.data.lengthComparison;

                        circles = circles.filter((circle) => {
                            const name = extractStationName(circle.properties);
                            if (!name) return false;

                            if (comparison === "same") {
                                return name.length === seekerLength;
                            } else if (comparison === "shorter") {
                                return name.length < seekerLength;
                            } else if (comparison === "longer") {
                                return name.length > seekerLength;
                            }
                            return false;
                        });
                    }
                }
                if (
                    question.id === "measuring" &&
                    (question.data.type === "mcdonalds" ||
                        question.data.type === "seven11")
                ) {
                    const points = await findPlacesSpecificInZone(
                        question.data.type === "mcdonalds"
                            ? QuestionSpecificLocation.McDonalds
                            : QuestionSpecificLocation.Seven11,
                    );

                    const nearestPoint = turf.nearestPoint(
                        turf.point([question.data.lng, question.data.lat]),
                        points as any,
                    );

                    const distance = turf.distance(
                        turf.point([question.data.lng, question.data.lat]),
                        nearestPoint as any,
                        {
                            units: "miles",
                        },
                    );

                    circles = circles.filter((circle) => {
                        const point = turf.point(
                            turf.getCoord(circle.properties),
                        );

                        const nearest = turf.nearestPoint(point, points as any);

                        return question.data.hiderCloser
                            ? turf.distance(point, nearest as any, {
                                  units: "miles",
                              }) <
                                  distance + $hidingRadius
                            : turf.distance(point, nearest as any, {
                                  units: "miles",
                              }) >
                                  distance - $hidingRadius;
                    });
                }
            }

            setStations(circles);
            // Remember what this result was computed from so a plain
            // off→on toggle can skip straight to the render.
            lastComputeSigRef.current = computeSig;
            lastAreaRef.current = $questionFinishedMapData;
            zoneComputingRef.current = false;
            isLoading.set(false);
        };

        // Skip only if a zone computation is ALREADY running (re-entrancy),
        // not just because something else set the shared `isLoading` flag.
        if (
            $displayHidingZones &&
            $questionFinishedMapData &&
            !zoneComputingRef.current &&
            !upToDate
        ) {
            initializeHidingZones().catch((error) => {
                console.warn("Hiding zone initialization failed:", error);
                toast.error(
                    "An error occurred during hiding zone initialization",
                    { toastId: "hiding-zone-initialization-error" },
                );
                // v276: clear isLoading on failure too, otherwise it
                // stays stuck `true` and every downstream control that
                // gates on it (radius/matching/measuring presets, the
                // nearest-reference preview, the manual answer toggle)
                // is permanently disabled until reload. Was the root
                // cause behind a flood of user-reported "can't tap
                // anything" symptoms after an Overpass timeout.
                zoneComputingRef.current = false;
                isLoading.set(false);
            });
        }
    }, [
        // `map` IS a dep now: without it, toggling the overlay before the
        // MapLibre instance was in context bailed the effect forever.
        // `$isLoading` deliberately is NOT a dep — this effect writes it,
        // so depending on it would loop; instead we dropped the
        // `isLoading.get()` early-bail entirely (the old bug) and use
        // `zoneComputingRef` purely for re-entrancy.
        map,
        $questionFinishedMapData,
        $displayHidingZones,
        $displayHidingZonesOptions,
        $hidingRadius,
        useCustomStations,
        includeDefaultStations,
        $customStations,
        mergeDuplicates,
    ]);

    useEffect(() => {
        // Only `!map` gates the render pass — the old `isLoading.get()`
        // bail meant the overlay never painted if any unrelated load was
        // in flight when the toggle flipped (and never retried, since
        // neither map nor isLoading was a dep here).
        if (!map) return;

        if ($displayHidingZones && hidingZoneModeStationID) {
            const hiderStation = find(
                stations,
                (c) => c.properties.properties.id === hidingZoneModeStationID,
            );

            if (hiderStation !== undefined) {
                selectionProcess(
                    hiderStation,
                    map,
                    stations,
                    showGeoJSON,
                    $questionFinishedMapData,
                    $hidingRadius,
                ).catch((error) => {
                    console.warn("Hiding zone selection failed:", error);
                    toast.error(
                        "An error occurred during hiding zone selection",
                        { toastId: "hiding-zone-selection-error" },
                    );
                });
            } else {
                toast.error("Invalid hiding zone selected", {
                    toastId: "hiding-zone-selection-error",
                });
            }
        } else if ($displayHidingZones) {
            const activeStations = stations.filter(
                (x) => !$disabledStations.includes(x.properties.properties.id),
            );
            showGeoJSON(
                styleStations(activeStations, $displayHidingZonesStyle),
                $displayHidingZonesStyle === "zones",
            );
        } else {
            removeHidingZones();
        }
    }, [
        map,
        $disabledStations,
        $displayHidingZones,
        $displayHidingZonesStyle,
        $hidingRadius,
        $questionFinishedMapData,
        hidingZoneModeStationID,
        stations,
    ]);

    const $mobileOpen = useStore(zoneSidebarOpen);

    // Shared body for both desktop sidebar and mobile drawer — keeps the
    // huge configuration UI defined in one place.
    const body = (
        <>
            <div className="flex items-center justify-between">
                <h2 className="ml-4 mt-4 font-poppins text-2xl">
                    Hiding Zone
                </h2>
                <SidebarCloseIcon
                    className="mr-2 visible md:hidden scale-x-[-1] cursor-pointer"
                    onClick={() => zoneSidebarOpen.set(false)}
                />
            </div>
            <SidebarContent ref={sidebarRef}>
                <ScrollToTop element={sidebarRef} minHeight={500} />
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                                <Label className="font-semibold font-poppins">
                                    Display hiding zones?
                                </Label>
                                <Checkbox
                                    defaultChecked={$displayHidingZones}
                                    checked={$displayHidingZones}
                                    onCheckedChange={displayHidingZones.set}
                                    disabled={$isLoading}
                                />
                            </SidebarMenuItem>
                            <SidebarMenuItem
                                className={cn(
                                    MENU_ITEM_CLASSNAME,
                                    "text-orange-500",
                                )}
                            >
                                Warning: This feature can drastically slow down
                                your device.
                            </SidebarMenuItem>
                            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                                <div className="flex flex-row items-center justify-between w-full">
                                    <Label className="font-semibold font-poppins">
                                        Use custom station list?
                                    </Label>
                                    <Checkbox
                                        checked={useCustomStations}
                                        onCheckedChange={(v) =>
                                            useCustomStationsAtom.set(!!v)
                                        }
                                        disabled={$isLoading}
                                    />
                                </div>
                            </SidebarMenuItem>
                            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                                <div className="flex flex-row items-center justify-between w-full">
                                    <Label className="font-semibold font-poppins">
                                        Merge duplicated stations?
                                    </Label>
                                    <Checkbox
                                        checked={mergeDuplicates}
                                        onCheckedChange={(v) =>
                                            mergeDuplicatesAtom.set(!!v)
                                        }
                                        disabled={$isLoading}
                                    />
                                </div>
                            </SidebarMenuItem>
                            {useCustomStations && (
                                <>
                                    <SidebarMenuItem
                                        className={MENU_ITEM_CLASSNAME}
                                    >
                                        <div className="flex flex-col gap-2 w-full">
                                            <Label className="font-semibold font-poppins leading-5">
                                                Import stations from a direct
                                                file link. Supports CSV,
                                                GeoJSON, and KML.
                                            </Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    placeholder="https://..."
                                                    value={importUrl}
                                                    onChange={(e) =>
                                                        setImportUrl(
                                                            e.target.value,
                                                        )
                                                    }
                                                    disabled={$isLoading}
                                                />
                                                <button
                                                    className="bg-blue-600 text-white px-3 rounded-md"
                                                    disabled={$isLoading}
                                                    onClick={async () => {
                                                        if (!importUrl) return;
                                                        try {
                                                            const res =
                                                                await fetch(
                                                                    importUrl,
                                                                );
                                                            const contentType =
                                                                res.headers.get(
                                                                    "content-type",
                                                                ) || undefined;
                                                            const text =
                                                                await res.text();
                                                            const parsed =
                                                                parseCustomStationsFromText(
                                                                    text,
                                                                    contentType ||
                                                                        undefined,
                                                                );
                                                            if (
                                                                parsed.length ===
                                                                0
                                                            ) {
                                                                toast.error(
                                                                    "No stations found in that file.",
                                                                );
                                                                return;
                                                            }
                                                            customStationsAtom.set(
                                                                parsed,
                                                            );
                                                            toast.success(
                                                                `Imported ${parsed.length} stations`,
                                                            );
                                                        } catch (e: any) {
                                                            toast.error(
                                                                `Couldn't import stations: ${e.message || e}`,
                                                            );
                                                        }
                                                    }}
                                                >
                                                    Import
                                                </button>
                                            </div>
                                            <div>
                                                <Input
                                                    type="file"
                                                    multiple
                                                    accept=".csv,.json,.geojson,.kml,application/json,application/vnd.google-earth.kml+xml,text/csv,application/vnd.google-apps.kml+xml,application/xml,text/xml"
                                                    onInput={async (e) => {
                                                        const files = (
                                                            e.target as HTMLInputElement
                                                        ).files;
                                                        if (
                                                            !files ||
                                                            files.length === 0
                                                        )
                                                            return;
                                                        try {
                                                            const all: any[] =
                                                                [];
                                                            for (const file of Array.from(
                                                                files,
                                                            )) {
                                                                const text =
                                                                    await file.text();
                                                                const parsed =
                                                                    parseCustomStationsFromText(
                                                                        text,
                                                                        file.type,
                                                                    );
                                                                all.push(
                                                                    ...parsed,
                                                                );
                                                            }
                                                            if (
                                                                all.length === 0
                                                            ) {
                                                                toast.error(
                                                                    "No stations found in uploaded files",
                                                                );
                                                                return;
                                                            }
                                                            const byKey =
                                                                new Map<
                                                                    string,
                                                                    any
                                                                >();
                                                            for (const s of all) {
                                                                const key =
                                                                    s.id &&
                                                                    s.id.includes(
                                                                        "/",
                                                                    )
                                                                        ? `id:${s.id}`
                                                                        : `pt:${s.lat},${s.lng}`;
                                                                if (
                                                                    !byKey.has(
                                                                        key,
                                                                    )
                                                                )
                                                                    byKey.set(
                                                                        key,
                                                                        s,
                                                                    );
                                                            }
                                                            const unique =
                                                                Array.from(
                                                                    byKey.values(),
                                                                );
                                                            customStationsAtom.set(
                                                                unique,
                                                            );
                                                            toast.success(
                                                                `Imported ${unique.length} stations`,
                                                            );
                                                        } catch (e: any) {
                                                            toast.error(
                                                                `Failed to import files: ${e.message || e}`,
                                                            );
                                                        }
                                                    }}
                                                />
                                            </div>
                                            <div className="flex flex-row items-center justify-between w-full">
                                                <Label className="font-semibold font-poppins">
                                                    Include default stations
                                                    with custom list?
                                                </Label>
                                                <Checkbox
                                                    checked={
                                                        includeDefaultStations
                                                    }
                                                    onCheckedChange={(v) =>
                                                        includeDefaultStationsAtom.set(
                                                            !!v,
                                                        )
                                                    }
                                                    disabled={$isLoading}
                                                />
                                            </div>
                                            {$customStations.length > 0 && (
                                                <div className="text-sm text-gray-300">
                                                    {_previewText(
                                                        $customStations.length,
                                                    )}
                                                </div>
                                            )}
                                            {$customStations.length > 0 && (
                                                <div className="flex gap-2">
                                                    <Button
                                                        className="w-full"
                                                        onClick={() =>
                                                            customStationsAtom.set(
                                                                [],
                                                            )
                                                        }
                                                    >
                                                        Clear Imported
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    </SidebarMenuItem>
                                </>
                            )}
                            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                                <MultiSelect
                                    options={[
                                        {
                                            label: "Railway Stations",
                                            value: "[railway=station]",
                                        },
                                        {
                                            label: "Railway Halts",
                                            value: "[railway=halt]",
                                        },
                                        {
                                            label: "Railway Stops",
                                            value: "[railway=stop]",
                                        },
                                        {
                                            label: "Tram Stops",
                                            value: "[railway=tram_stop]",
                                        },
                                        {
                                            label: "Bus Stops",
                                            value: "[highway=bus_stop]",
                                        },
                                        {
                                            label: "Ferry Terminals",
                                            value: "[amenity=ferry_terminal]",
                                        },
                                        {
                                            label: "Ferry Platforms (public transport)",
                                            value: "[public_transport=platform][platform=ferry]",
                                        },
                                        {
                                            label: "Funicular Stations",
                                            value: "[railway=funicular]",
                                        },
                                        {
                                            label: "Aerialway Stations",
                                            value: "[aerialway=station]",
                                        },
                                        {
                                            label: "Railway Stations Excluding Subways",
                                            value: "[railway=station][subway!=yes]",
                                        },
                                        {
                                            label: "Subway Stations",
                                            value: "[railway=station][subway=yes]",
                                        },
                                        {
                                            label: "Light Rail Stations",
                                            value: "[railway=station][light_rail=yes]",
                                        },
                                        {
                                            label: "Light Rail Halts",
                                            value: "[railway=halt][light_rail=yes]",
                                        },
                                    ]}
                                    onValueChange={(next) => {
                                        // Any manual edit flips the
                                        // auto-from-allowed-transit
                                        // tracker off. A "Match allowed
                                        // transit" button below flips
                                        // it back on (and snaps the
                                        // selection to match).
                                        hidingZonesAutoFromTransit.set(false);
                                        displayHidingZonesOptions.set(next);
                                    }}
                                    defaultValue={$displayHidingZonesOptions}
                                    placeholder="Select allowed places"
                                    animation={2}
                                    maxCount={3}
                                    modalPopover
                                    className="!bg-popover bg-opacity-100"
                                    disabled={
                                        $isLoading ||
                                        (useCustomStations &&
                                            !includeDefaultStations)
                                    }
                                />
                                <div className="mt-1.5 px-1 flex items-center justify-between gap-2">
                                    <span className="text-[11px] text-muted-foreground leading-snug">
                                        {$autoFromTransit
                                            ? "Auto-matched to allowed transit modes."
                                            : "Custom selection — no longer tracking allowed transit."}
                                    </span>
                                    {!$autoFromTransit && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                hidingZonesAutoFromTransit.set(
                                                    true,
                                                );
                                            }}
                                            className={cn(
                                                "shrink-0 rounded-sm border border-border bg-secondary px-2 py-1",
                                                "text-[11px] font-poppins font-semibold uppercase tracking-wide",
                                                "hover:bg-accent transition-colors",
                                            )}
                                            title="Snap the station-type list back to whatever transit modes the game allows."
                                        >
                                            Match allowed transit
                                        </button>
                                    )}
                                </div>
                            </SidebarMenuItem>
                            <SidebarMenuItem>
                                <Label className="font-semibold font-poppins ml-2">
                                    Hiding Zone Radius
                                </Label>
                                <div
                                    className={cn(
                                        MENU_ITEM_CLASSNAME,
                                        "gap-2 flex flex-row",
                                    )}
                                >
                                    <Input
                                        type="number"
                                        className="rounded-md p-2 w-16"
                                        value={$hidingRadius}
                                        onChange={(e) => {
                                            hidingRadius.set(
                                                parseFloat(e.target.value),
                                            );
                                        }}
                                        disabled={$isLoading}
                                    />
                                    <UnitSelect
                                        unit={$hidingRadiusUnits}
                                        disabled={$isLoading}
                                        onChange={(unit) => {
                                            hidingRadiusUnits.set(unit);
                                        }}
                                    />
                                </div>
                            </SidebarMenuItem>
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set(
                                            "no-display",
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    No Display
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set("stations");
                                    }}
                                    disabled={$isLoading}
                                >
                                    All Stations
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set("zones");
                                    }}
                                    disabled={$isLoading}
                                >
                                    All Zones
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set(
                                            "no-overlap",
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    No Overlap
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && hidingZoneModeStationID && (
                                <SidebarMenuItem
                                    className={cn(
                                        MENU_ITEM_CLASSNAME,
                                        "bg-popover hover:bg-accent",
                                    )}
                                    disabled={$isLoading}
                                >
                                    Current:{" "}
                                    {(() => {
                                        const selected = stations.find(
                                            (x) =>
                                                x.properties.properties.id ===
                                                hidingZoneModeStationID,
                                        );
                                        const displayName = extractStationLabel(
                                            selected?.properties,
                                        );
                                        const id = selected?.properties
                                            .properties.id as string;
                                        const coords = selected?.properties
                                            .geometry.coordinates as [
                                            number,
                                            number,
                                        ];
                                        const href = id?.includes("/")
                                            ? `https://www.openstreetmap.org/${id}`
                                            : `https://www.openstreetmap.org/?mlat=${coords[1]}&mlon=${coords[0]}#map=17/${coords[1]}/${coords[0]}`;
                                        return (
                                            <a
                                                href={href}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-blue-500"
                                            >
                                                {displayName}
                                            </a>
                                        );
                                    })()}
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones &&
                                $disabledStations.length > 0 && (
                                    <SidebarMenuItem
                                        className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                        onClick={() => {
                                            disabledStations.set([]);
                                        }}
                                        disabled={$isLoading}
                                    >
                                        Clear Disabled
                                    </SidebarMenuItem>
                                )}
                            {$displayHidingZones && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        disabledStations.set(
                                            stations.map(
                                                (x) =>
                                                    x.properties.properties.id,
                                            ),
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    Disable All
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && (
                                <Command
                                    key={
                                        isStationSearchActive
                                            ? "station-search-active"
                                            : "station-search-idle"
                                    }
                                    shouldFilter={isStationSearchActive}
                                >
                                    <CommandInput
                                        placeholder="Search for a hiding zone..."
                                        value={stationSearch}
                                        onValueChange={setStationSearch}
                                        disabled={$isLoading}
                                    />
                                    <CommandList className="max-h-full">
                                        <CommandEmpty>
                                            No hiding zones found.
                                        </CommandEmpty>
                                        <CommandGroup>
                                            {stations.map((station) => (
                                                <CommandItem
                                                    key={
                                                        station.properties
                                                            .properties.id
                                                    }
                                                    data-station-id={
                                                        station.properties
                                                            .properties.id
                                                    }
                                                    className={cn(
                                                        $disabledStations.includes(
                                                            station.properties
                                                                .properties.id,
                                                        ) && "line-through",
                                                    )}
                                                    onSelect={async () => {
                                                        if (!map) return;

                                                        setTimeout(() => {
                                                            if (
                                                                buttonJustClicked
                                                            ) {
                                                                buttonJustClicked =
                                                                    false;
                                                                return;
                                                            }

                                                            if (
                                                                $disabledStations.includes(
                                                                    station
                                                                        .properties
                                                                        .properties
                                                                        .id,
                                                                )
                                                            ) {
                                                                disabledStations.set(
                                                                    [
                                                                        ...$disabledStations.filter(
                                                                            (
                                                                                x,
                                                                            ) =>
                                                                                x !==
                                                                                station
                                                                                    .properties
                                                                                    .properties
                                                                                    .id,
                                                                        ),
                                                                    ],
                                                                );
                                                            } else {
                                                                disabledStations.set(
                                                                    [
                                                                        ...$disabledStations,
                                                                        station
                                                                            .properties
                                                                            .properties
                                                                            .id,
                                                                    ],
                                                                );
                                                            }

                                                            setStations([
                                                                ...stations,
                                                            ]);
                                                        }, 100);
                                                    }}
                                                    disabled={$isLoading}
                                                >
                                                    {extractStationLabel(
                                                        station.properties,
                                                    )}
                                                    <button
                                                        onClick={async () => {
                                                            if (!map) return;

                                                            buttonJustClicked =
                                                                true;

                                                            setHidingZoneModeStationID(
                                                                station
                                                                    .properties
                                                                    .properties
                                                                    .id,
                                                            );
                                                        }}
                                                        className="bg-slate-600 p-0.5 rounded-md"
                                                        disabled={$isLoading}
                                                    >
                                                        View
                                                    </button>
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            )}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
        </>
    );

    const isMobile = useIsMobile();

    // Mobile: render the body inside our own VaulDrawer, controlled by the
    // shared `zoneSidebarOpen` atom. The upstream Sidebar's mobile branch
    // uses an internal atom that doesn't cross Astro island boundaries —
    // see questionsDrawerOpen in src/lib/context.ts — so we own this drawer.
    if (isMobile) {
        return (
            <VaulDrawer.Root
                open={$mobileOpen}
                onOpenChange={(o) => zoneSidebarOpen.set(o)}
                shouldScaleBackground={false}
                direction="right"
            >
                <VaulDrawer.Portal>
                    <VaulDrawer.Overlay className="fixed inset-0 z-[1040] bg-black/60" />
                    <VaulDrawer.Content className="fixed inset-y-0 right-0 z-[1045] flex w-[88vw] max-w-md flex-col border-l bg-sidebar text-sidebar-foreground">
                        <VaulDrawer.Title className="sr-only">
                            Hiding zone settings
                        </VaulDrawer.Title>
                        <div className="flex flex-col w-full overflow-y-auto h-full">
                            {body}
                        </div>
                    </VaulDrawer.Content>
                </VaulDrawer.Portal>
            </VaulDrawer.Root>
        );
    }

    // Desktop: existing right Sidebar (collapsible offcanvas).
    return <Sidebar side="right">{body}</Sidebar>;
};

function styleStations(
    circles: StationCircle[],
    style: string,
): FeatureCollection | Feature {
    switch (style) {
        case "no-display":
            return { type: "FeatureCollection", features: [] };

        case "no-overlap":
            // safeUnion → turf.union throws on an empty collection; guard.
            if (circles.length === 0)
                return { type: "FeatureCollection", features: [] };
            return safeUnion(turf.featureCollection(circles));

        case "stations": {
            // Dots + name labels + a single UNIONED extent fill. Filling
            // each circle separately compounds opacity where zones overlap
            // (4+ overlapping zones turn the basemap into an opaque wash);
            // unioning paints the covered area exactly once at a uniform
            // faint opacity, and its outline becomes the clean envelope of
            // the possible-hiding area rather than crisscrossing arcs.
            // turf.union (inside safeUnion) needs ≥2 geometries, so only
            // union when there are at least 2 circles; 1 → that circle; 0 →
            // no fill. (A bare 0/1 case otherwise threw "Must have at least
            // 2 geometries" → the map error boundary.)
            const union =
                circles.length >= 2
                    ? (safeUnion(turf.featureCollection(circles)) as Feature)
                    : (circles[0] ?? null);
            return turf.featureCollection([
                ...(union ? [union] : []),
                ...circles.map((c) => c.properties as Feature),
            ]);
        }

        default:
            // "zones": individual circles (per-zone fill + outline) plus
            // centre points so the name labels render here too. This view
            // deliberately shows each zone distinctly.
            return turf.featureCollection([
                ...circles,
                ...circles.map((c) => c.properties as Feature),
            ]);
    }
}

async function selectionProcess(
    station: any,
    map: MapShim,
    stations: any[],
    showGeoJSON: (geoJSONData: any) => void,
    $questionFinishedMapData: any,
    $hidingRadius: number,
) {
    const bbox = turf.bbox(station);

    const bounds: [[number, number], [number, number]] = [
        [bbox[1], bbox[0]],
        [bbox[3], bbox[2]],
    ];

    let mapData: any = turf.featureCollection([
        safeUnion(
            turf.featureCollection([
                ...$questionFinishedMapData.features,
                turf.mask(station),
            ]),
        ),
    ]);

    for (const question of questions.get()) {
        if (planningModeEnabled.get() && question.data.drag) {
            continue;
        }

        if (
            (question.id === "measuring" || question.id === "matching") &&
            (question.data.type === "aquarium" ||
                question.data.type === "zoo" ||
                question.data.type === "theme_park" ||
                question.data.type === "peak" ||
                question.data.type === "museum" ||
                question.data.type === "hospital" ||
                question.data.type === "cinema" ||
                question.data.type === "library" ||
                question.data.type === "golf_course" ||
                question.data.type === "consulate" ||
                question.data.type === "park")
        ) {
            const nearestQuestion = await nearestToQuestion(question.data);

            let radius = 30;

            let instances: any = { features: [] };

            const nearestPoints = [];

            while (instances.features.length === 0) {
                instances = await findTentacleLocations(
                    {
                        lat: station.properties.geometry.coordinates[1],
                        lng: station.properties.geometry.coordinates[0],
                        radius: radius,
                        unit: "miles",
                        location: false,
                        locationType: question.data.type,
                        drag: false,
                        color: "black",
                        collapsed: false,
                    },
                    "Finding matching locations to hiding zone...",
                );

                const distances: any[] = instances.features.map((x: any) => {
                    return {
                        distance: turf.distance(
                            turf.point(turf.getCoord(x)),
                            station.properties,
                            {
                                units: "miles",
                            },
                        ),
                        point: x,
                    };
                });

                if (distances.length === 0) {
                    radius += 30;
                    continue;
                }

                const minimumPoint = minBy(distances, "distance")!;

                if (minimumPoint.distance + $hidingRadius * 2 > radius) {
                    radius = minimumPoint.distance + $hidingRadius * 2;
                    continue;
                }

                nearestPoints.push(
                    ...distances
                        .filter(
                            (x) =>
                                x.distance <
                                    minimumPoint.distance + $hidingRadius * 2 &&
                                x.point.properties.name, // If it doesn't have a name, it's not a valid location
                        )
                        .map((x) => x.point),
                );
            }

            if (question.id === "matching") {
                const voronoi = geoSpatialVoronoi(
                    turf.featureCollection(nearestPoints),
                );

                const correctPolygon = voronoi.features.find((feature: any) => {
                    return (
                        feature.properties.site.properties.name ===
                        nearestQuestion.properties.name
                    );
                });

                if (!correctPolygon) {
                    if (question.data.same) {
                        mapData = BLANK_GEOJSON;
                    }

                    continue;
                }

                if (question.data.same) {
                    mapData = safeUnion(
                        turf.featureCollection([
                            ...mapData.features,
                            turf.mask(correctPolygon),
                        ]),
                    );
                } else {
                    mapData = safeUnion(
                        turf.featureCollection([
                            ...mapData.features,
                            correctPolygon,
                        ]),
                    );
                }
            } else {
                const circles = nearestPoints.map((x) =>
                    turf.circle(
                        turf.getCoord(x),
                        nearestQuestion.properties.distanceToPoint,
                        { steps: 256 },
                    ),
                );

                if (question.data.hiderCloser) {
                    mapData = safeUnion(
                        turf.featureCollection([
                            ...mapData.features,
                            holedMask(turf.featureCollection(circles)),
                        ]),
                    );
                } else {
                    mapData = safeUnion(
                        turf.featureCollection([
                            ...mapData.features,
                            ...circles,
                        ]),
                    );
                }
            }
        }
        if (
            question.id === "measuring" &&
            question.data.type === "rail-measure"
        ) {
            const location = turf.point([question.data.lng, question.data.lat]);

            const nearestTrainStation = turf.nearestPoint(
                location,
                turf.featureCollection(
                    stations.map((x) => x.properties.geometry),
                ),
            );

            const distance = turf.distance(location, nearestTrainStation);

            const circles = stations
                .filter(
                    (x) =>
                        turf.distance(
                            station.properties.geometry,
                            x.properties.geometry,
                        ) <
                        distance + 1.61 * $hidingRadius,
                )
                .map((x) =>
                    turf.circle(x.properties.geometry, distance, {
                        // 256 segments → at any practical zoom each segment is well under a
// pixel for a 500m–1km radius, indistinguishable from a true circle.
steps: 256,
                    }),
                );

            if (question.data.hiderCloser) {
                mapData = safeUnion(
                    turf.featureCollection([
                        ...mapData.features,
                        holedMask(turf.featureCollection(circles)),
                    ]),
                );
            } else {
                mapData = safeUnion(
                    turf.featureCollection([...mapData.features, ...circles]),
                );
            }
        }
        if (
            question.id === "measuring" &&
            (question.data.type === "mcdonalds" ||
                question.data.type === "seven11")
        ) {
            const points = await findPlacesSpecificInZone(
                question.data.type === "mcdonalds"
                    ? QuestionSpecificLocation.McDonalds
                    : QuestionSpecificLocation.Seven11,
            );

            const seeker = turf.point([question.data.lng, question.data.lat]);
            const nearest = turf.nearestPoint(seeker, points as any);

            const distance = turf.distance(seeker, nearest, {
                units: "miles",
            });

            const filtered = points.features.filter(
                (x) =>
                    turf.distance(x as any, station.properties.geometry, {
                        units: "miles",
                    }) <
                    distance + $hidingRadius,
            );

            const circles = filtered.map((x) =>
                turf.circle(x as any, distance, {
                    units: "miles",
                    // 256 segments → at any practical zoom each segment is well under a
// pixel for a 500m–1km radius, indistinguishable from a true circle.
steps: 256,
                }),
            );

            if (question.data.hiderCloser) {
                mapData = safeUnion(
                    turf.featureCollection([
                        ...mapData.features,
                        holedMask(turf.featureCollection(circles)),
                    ]),
                );
            } else {
                mapData = safeUnion(
                    turf.featureCollection([...mapData.features, ...circles]),
                );
            }
        }

        if (mapData.type !== "FeatureCollection") {
            mapData = {
                type: "FeatureCollection",
                features: [mapData],
            };
        }
    }

    if (isEqual(mapData, BLANK_GEOJSON)) {
        toast.warning(
            "The hider cannot be in this hiding zone. This wasn't eliminated on the sidebar as its absence was caused by multiple criteria.",
        );
    }

    showGeoJSON(mapData);

    if (autoZoom.get()) {
        // MapShim's fitBounds takes an optional duration (seconds);
        // pass one when animating to match the old flyToBounds feel,
        // and 0 when not.
        map?.fitBounds(bounds, {
            duration: animateMapMovements.get() ? 0.6 : 0,
        });
    }

    const element: HTMLDivElement | null = document.querySelector(
        `[data-station-id="${station.properties.properties.id}"]`,
    );

    if (element) {
        element.scrollIntoView({
            behavior: "smooth",
            block: "center",
        });
        element.classList.add("selected-card-background-temporary");

        setTimeout(() => {
            element.classList.remove("selected-card-background-temporary");
        }, 5000);
    }
}
