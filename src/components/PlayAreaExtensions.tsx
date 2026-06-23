import { useStore } from "@nanostores/react";
import {
    Check,
    ChevronDown,
    ChevronUp,
    Loader2,
    Minus,
    PlusCircle,
    Sparkles,
    TrainTrack,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
    additionalMapGeoLocations,
    adjacentCandidatePreview,
    toggleAdjacentArea,
} from "@/lib/context";
import { allowedTransit } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import {
    type AdjacentAreaCandidate,
    findExtensionCandidates,
} from "@/maps/api/playAreaExtensions";
import type { OpenStreetMap } from "@/maps/api/types";

/**
 * "Extend with neighbouring areas" picker, shown after the user
 * selects a primary play area in step 1 of the setup wizard.
 *
 * Why this exists: Stockholm Municipality (the OSM admin relation
 * matching "Stockholm") legally excludes Solna, Sundbyberg,
 * Danderyd, Järfälla, Huddinge, etc. — but those are tightly
 * integrated via the city's subway / commuter-rail network, and a
 * Jet Lag player almost always wants them included. Same pattern
 * for Manhattan (vs. the rest of NYC), Paris (vs. Île-de-France
 * metro), Berlin (mostly fine, but with Potsdam/Brandenburg
 * caveats), Tokyo (the 23 wards excluding the western tama area)
 * etc.
 *
 * We fetch admin regions at the primary's admin level within
 * ~25 km and pre-check the ones that contain a station of an
 * allowed transit mode. The user can deselect any they don't
 * want, or add others manually from the resulting list.
 */
