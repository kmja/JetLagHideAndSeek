import { useStore } from "@nanostores/react";
import { MapPin, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
    additionalMapGeoLocations,
    adjacentCandidatePreview,
    toggleAdjacentArea,
} from "@/lib/context";
import { allowedTransit } from "@/lib/gameSetup";
import {
    type AdjacentAreaCandidate,
    findExtensionCandidates,
} from "@/maps/api/playAreaExtensions";
import type { OpenStreetMap } from "@/maps/api/types";

/**
 * Adjacent-area controller for step 1 of the setup wizard.
 *
 * Why this exists: Stockholm Municipality (the OSM admin relation
 * matching "Stockholm") legally excludes Solna, Sundbyberg, Danderyd,
 * Järfälla, etc. — but those are tightly integrated via the city's
 * subway / commuter-rail network, and a Jet Lag player almost always
 * wants them included. Same pattern for NYC and its boroughs, Paris vs.
 * the Île-de-France metro, and so on.
 *
 * v456: no longer renders the "Extend with neighbouring areas" panel
 * (with its reveal button + select-all shortcuts). It now:
 *   1. Fetches the candidate neighbours IMMEDIATELY — in parallel with
 *      the main play area's boundary load, not gated behind a reveal —
 *      and publishes them to `adjacentCandidatePreview` so the preview
 *      map paints each candidate's WHOLE boundary as a tappable region.
 *   2. Renders compact rows for every area the user has added, each with
 *      a remove control.
 *
 * The canonical "is this area added?" state lives in
 * `additionalMapGeoLocations`, mutated by the map (tap-to-add) and the
 * remove buttons here, so both surfaces stay in sync.
 */
/**
 * Module-level so it survives PlayAreaStep unmounting (step 1 only
 * mounts while `step === 1`). Without this, returning to step 1 would
 * remount this controller and wipe every area the user added. We only
 * reset the added-area list when the primary GENUINELY changes.
 */
let lastResetPrimaryId: number | null = null;

/** Module-level candidate cache (by primary + transit) so re-entering
 *  step 1 repaints the tappable neighbours instantly instead of
 *  re-hitting Overpass. */
const candidateCache = new Map<string, AdjacentAreaCandidate[]>();

export function PlayAreaExtensions({ primary }: { primary: OpenStreetMap }) {
    const $allowedTransit = useStore(allowedTransit);
    const $additional = useStore(additionalMapGeoLocations);

    const cacheKey = `${primary.properties.osm_id}:${[...$allowedTransit].sort().join(",")}`;
    const [candidates, setCandidates] = useState<AdjacentAreaCandidate[]>(
        () => candidateCache.get(cacheKey) ?? [],
    );

    useEffect(() => {
        const primaryId = primary.properties.osm_id;
        // Reset added areas ONLY when the primary actually changes —
        // not on a back-nav remount for the same primary, and not on a
        // transit-mode tweak (which keeps the same neighbours).
        if (lastResetPrimaryId !== primaryId) {
            lastResetPrimaryId = primaryId;
            additionalMapGeoLocations.set([]);
        }

        const cached = candidateCache.get(cacheKey);
        if (cached) {
            setCandidates(cached);
            return;
        }
        setCandidates([]);

        let cancelled = false;
        findExtensionCandidates(primary, $allowedTransit, {
            radiusKm: 25,
            limit: 14,
        })
            .then((c) => {
                if (cancelled) return;
                candidateCache.set(cacheKey, c);
                setCandidates(c);
            })
            .catch((e) => {
                if (!cancelled) console.warn("Extension lookup failed", e);
            });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cacheKey]);

    // Publish candidates for the preview map's tappable-boundary overlay
    // the moment they land — no reveal gate. Cleared on unmount / when
    // there are none.
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

    const added = $additional.filter((e) => e.location);

    if (added.length === 0) {
        // Nothing added yet — surface a one-line hint, but only when
        // there ARE neighbours to add, so the tap-the-map gesture is
        // discoverable. Otherwise render nothing.
        if (candidates.length === 0) return null;
        return (
            <p className="text-[11px] text-muted-foreground leading-snug px-0.5">
                Tap a neighbouring area on the map to fold it into your play
                area.
            </p>
        );
    }

    return (
        <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider font-poppins font-bold text-muted-foreground px-0.5">
                Added areas
            </div>
            {added.map((e) => {
                const locProps = e.location?.properties as
                    | { osm_id?: number; name?: string }
                    | undefined;
                const id = locProps?.osm_id;
                const name = locProps?.name || "Neighbouring area";
                return (
                    <div
                        key={id ?? name}
                        className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2"
                    >
                        <MapPin className="w-3.5 h-3.5 text-primary shrink-0" />
                        <span className="flex-1 truncate text-sm">{name}</span>
                        {typeof id === "number" && (
                            <button
                                type="button"
                                onClick={() => toggleAdjacentArea(id)}
                                aria-label={`Remove ${name}`}
                                title={`Remove ${name}`}
                                className="rounded-sm p-1 text-muted-foreground hover:bg-background/70 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export default PlayAreaExtensions;
