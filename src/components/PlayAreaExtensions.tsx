import { useStore } from "@nanostores/react";
import { MapPin, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
    ensureWarmCitiesLoaded,
    isWarmCity,
    warmCityIds,
} from "@/maps/api/warmCities";
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

import { formatAreaLabel } from "@/lib/playAreaSize";

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
/** Module-level candidate cache (by primary + transit) so re-entering
 *  step 1 repaints the tappable neighbours instantly instead of
 *  re-hitting Overpass. */
const candidateCache = new Map<string, AdjacentAreaCandidate[]>();

export function PlayAreaExtensions({ primary }: { primary: OpenStreetMap }) {
    const $allowedTransit = useStore(allowedTransit);
    const $additional = useStore(additionalMapGeoLocations);
    const $warm = useStore(warmCityIds);

    // v1061: offer adjacent-adding for any STARRED (warm) primary, and — the
    // key change — show only the adjacents that are THEMSELVES starred/warm
    // (filtered per-candidate below), not require EVERY neighbour to be warm.
    // The old all-or-nothing `/api/adjacent-ready-cities` gate hid the whole
    // picker if even one neighbour failed to warm; now a failed neighbour just
    // drops itself while the warm ones still show. Each offered adjacent is in
    // `warmCityIds` (its own boundary+refs+stations+pack cached), so it still
    // loads Overpass-free — the "no live Overpass mid-game" guarantee holds
    // per-adjacent instead of per-city.
    useEffect(() => {
        void ensureWarmCitiesLoaded();
    }, []);
    const extendable = isWarmCity(primary.properties.osm_id, $warm);

    const cacheKey = `${primary.properties.osm_id}:${[...$allowedTransit].sort().join(",")}`;
    const [candidates, setCandidates] = useState<AdjacentAreaCandidate[]>(
        () => candidateCache.get(cacheKey) ?? [],
    );
    // v474: expose the fetch lifecycle so the preview map can wait for
    // the adjacency lookup to RESOLVE before it reveals (a cache hit is
    // "ready" immediately). Without this the preview can't tell "still
    // loading" from "loaded, zero neighbours".
    const [status, setStatus] = useState<"loading" | "ready">(() =>
        candidateCache.has(cacheKey) ? "ready" : "loading",
    );

    useEffect(() => {
        // NOTE: clearing the added-area list on a primary change is owned
        // by the parent step (SetupPage / GameSetupDialog), which gates it
        // on the committed `mapGeoLocation` so an edit-mode reopen doesn't
        // wipe already-saved neighbours. This controller only fetches the
        // candidate set for the current primary.
        // Not adjacent-ready → don't fetch or offer any neighbours. Report
        // "ready, zero candidates" so the preview map resolves cleanly (no
        // tappable boundaries) instead of spinning.
        if (!extendable) {
            setCandidates([]);
            setStatus("ready");
            return;
        }

        const cached = candidateCache.get(cacheKey);
        if (cached) {
            setCandidates(cached);
            setStatus("ready");
            return;
        }
        setCandidates([]);
        setStatus("loading");

        let cancelled = false;
        // v1065: enumerate candidates the NORMAL way (baked set if the city has
        // one, else the live admin-adjacency derivation — which is prewarmed +
        // R2-cached for a warm city, so it's Overpass-free in practice). We then
        // FILTER to the individually-warm neighbours below, so a city whose
        // adjacency isn't baked into world-cities.json yet (e.g. Stockholm) still
        // shows its warmed adjacents. `bakedOnly:true` was too strict — it showed
        // NOTHING for a non-baked city even when its neighbours were warmed.
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
            })
            .finally(() => {
                if (!cancelled) setStatus("ready");
            });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cacheKey, extendable]);

    // v1061: only OFFER the adjacents that are THEMSELVES starred/warm — a
    // neighbour that failed to prewarm drops itself instead of blocking the
    // whole picker. Each survivor is in `warmCityIds`, so folding it in stays
    // Overpass-free. Filtering here (reactive on `$warm`) means the offered set
    // fills in as the warm-city data lands.
    const warmCandidates = candidates.filter((c) =>
        isWarmCity(c.feature.properties.osm_id, $warm),
    );
    // A stable key so the publish effect only re-runs when the offered set (or
    // status) actually changes, not on every render.
    const warmKey = warmCandidates
        .map((c) => c.feature.properties.osm_id)
        .join(",");

    // Publish candidates + status for the preview map's tappable-boundary
    // overlay AND its reveal gate. We always publish a non-null value
    // (even with zero candidates) so the preview can distinguish "still
    // loading" from "resolved, nothing to add". Cleared on unmount.
    useEffect(() => {
        adjacentCandidatePreview.set({
            status,
            candidates: warmCandidates.map((c) => ({
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [warmKey, status]);

    const added = $additional.filter((e) => e.location);

    if (added.length === 0) {
        // Nothing added yet — surface a one-line hint, but only when
        // there ARE (warm) neighbours to add, so the tap-the-map gesture is
        // discoverable. Otherwise render nothing.
        if (warmCandidates.length === 0) return null;
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
            {/* v458: only THIS list scrolls when it grows long — the
                preview map + Change-area button stay put above/below it.
                Capped so the dialog itself doesn't have to scroll. */}
            <div className="max-h-[40vh] overflow-y-auto space-y-1.5 -mr-1 pr-1">
                {added.map((e) => {
                    const locProps = e.location?.properties as
                        | { osm_id?: number; name?: string }
                        | undefined;
                    const id = locProps?.osm_id;
                    const name = locProps?.name || "Neighbouring area";
                    const sizeLabel = e.location
                        ? formatAreaLabel(e.location)
                        : null;
                    return (
                        <div
                            key={id ?? name}
                            className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2"
                        >
                            <MapPin className="w-3.5 h-3.5 text-primary shrink-0" />
                            <span className="min-w-0 flex-1 truncate text-sm">
                                {name}
                            </span>
                            {sizeLabel && (
                                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                                    {sizeLabel}
                                </span>
                            )}
                            {typeof id === "number" && (
                                <button
                                    type="button"
                                    onClick={() => toggleAdjacentArea(id)}
                                    aria-label={`Remove ${name}`}
                                    title={`Remove ${name}`}
                                    className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-background/70 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default PlayAreaExtensions;