export function PlayAreaExtensions({
    primary,
}: {
    primary: OpenStreetMap;
}) {
    const $allowedTransit = useStore(allowedTransit);
    const $additional = useStore(additionalMapGeoLocations);

    const [open, setOpen] = useState(true);
    const [candidates, setCandidates] = useState<AdjacentAreaCandidate[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Tracks the primary we've fetched for, so swapping primary
     *  triggers a refresh. */
    const fetchedForRef = useRef<number | null>(null);

    // Derive `checked` from the canonical store. The map "+/✓" pill
    // and the in-dialog row both write through `toggleAdjacentArea`,
    // so this stays in sync without an extra state hop.
    const checked = new Set<number>(
        $additional
            .map(
                (e) =>
                    (e.location?.properties as { osm_id?: number } | undefined)
                        ?.osm_id,
            )
            .filter((v): v is number => typeof v === "number"),
    );

    useEffect(() => {
        const primaryId = primary.properties.osm_id;
        if (fetchedForRef.current === primaryId) return;
        fetchedForRef.current = primaryId;

        // Always clear stale extensions when the primary changes —
        // the previously-added "neighbours" almost certainly don't
        // belong to the new primary.
        additionalMapGeoLocations.set([]);
        setCandidates([]);
        setError(null);
        setLoading(true);

        let cancelled = false;
        findExtensionCandidates(primary, $allowedTransit, {
            radiusKm: 25,
            limit: 14,
        })
            .then((c) => {
                if (cancelled) return;
                setCandidates(c);
                // Pre-add transit-connected candidates directly into
                // additionalMapGeoLocations — that's the canonical
                // source of truth `checked` derives from above.
                const pre = c
                    .filter((cand) => cand.hasMatchingTransit)
                    .map((cand) => ({
                        location: cand.feature,
                        added: true,
                        base: false,
                    }));
                additionalMapGeoLocations.set(pre);
            })
            .catch((e) => {
                if (cancelled) return;
                console.warn("Extension lookup failed", e);
                setError(
                    "Couldn't fetch nearby areas. Try again or pick manually below.",
                );
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [primary.properties.osm_id, $allowedTransit.join(",")]);

    // Publish a compact preview of the candidates for the play-area
    // preview map's "+/✓" overlay. Cleared on unmount or when there
    // are no candidates.
    useEffect(() => {
        if (candidates.length === 0) {
            adjacentCandidatePreview.set(null);
            return;
        }
        adjacentCandidatePreview.set({
            candidates: candidates.map((c) => ({
                osmId: c.feature.properties.osm_id,
                name: c.feature.properties.name as string,
                bbox: c.feature.properties.extent as [
                    number,
                    number,
                    number,
                    number,
                ],
                hasMatchingTransit: c.hasMatchingTransit,
                feature: c.feature,
            })),
        });
        return () => {
            adjacentCandidatePreview.set(null);
        };
    }, [candidates]);

    if (!loading && candidates.length === 0 && !error) {
        // No siblings found — primary is in a region without
        // adjacent admin regions of the same level (e.g. a country
        // pick). Hide the picker entirely.
        return null;
    }

    const checkedCount = checked.size;
    const allChecked =
        candidates.length > 0 &&
        candidates.every((c) => checked.has(c.feature.properties.osm_id));
    const someChecked = checkedCount > 0 && !allChecked;
    const toggleAll = () => {
        if (allChecked) {
            additionalMapGeoLocations.set([]);
            return;
        }
        additionalMapGeoLocations.set(
            candidates.map((c) => ({
                location: c.feature,
                added: true,
                base: false,
            })),
        );
    };

    return (
        <div className="mt-3 rounded-md border border-dashed border-border bg-secondary/20 p-3 space-y-2.5">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    "w-full flex items-center gap-2 text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
                )}
            >
                <Sparkles className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-poppins font-bold uppercase tracking-wider">
                        Extend with neighbouring areas
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                        {loading
                            ? "Scanning the area for transit-connected neighbours…"
                            : error
                              ? error
                              : `${checkedCount} of ${candidates.length} added — uncheck the ones you don't want.`}
                    </div>
                </div>
                {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
                ) : open ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                )}
            </button>

            {open && !loading && candidates.length > 0 && (
                <ul className="space-y-1">
                    {/* Master toggle — select / deselect every neighbour
                        at once. Shows a filled check when all are on, a
                        dash when only some are. */}
                    <li>
                        <button
                            type="button"
                            onClick={toggleAll}
                            aria-pressed={allChecked}
                            className={cn(
                                "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm",
                                "text-left transition-colors mb-1 border-b border-border/40",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                "hover:bg-accent",
                            )}
                        >
                            <div
                                className={cn(
                                    "w-4 h-4 rounded-sm border-2 shrink-0 flex items-center justify-center",
                                    allChecked || someChecked
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border",
                                )}
                                aria-hidden="true"
                            >
                                {allChecked ? (
                                    <Check className="w-3 h-3" />
                                ) : someChecked ? (
                                    <Minus className="w-3 h-3" />
                                ) : null}
                            </div>
                            <span className="flex-1 text-sm font-poppins font-semibold">
                                {allChecked ? "Deselect all" : "Select all"}
                            </span>
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                                {checkedCount}/{candidates.length}
                            </span>
                        </button>
                    </li>
                    {candidates.map((c) => {
                        const id = c.feature.properties.osm_id;
                        const isChecked = checked.has(id);
                        return (
                            <li key={id}>
                                <button
                                    type="button"
                                    onClick={() => toggleAdjacentArea(id)}
                                    aria-pressed={isChecked}
                                    className={cn(
                                        "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm",
                                        "text-left transition-colors",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        isChecked
                                            ? "bg-primary/10 border border-primary/30"
                                            : "bg-secondary/40 border border-border hover:bg-accent",
                                    )}
                                >
                                    <div
                                        className={cn(
                                            "w-4 h-4 rounded-sm border-2 shrink-0 flex items-center justify-center",
                                            isChecked
                                                ? "border-primary bg-primary text-primary-foreground"
                                                : "border-border",
                                        )}
                                        aria-hidden="true"
                                    >
                                        {isChecked && (
                                            <Check className="w-3 h-3" />
                                        )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium truncate">
                                            {c.feature.properties.name}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground tabular-nums">
                                            {formatDistance(c.distanceKm)} ·{" "}
                                            {formatArea(c.estimatedAreaKm2)}
                                        </div>
                                    </div>
                                    {c.hasMatchingTransit && (
                                        <span
                                            className={cn(
                                                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm",
                                                "text-[9px] uppercase tracking-wider font-poppins font-bold",
                                                "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
                                            )}
                                            title="Contains a transit station served by your allowed modes"
                                        >
                                            <TrainTrack className="w-3 h-3" />
                                            Transit
                                        </span>
                                    )}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            {open && !loading && candidates.length > 0 && (
                <p className="text-[10px] text-muted-foreground leading-snug pt-1 border-t border-border/40">
                    <PlusCircle className="w-3 h-3 inline -mt-0.5 mr-1" />
                    These are admin areas at the same level as{" "}
                    <span className="font-semibold">
                        {primary.properties.name}
                    </span>{" "}
                    within 25 km. Pre-checked ones contain a station of one of
                    your allowed transit modes ({transitSummary($allowedTransit)}
                    ). You can change the allowed modes in the next step.
                    {$additional.length > 0 && (
                        <>
                            {" "}
                            Total selected: {1 + checked.size} area
                            {checked.size === 0 ? "" : "s"}.
                        </>
                    )}
                </p>
            )}
        </div>
    );
}

function transitSummary(modes: string[]): string {
    if (modes.length === 0) return "none — walking only";
    if (modes.length === 1) return modes[0];
    if (modes.length === 2) return `${modes[0]} and ${modes[1]}`;
    return `${modes.slice(0, -1).join(", ")}, and ${modes[modes.length - 1]}`;
}

function formatDistance(km: number): string {
    if (km < 1) return `${Math.round(km * 1000)} m away`;
    if (km < 10) return `${km.toFixed(1)} km away`;
    return `${Math.round(km)} km away`;
}

function formatArea(km2: number): string {
    if (km2 < 1) return `<1 km²`;
    if (km2 < 100) return `~${Math.round(km2)} km²`;
    if (km2 < 1000) return `~${Math.round(km2 / 10) * 10} km²`;
    return `~${(Math.round(km2 / 100) * 100).toLocaleString("en-US")} km²`;
}

export default PlayAreaExtensions;
