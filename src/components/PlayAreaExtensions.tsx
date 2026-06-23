import { useStore } from "@nanostores/react";
import { Loader2, MapPin, Sparkles, TrainTrack } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    additionalMapGeoLocations,
    adjacentCandidatePreview,
} from "@/lib/context";
import { allowedTransit } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import {
    type AdjacentAreaCandidate,
    findExtensionCandidates,
} from "@/maps/api/playAreaExtensions";
import type { OpenStreetMap } from "@/maps/api/types";

/**
 * "Extend with neighbouring areas" controller, shown under the
 * play-area preview map in step 1 of the setup wizard.
 *
 * Why this exists: Stockholm Municipality (the OSM admin relation
 * matching "Stockholm") legally excludes Solna, Sundbyberg,
 * Danderyd, Järfälla, etc. — but those are tightly integrated via
 * the city's subway / commuter-rail network, and a Jet Lag player
 * almost always wants them included. Same pattern for NYC and its
 * boroughs (Manhattan + Brooklyn + …), Paris vs. the Île-de-France
 * metro, and so on.
 *
 * v438: the picker is now MAP-FIRST. This component no longer renders
 * a checklist — instead it fetches the candidate set, pre-adds the
 * transit-connected ones, and publishes them to
 * `adjacentCandidatePreview` so `PlayAreaPreviewMap` can paint a
 * tappable "+/✓" pill at each one. All this component renders is a
 * compact status caption plus Select-all / Clear shortcuts. The
 * canonical "is this area added?" state lives in
 * `additionalMapGeoLocations`, written by the map pills directly.
 */
export function PlayAreaExtensions({
    primary,
    ready = true,
}: {
    primary: OpenStreetMap;
    /** Hold the candidate fetch until the preview map has painted the
     *  main play area, so the boundary-polygon request wins the worker
     *  first. The lookup then runs in the background and the pills are
     *  ready by the time the user taps "Add nearby areas". */
    ready?: boolean;
}) {
    const $allowedTransit = useStore(allowedTransit);
    const $additional = useStore(additionalMapGeoLocations);

    const [candidates, setCandidates] = useState<AdjacentAreaCandidate[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The pills only paint once the user opts in via "Add nearby areas".
    // Until then the map shows just the main play area (fast first
    // reveal) while the candidate fetch runs in the background, so the
    // pills are ready the instant the user reveals them.
    const [revealed, setRevealed] = useState(false);
    /** Tracks the primary we've fetched for, so swapping primary
     *  triggers a refresh. */
    const fetchedForRef = useRef<number | null>(null);

    // Derive `checked` from the canonical store. The map "+/✓" pill
    // and the Select-all / Clear buttons both write through
    // `additionalMapGeoLocations`, so this stays in sync without an
    // extra state hop.
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
        // Wait for the main play area to paint before we start the
        // (heavier) adjacency lookup — see the `ready` prop.
        if (!ready) return;
        const primaryId = primary.properties.osm_id;
        if (fetchedForRef.current === primaryId) return;
        fetchedForRef.current = primaryId;

        // Always clear stale extensions when the primary changes —
        // the previously-added "neighbours" almost certainly don't
        // belong to the new primary. Nothing is selected by default;
        // the user opts each neighbour in via the map pills.
        additionalMapGeoLocations.set([]);
        setCandidates([]);
        setError(null);
        setRevealed(false);
        setLoading(true);

        let cancelled = false;
        findExtensionCandidates(primary, $allowedTransit, {
            radiusKm: 25,
            limit: 14,
        })
            .then((c) => {
                if (cancelled) return;
                setCandidates(c);
            })
            .catch((e) => {
                if (cancelled) return;
                console.warn("Extension lookup failed", e);
                setError(
                    "Couldn't fetch nearby areas. You can still play with just the main area.",
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
    }, [primary.properties.osm_id, $allowedTransit.join(","), ready]);

    // Publish a compact preview of the candidates for the play-area
    // preview map's "+/✓" overlay — but only once the user has
    // REVEALED them. Before that the atom stays null so the preview map
    // paints just the main play area and never widens the camera for
    // off-area pills (keeps the first reveal fast and uncluttered).
    // Cleared on unmount, when hidden, or when there are no candidates.
    useEffect(() => {
        if (!revealed || candidates.length === 0) {
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
    }, [candidates, revealed]);

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

    const selectAll = () =>
        additionalMapGeoLocations.set(
            candidates.map((c) => ({
                location: c.feature,
                added: true,
                base: false,
            })),
        );
    const clearAll = () => additionalMapGeoLocations.set([]);

    return (
        <div className="rounded-md border border-dashed border-border bg-secondary/20 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-poppins font-bold uppercase tracking-wider">
                        Extend with neighbouring areas
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                        {error
                            ? error
                            : revealed
                              ? "Tap the pills on the map to add or remove neighbouring areas."
                              : "Some nearby areas can be added so they count as one play area."}
                    </div>
                </div>
                {loading && !revealed && (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
                )}
            </div>

            {!revealed && !error && (
                <Button
                    variant="outline"
                    onClick={() => setRevealed(true)}
                    className="w-full gap-1.5"
                >
                    <MapPin className="w-3.5 h-3.5" />
                    {loading
                        ? "Add nearby areas…"
                        : `Add nearby areas (${candidates.length})`}
                </Button>
            )}

            {revealed && candidates.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/40">
                    <button
                        type="button"
                        onClick={allChecked ? clearAll : selectAll}
                        className={cn(
                            "px-2.5 py-1 rounded-sm text-[11px] font-poppins font-semibold",
                            "border transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            "bg-secondary/40 border-border hover:bg-accent",
                        )}
                    >
                        {allChecked ? "Clear all" : "Select all"}
                    </button>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                        {checkedCount}/{candidates.length} selected
                    </span>
                    <span className="ml-auto inline-flex items-center gap-1 text-[9px] uppercase tracking-wider font-poppins font-bold text-emerald-300">
                        <TrainTrack className="w-3 h-3" />
                        Transit-connected
                    </span>
                </div>
            )}
        </div>
    );
}

export default PlayAreaExtensions;
