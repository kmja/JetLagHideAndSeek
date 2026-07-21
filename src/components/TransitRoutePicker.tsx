import { useStore } from "@nanostores/react";
import {
    ArrowLeft,
    ArrowUp,
    ArrowUpDown,
    Check,
    ChevronDown,
    Loader2,
    RefreshCw,
    Train,
} from "lucide-react";
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

/** Compass bearing (degrees) from A to B. */
function bearing(
    aLat: number,
    aLng: number,
    bLat: number,
    bLng: number,
): number {
    const φ1 = (aLat * Math.PI) / 180;
    const φ2 = (bLat * Math.PI) / 180;
    const Δλ = ((bLng - aLng) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
        Math.cos(φ1) * Math.sin(φ2) -
        Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Smallest absolute difference between two compass bearings (degrees). */
function bearingDiff(a: number, b: number): number {
    const d = Math.abs((((a - b) % 360) + 360) % 360);
    return d > 180 ? 360 - d : d;
}

/** Best-effort device travel heading (degrees 0..360) from a one-shot GPS
 *  read — null when unavailable / stationary (heading is only reported while
 *  moving). Never rejects; bounded to ~2.5 s so it can't stall the pick. */
function currentHeadingSafe(): Promise<number | null> {
    return new Promise((resolve) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            resolve(null);
            return;
        }
        let done = false;
        const finish = (v: number | null) => {
            if (done) return;
            done = true;
            resolve(v);
        };
        const t = setTimeout(() => finish(null), 2500);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                clearTimeout(t);
                const h = pos.coords.heading;
                finish(
                    typeof h === "number" && Number.isFinite(h) ? h : null,
                );
            },
            () => {
                clearTimeout(t);
                finish(null);
            },
            { enableHighAccuracy: true, timeout: 2000, maximumAge: 5000 },
        );
    });
}

const COMPASS_ABBR = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** A short cardinal abbreviation ("N", "SE", …) for a bearing in degrees. */
function compassAbbr(deg: number): string {
    const i = Math.round(((deg % 360) + 360) / 45) % 8;
    return COMPASS_ABBR[i];
}

/** The line label = the route name with any ": A - B" direction stripped. */
function lineLabel(name: string): string {
    const colon = name.split(":")[0]?.trim();
    if (colon && colon.length >= 2) return colon;
    return name;
}

/** The two terminus names from a route name, e.g. "Tåg 40: A - B" → [A, B]. */
function parseEndpoints(name: string): [string, string] | null {
    const after = name.includes(":")
        ? name.split(":").slice(1).join(":").trim()
        : name;
    const parts = after.split(/\s[–—-]\s/).map((p) => p.trim());
    if (parts.length >= 2 && parts[0] && parts[parts.length - 1]) {
        return [parts[0], parts[parts.length - 1]];
    }
    return null;
}

/** A group of directional route variants that are the SAME transit line. */
type TransitLine = {
    key: string;
    label: string;
    mode: string;
    /** The two terminus names, if parseable, for the row subtitle. */
    endpoints?: [string, string];
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
            if (!existing.endpoints) existing.endpoints = parseEndpoints(r.name) ?? undefined;
        } else {
            byKey.set(key, {
                key,
                label: lineLabel(r.name),
                mode: r.mode,
                endpoints: parseEndpoints(r.name) ?? undefined,
                memberIds: [r.id],
            });
        }
    }
    return [...byKey.values()];
}

/** Transit-type accordion sections, in display order. */
const MODE_SECTIONS: { key: string; label: string; modes: string[] }[] = [
    { key: "train", label: "Train", modes: ["train"] },
    { key: "subway", label: "Metro", modes: ["subway", "monorail"] },
    { key: "tram", label: "Tram / light rail", modes: ["tram", "light_rail"] },
    { key: "bus", label: "Bus", modes: ["bus"] },
    { key: "ferry", label: "Ferry", modes: ["ferry"] },
];

