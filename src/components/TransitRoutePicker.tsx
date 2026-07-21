import { useStore } from "@nanostores/react";
import { Check, Loader2, MapPin, RefreshCw, Train } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";

import { lastKnownPosition } from "@/lib/context";
import {
    allowedTransit,
    TRANSIT_ICONS,
    type TransitMode,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import {
    fetchTransitRouteDetail,
    findTransitRoutesNear,
    type TransitRouteSummary,
} from "@/maps/api/overpass";
import type { MatchingQuestion } from "@/maps/schema";

/**
 * v966+: the seeker's route picker for the `same-train-line` matching question.
 * Per the rulebook the answer is "yes if the transit the seekers are currently
 * riding would stop at the hider's station" — the app can't detect what you're
 * riding, so the SEEKER picks it.
 *
 * v1073: the picker now
 *   1. GROUPS the raw OSM routes by transit type + line (both directions of
 *      "Tåg 40" collapse to ONE row),
 *   2. gives the line rows a clear selected/active state, and
 *   3. after picking, shows an editable LIST OF STOPS (not a map): every stop
 *      from the seeker's nearest onward is selected by default, and the seeker
 *      can deselect stops their train skips (express) or flip the direction.
 * The SELECTED stops are baked onto `data.transitRoute.stops`, which drives the
 * elimination + the hider's auto-grade. Read-only once the question is sent.
 */

/** Map the game's allowed transit modes → the OSM `route` tag values to query. */
function osmRouteModes(allowed: TransitMode[]): string[] {
    const set = new Set<string>();
    for (const m of allowed) {
        if (m === "subway") set.add("subway"), set.add("monorail");
        else if (m === "train") set.add("train");
        else if (m === "tram") set.add("tram"), set.add("light_rail");
        else if (m === "bus") set.add("bus");
        else if (m === "ferry") set.add("ferry");
    }
    if (set.size === 0) {
        ["subway", "train", "light_rail", "tram", "monorail"].forEach((m) =>
            set.add(m),
        );
    }
    return [...set];
}

/** The transit mode-icon that best matches an OSM `route` value. */
function modeIcon(mode: string) {
    if (mode === "subway" || mode === "monorail") return TRANSIT_ICONS.subway;
    if (mode === "tram" || mode === "light_rail") return TRANSIT_ICONS.tram;
    if (mode === "ferry") return TRANSIT_ICONS.ferry;
    if (mode === "bus") return TRANSIT_ICONS.bus;
    return TRANSIT_ICONS.train;
}

/** Straight-line metres between two lat/lng points. */
function haversineM(
    aLat: number,
    aLng: number,
    bLat: number,
    bLng: number,
): number {
    const R = 6371000;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLng = ((bLng - aLng) * Math.PI) / 180;
    const la1 = (aLat * Math.PI) / 180;
    const la2 = (bLat * Math.PI) / 180;
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The line label = the route name with any ": A - B" direction stripped. */
function lineLabel(name: string): string {
    const colon = name.split(":")[0]?.trim();
    if (colon && colon.length >= 2) return colon;
    return name;
}

/** A group of directional route variants that are the SAME transit line. */
type TransitLine = {
    key: string;
    label: string;
    mode: string;
    /** All member route ids (directions/variants); picking fetches the first. */
    memberIds: string[];
};

/** Group raw route summaries by transit type + line (ref, else name prefix). */
function groupLines(routes: TransitRouteSummary[]): TransitLine[] {
    const byKey = new Map<string, TransitLine>();
    for (const r of routes) {
        const lineKey = r.ref?.trim() || lineLabel(r.name).toLowerCase();
        const key = `${r.mode}::${lineKey}`;
        const existing = byKey.get(key);
        if (existing) {
            existing.memberIds.push(r.id);
        } else {
            byKey.set(key, {
                key,
                label: lineLabel(r.name),
                mode: r.mode,
                memberIds: [r.id],
            });
        }
    }
    return [...byKey.values()];
}

type PickedLine = {
    key: string;
    /** The OSM route id whose stops we loaded (for `transitRoute.id`). */
    memberKeyId: string;
    label: string;
    mode: string;
    stops: { lat: number; lng: number; name?: string }[];
    /** Index of the seeker's nearest stop (or -1 if unknown). */
    nearestIdx: number;
    /** Selected stop indices (the answer set). */
    selected: Set<number>;
};

export function TransitRoutePicker({
    data,
    onChange,
    disabled = false,
}: {
    data: MatchingQuestion;
    onChange: () => void;
    disabled?: boolean;
}) {
    const $allowed = useStore(allowedTransit);
    const $gps = useStore(lastKnownPosition);

    const [routes, setRoutes] = useState<TransitRouteSummary[] | null>(null);
    const [loadingList, setLoadingList] = useState(false);
    const [pickingKey, setPickingKey] = useState<string | null>(null);
    const [pickedLine, setPickedLine] = useState<PickedLine | null>(null);

    const lines = useMemo(
        () => (routes ? groupLines(routes) : null),
        [routes],
    );

    // Whether the question already carries a picked route (sent / re-mounted).
    const savedRoute = data.transitRoute ?? null;

    const loadRoutes = async () => {
        const pos = $gps ?? lastKnownPosition.get();
        if (!pos) {
            toast.error("Waiting for your location to find nearby routes.");
            return;
        }
        setLoadingList(true);
        try {
            const found = await findTransitRoutesNear(
                pos.lat,
                pos.lng,
                osmRouteModes($allowed),
            );
            setRoutes(found);
            if (found.length === 0)
                toast.info(
                    "No transit routes found near you — move onto the line you're riding and refresh.",
                );
        } catch {
            toast.error("Couldn't load nearby routes. Try again.");
        } finally {
            setLoadingList(false);
        }
    };

    // Load the route list once on first mount (editable path only, has a fix).
    const loadedRef = useRef(false);
    useEffect(() => {
        if (disabled || savedRoute || pickedLine || loadedRef.current) return;
        const pos = $gps ?? lastKnownPosition.get();
        if (!pos) return;
        loadedRef.current = true;
        void loadRoutes();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$gps, disabled, savedRoute, pickedLine]);

    // Write the current selection to the question (the answer set).
    const commitSelection = (line: PickedLine) => {
        const selected = [...line.selected]
            .sort((a, b) => a - b)
            .map((i) => line.stops[i])
            .filter(Boolean);
        data.transitRoute = {
            id: line.memberKeyId,
            name: line.label,
            mode: line.mode,
            stops: selected,
        };
        onChange();
    };

    const pickLine = async (line: TransitLine) => {
        setPickingKey(line.key);
        try {
            const detail = await fetchTransitRouteDetail(line.memberIds[0]);
            if (detail.stops.length === 0) {
                toast.error(
                    "That line has no mapped stops — pick another line.",
                );
                return;
            }
            const stops = detail.stops.map((s) => ({
                lat: s.lat,
                lng: s.lng,
                name: s.name,
            }));
            const pos = $gps ?? lastKnownPosition.get();
            let nearestIdx = -1;
            if (pos) {
                let best = Infinity;
                stops.forEach((s, i) => {
                    const d = haversineM(pos.lat, pos.lng, s.lat, s.lng);
                    if (d < best) {
                        best = d;
                        nearestIdx = i;
                    }
                });
            }
            // Default: the nearest stop + every stop AFTER it (in list order).
            // No fix → select every stop (a normal train stops everywhere).
            const selected = new Set<number>();
            const from = nearestIdx >= 0 ? nearestIdx : 0;
            for (let i = from; i < stops.length; i++) selected.add(i);
            const line2: PickedLine = {
                key: line.key,
                memberKeyId: line.memberIds[0],
                label: line.label,
                mode: line.mode,
                stops,
                nearestIdx,
                selected,
            };
            setPickedLine(line2);
            commitSelection(line2);
        } catch {
            toast.error("Couldn't load that line's stops. Try again.");
        } finally {
            setPickingKey(null);
        }
    };

    const toggleStop = (idx: number) => {
        setPickedLine((prev) => {
            if (!prev) return prev;
            const selected = new Set(prev.selected);
            if (selected.has(idx)) selected.delete(idx);
            else selected.add(idx);
            const next = { ...prev, selected };
            commitSelection(next);
            return next;
        });
    };

    const setAll = (on: boolean) => {
        setPickedLine((prev) => {
            if (!prev) return prev;
            const selected = new Set<number>();
            if (on) prev.stops.forEach((_, i) => selected.add(i));
            const next = { ...prev, selected };
            commitSelection(next);
            return next;
        });
    };

    /** Flip the default direction: select the nearest + everything BEFORE it. */
    const flipDirection = () => {
        setPickedLine((prev) => {
            if (!prev || prev.nearestIdx < 0) return prev;
            const selected = new Set<number>();
            const hasAfter = prev.selected.has(prev.nearestIdx + 1);
            if (hasAfter) {
                for (let i = 0; i <= prev.nearestIdx; i++) selected.add(i);
            } else {
                for (let i = prev.nearestIdx; i < prev.stops.length; i++)
                    selected.add(i);
            }
            const next = { ...prev, selected };
            commitSelection(next);
            return next;
        });
    };

    const changeLine = () => {
        setPickedLine(null);
        data.transitRoute = undefined;
        onChange();
        if (!routes) void loadRoutes();
    };

    // ── Picked (active editing): the stop checklist ──
    if (pickedLine) {
        const Icon = modeIcon(pickedLine.mode);
        const count = pickedLine.selected.size;
        return (
            <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-md border-2 border-primary bg-primary/10 p-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                            {pickedLine.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {count} of {pickedLine.stops.length} stops selected
                        </div>
                    </div>
                    {!disabled && (
                        <button
                            type="button"
                            onClick={changeLine}
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/15"
                        >
                            Change
                        </button>
                    )}
                </div>

                <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                        Deselect any stops your train skips.
                    </span>
                    <div className="flex items-center gap-1.5">
                        {pickedLine.nearestIdx >= 0 && (
                            <button
                                type="button"
                                onClick={flipDirection}
                                className="rounded-md px-2 py-1 font-semibold text-primary hover:bg-primary/10"
                            >
                                Flip direction
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setAll(count < pickedLine.stops.length)}
                            className="rounded-md px-2 py-1 font-semibold text-primary hover:bg-primary/10"
                        >
                            {count < pickedLine.stops.length
                                ? "All"
                                : "None"}
                        </button>
                    </div>
                </div>

                <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                    {pickedLine.stops.map((s, i) => {
                        const on = pickedLine.selected.has(i);
                        const isNearest = i === pickedLine.nearestIdx;
                        return (
                            <button
                                key={`${i}-${s.name ?? ""}`}
                                type="button"
                                onClick={() => toggleStop(i)}
                                className={cn(
                                    "flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                                    on
                                        ? "border-primary/60 bg-primary/10"
                                        : "border-border bg-secondary/40 opacity-60",
                                )}
                            >
                                <span
                                    className={cn(
                                        "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                                        on
                                            ? "border-primary bg-primary text-primary-foreground"
                                            : "border-muted-foreground/40",
                                    )}
                                >
                                    {on && <Check className="h-3.5 w-3.5" />}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-sm">
                                    {s.name ?? `Stop ${i + 1}`}
                                </span>
                                {isNearest && (
                                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                        <MapPin className="h-3 w-3" />
                                        You
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                    The hider answers &quot;yes&quot; if their station is one of
                    the selected stops.
                </p>
            </div>
        );
    }

    // ── Saved route (sent / read-only) — a compact stop list, no map ──
    if (savedRoute) {
        const Icon = modeIcon(savedRoute.mode);
        return (
            <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-md border-2 border-primary bg-primary/10 p-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                            {savedRoute.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {savedRoute.stops.length} stops · you&apos;re riding
                            this
                        </div>
                    </div>
                    {!disabled && (
                        <button
                            type="button"
                            onClick={changeLine}
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/15"
                        >
                            Change
                        </button>
                    )}
                </div>
                <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                    {savedRoute.stops.map((s, i) => (
                        <div
                            key={`${i}-${s.name ?? ""}`}
                            className="flex items-center gap-2.5 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-sm"
                        >
                            <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                            <span className="min-w-0 flex-1 truncate">
                                {s.name ?? `Stop ${i + 1}`}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // ── Not picked yet: the grouped line list ──
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                    Pick the transit line you&apos;re riding right now:
                </p>
                <button
                    type="button"
                    onClick={() => void loadRoutes()}
                    disabled={loadingList}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                    {loadingList ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Refresh
                </button>
            </div>
            {loadingList && lines === null ? (
                <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border/60 py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Finding lines near you…
                </div>
            ) : lines && lines.length > 0 ? (
                <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                    {lines.map((line) => {
                        const Icon = modeIcon(line.mode);
                        const busy = pickingKey === line.key;
                        return (
                            <button
                                key={line.key}
                                type="button"
                                onClick={() => void pickLine(line)}
                                disabled={pickingKey !== null}
                                className={cn(
                                    "flex w-full items-center gap-2.5 rounded-md border-2 p-2.5 text-left transition-all",
                                    "active:scale-[0.99] disabled:opacity-60",
                                    busy
                                        ? "border-primary bg-primary/10"
                                        : "border-border bg-secondary hover:bg-accent",
                                )}
                            >
                                <span
                                    className={cn(
                                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                                        busy
                                            ? "bg-primary text-primary-foreground"
                                            : "bg-background/70 text-muted-foreground",
                                    )}
                                >
                                    <Icon className="h-5 w-5" />
                                </span>
                                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                    {line.label}
                                </span>
                                {busy && (
                                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                                )}
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border/60 py-6 text-center text-sm text-muted-foreground">
                    <Train className="h-5 w-5" />
                    <span>No lines found near you.</span>
                    <span className="text-xs">
                        Board the line you&apos;re riding, then Refresh.
                    </span>
                </div>
            )}
        </div>
    );
}

export default TransitRoutePicker;