type PickedLine = {
    key: string;
    /** The OSM route id whose stops we loaded (for `transitRoute.id`). */
    memberKeyId: string;
    label: string;
    mode: string;
    stops: { lat: number; lng: number; name?: string }[];
    /** Index of the seeker's nearest stop (or -1 if unknown). */
    nearestIdx: number;
    /** Direction of travel: true = toward the END of the stop list (higher
     *  index), false = toward the START. Drives the "toward <terminus>" label. */
    forward: boolean;
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
            // Read the device heading IN PARALLEL with the route fetch (usually
            // slower), so estimating the travel direction adds no latency.
            const [detail, heading] = await Promise.all([
                fetchTransitRouteDetail(line.memberIds[0]),
                currentHeadingSafe(),
            ]);
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
            // v1083: default the travel direction from the device heading (if
            // moving) — pick the terminus whose bearing from the nearest stop
            // is closest to where the seeker is actually heading. Falls back to
            // `forward` (toward the end of the list) when there's no heading.
            let forward = true;
            if (nearestIdx >= 0 && heading != null && stops.length >= 2) {
                const near = stops[nearestIdx];
                const endTerm = stops[stops.length - 1];
                const startTerm = stops[0];
                const bFwd = bearing(
                    near.lat,
                    near.lng,
                    endTerm.lat,
                    endTerm.lng,
                );
                const bBwd = bearing(
                    near.lat,
                    near.lng,
                    startTerm.lat,
                    startTerm.lng,
                );
                forward = bearingDiff(heading, bFwd) <= bearingDiff(heading, bBwd);
            }
            // Default: the nearest stop + every stop AHEAD of it in the chosen
            // direction. No fix → select every stop (a normal train stops
            // everywhere).
            const selected = new Set<number>();
            if (nearestIdx >= 0) {
                if (forward)
                    for (let i = nearestIdx; i < stops.length; i++)
                        selected.add(i);
                else for (let i = 0; i <= nearestIdx; i++) selected.add(i);
            } else {
                for (let i = 0; i < stops.length; i++) selected.add(i);
            }
            const line2: PickedLine = {
                key: line.key,
                memberKeyId: line.memberIds[0],
                label: line.label,
                mode: line.mode,
                stops,
                nearestIdx,
                forward,
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

    /** Flip travel direction: re-select the nearest + everything on the other
     *  side of it, and flip the `forward` flag (drives the "toward …" label). */
    const flipDirection = () => {
        setPickedLine((prev) => {
            if (!prev || prev.nearestIdx < 0) return prev;
            const forward = !prev.forward;
            const selected = new Set<number>();
            if (forward) {
                for (let i = prev.nearestIdx; i < prev.stops.length; i++)
                    selected.add(i);
            } else {
                for (let i = 0; i <= prev.nearestIdx; i++) selected.add(i);
            }
            const next = { ...prev, forward, selected };
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
        // The terminus the current travel direction heads toward + its compass
        // word, for a clear "north toward Uppsala" direction button.
        const targetIdx = pickedLine.forward ? pickedLine.stops.length - 1 : 0;
        const target = pickedLine.stops[targetIdx];
        const nearest =
            pickedLine.nearestIdx >= 0
                ? pickedLine.stops[pickedLine.nearestIdx]
                : null;
        const hasDir = !!(nearest && target);
        const dirBearing = hasDir
            ? bearing(nearest!.lat, nearest!.lng, target.lat, target.lng)
            : 0;
        const dirAbbr = hasDir ? compassAbbr(dirBearing) : null;

        // v1081: order the stops in travel direction (nearest near the top,
        // travelling downward). Show only the TWO most-recent stops BEHIND the
        // nearest (as compact, disabled context) — anything further back is
        // hidden. The nearest onward are the interactive answer set.
        const displayOrder =
            pickedLine.forward
                ? pickedLine.stops.map((_, i) => i)
                : pickedLine.stops.map((_, i) => pickedLine.stops.length - 1 - i);
        const nearestPos =
            pickedLine.nearestIdx >= 0
                ? displayOrder.indexOf(pickedLine.nearestIdx)
                : 0;
        const earlierStart = Math.max(0, nearestPos - 2);
        const shown = displayOrder.slice(earlierStart);

        return (
            <div className="space-y-3">
                {/* v1081: the picked line is a SUBPAGE — a back arrow returns to
                    the line list; the header is a plain identity row (not a
                    selected-looking card). */}
                <div className="flex items-center gap-2.5">
                    {!disabled && (
                        <button
                            type="button"
                            onClick={changeLine}
                            aria-label="Back to lines"
                            title="Back to lines"
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-foreground transition-colors hover:bg-accent"
                        >
                            <ArrowLeft className="h-5 w-5" />
                        </button>
                    )}
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-semibold">
                            {pickedLine.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {count} of {pickedLine.stops.length} stops selected
                        </div>
                    </div>
                </div>

                {/* Direction filter — a compass badge (arrow + cardinal abbr)
                    as a clearly-separate display element, the "Toward <end>"
                    label, and a neutral icon-only reverse button. */}
                {hasDir && (
                    <div className="flex items-center gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
                        <div className="flex w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border border-border bg-background py-1">
                            <ArrowUp
                                className="h-4 w-4 text-foreground"
                                style={{
                                    transform: `rotate(${dirBearing}deg)`,
                                }}
                            />
                            <span className="text-[10px] font-bold uppercase leading-none text-muted-foreground">
                                {dirAbbr}
                            </span>
                        </div>
                        <span className="min-w-0 flex-1">
                            <span className="text-muted-foreground">
                                Toward{" "}
                            </span>
                            <span className="font-semibold">
                                {target.name ?? "the end"}
                            </span>
                        </span>
                        <button
                            type="button"
                            onClick={flipDirection}
                            aria-label="Reverse direction"
                            title="Reverse direction"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                            <ArrowUpDown className="h-4 w-4" />
                        </button>
                    </div>
                )}

                {/* Stop timeline — a connecting line down the checkbox rail so
                    the sequence reads as one line. The two stops BEHIND the
                    nearest are shown compact + disabled (context only); the
                    nearest onward are the interactive answer set. */}
                <div className="max-h-[22rem] space-y-0 overflow-y-auto pr-1">
                    {shown.map((i, pos) => {
                        const s = pickedLine.stops[i];
                        const on = pickedLine.selected.has(i);
                        const isNearest = i === pickedLine.nearestIdx;
                        const isEarlier = earlierStart + pos < nearestPos;
                        const isFirst = pos === 0;
                        const isLast = pos === shown.length - 1;
                        const label = s.name ?? `Stop ${i + 1}`;
                        if (isEarlier) {
                            // Compact, disabled context row (smaller checkbox).
                            return (
                                <div
                                    key={`${i}-${s.name ?? ""}`}
                                    className="flex w-full items-stretch gap-3 py-1.5 pl-1 pr-2 opacity-40"
                                >
                                    <span className="relative flex w-7 shrink-0 items-center justify-center self-stretch">
                                        {!isFirst && (
                                            <span className="absolute left-1/2 top-0 h-1/2 -translate-x-1/2 border-l-2 border-dashed border-muted-foreground/50" />
                                        )}
                                        <span className="absolute bottom-0 left-1/2 h-1/2 -translate-x-1/2 border-l-2 border-dashed border-muted-foreground/50" />
                                        <span className="relative z-10 h-3.5 w-3.5 shrink-0 rounded-sm border border-muted-foreground/50 bg-background" />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate py-0.5 text-sm">
                                        {label}
                                    </span>
                                </div>
                            );
                        }
                        return (
                            <button
                                key={`${i}-${s.name ?? ""}`}
                                type="button"
                                onClick={() => toggleStop(i)}
                                className={cn(
                                    "flex w-full items-stretch gap-3 rounded-md py-2.5 pl-1 pr-2 text-left transition-colors hover:bg-accent/60",
                                    !on && "opacity-55",
                                )}
                            >
                                {/* rail column: dashed connecting line + node */}
                                <span className="relative flex w-7 shrink-0 items-center justify-center self-stretch">
                                    {!isFirst && (
                                        <span className="absolute left-1/2 top-0 h-1/2 -translate-x-1/2 border-l-2 border-dashed border-muted-foreground/50" />
                                    )}
                                    {!isLast && (
                                        <span className="absolute bottom-0 left-1/2 h-1/2 -translate-x-1/2 border-l-2 border-dashed border-muted-foreground/50" />
                                    )}
                                    <span
                                        className={cn(
                                            "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2",
                                            on
                                                ? "border-primary bg-primary text-primary-foreground"
                                                : "border-muted-foreground/50 bg-background",
                                        )}
                                    >
                                        {on && <Check className="h-4 w-4" />}
                                    </span>
                                </span>
                                <span className="flex min-w-0 flex-1 items-center gap-2 py-0.5">
                                    <span className="min-w-0 truncate text-base">
                                        {label}
                                    </span>
                                    {isNearest && (
                                        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-[#2A81CB]">
                                            <span
                                                aria-hidden
                                                className="inline-block h-2.5 w-2.5 rounded-full border border-white bg-[#2A81CB]"
                                                style={{
                                                    boxShadow:
                                                        "0 0 0 1px #2A81CB",
                                                }}
                                            />
                                            You
                                        </span>
                                    )}
                                </span>
                            </button>
                        );
                    })}
                </div>
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
            {/* v1078: the "Pick the line…" header + Refresh only show once
                there ARE lines. While loading, only the "Finding lines…"
                placeholder is shown (no premature Pick prompt / disabled
                Refresh). */}
            {lines && lines.length > 0 && (
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
            )}
            {loadingList && lines === null ? (
                <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border/60 py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Finding lines near you…
                </div>
            ) : lines && lines.length > 0 ? (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                    {MODE_SECTIONS.map((section) => {
                        const sectionLines = lines.filter((l) =>
                            section.modes.includes(l.mode),
                        );
                        if (sectionLines.length === 0) return null;
                        return (
                            <details
                                key={section.key}
                                open
                                className="group/sec rounded-md border border-border bg-secondary/30"
                            >
                                <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                                    <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open/sec:rotate-0 -rotate-90" />
                                    {section.label}
                                    <span className="ml-auto text-[10px] font-semibold normal-case tracking-normal opacity-70">
                                        {sectionLines.length}
                                    </span>
                                </summary>
                                <div className="space-y-1.5 p-1.5 pt-0">
                                    {sectionLines.map((line) => {
                                        const Icon = modeIcon(line.mode);
                                        const busy = pickingKey === line.key;
                                        return (
                                            <button
                                                key={line.key}
                                                type="button"
                                                onClick={() =>
                                                    void pickLine(line)
                                                }
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
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-medium">
                                                        {line.label}
                                                    </span>
                                                    {line.endpoints && (
                                                        <span className="block truncate text-xs text-muted-foreground">
                                                            {line.endpoints[0]} –{" "}
                                                            {line.endpoints[1]}
                                                        </span>
                                                    )}
                                                </span>
                                                {busy && (
                                                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </details>
                        );
                    })}
                </div>
            ) : (
                <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border/60 py-6 text-center text-sm text-muted-foreground">
                    <Train className="h-5 w-5" />
                    <span>No lines found near you.</span>
                    <span className="text-xs">
                        Board the line you&apos;re riding, then refresh.
                    </span>
                    <button
                        type="button"
                        onClick={() => void loadRoutes()}
                        disabled={loadingList}
                        className="mt-1 flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
                    >
                        {loadingList ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Refresh
                    </button>
                </div>
            )}
        </div>
    );
}

export default TransitRoutePicker;
