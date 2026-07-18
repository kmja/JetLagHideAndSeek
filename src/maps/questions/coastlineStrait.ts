import * as turf from "@turf/turf";
import type {
    Feature,
    LineString,
    MultiLineString,
    MultiPolygon,
    Polygon,
} from "geojson";

import { seaFromCoastline } from "./seaFromCoastline";

/**
 * v969 (rulebook audit A4): the COASTLINE question's 2 km strait rule.
 *
 * Rulebook p26: coastline is "any place where land meets either the ocean, a
 * great lake, or a body of water that flows directly into the ocean or great
 * lake via a waterway that is never less than 2 km across. A strait under
 * 2 km across does not produce a coastline."
 *
 * OSM's `natural=coastline` has no such rule — it traces every tidal channel
 * (NYC's East River, harbour narrows), so buffering the raw lines treated
 * sub-2 km straits as coastline. This module filters the coastline LINES to
 * only those bordering QUALIFYING water, via a morphological opening of the
 * sea polygon:
 *
 *   1. Build the sea polygon from the coastline (the existing
 *      `seaFromCoastline` right-of-way construction).
 *   2. ERODE it by 1 km (half the minimum width). Water narrower than 2 km —
 *      straits, tidal rivers — vanishes entirely; only "wide-water cores"
 *      survive.
 *   3. Keep only OCEAN-GRADE cores: those still touching the frame edge (the
 *      water continues beyond the play area — the open sea), or with a core
 *      area big enough to be a great lake. A wide-but-landlocked bay whose
 *      only connection was a sub-2 km strait becomes a DISCONNECTED core that
 *      touches nothing → dropped, exactly the "flows directly into the ocean
 *      via a ≥2 km waterway" condition.
 *   4. DILATE the kept cores back by 1 km (+ a hair). The result reaches
 *      exactly the shorelines of qualifying water and cannot re-enter the
 *      eroded-away straits.
 *   5. Keep the coastline chunks whose midpoint falls inside that dilated
 *      region; everything else (strait/narrow-river shoreline) is dropped.
 *
 * Returns:
 *   - `Feature<LineString>[]` — the qualifying coastline chunks (possibly
 *     empty: a play area whose only "coast" is narrow water has NO coastline
 *     per the rulebook);
 *   - `null` — couldn't compute (no sea polygon / geometry failure); the
 *     caller should fall back to the UNfiltered lines rather than degrade.
 */

/** The rulebook's minimum waterway width for coastline-producing water. */
export const STRAIT_MIN_WIDTH_KM = 2;

/** Erosion/dilation radius — half the minimum width. */
const R_KM = STRAIT_MIN_WIDTH_KM / 2;

/** An eroded, frame-DISCONNECTED core must be at least this big to count as
 *  a "great lake" (the rulebook's other coastline source). Deliberately
 *  large: an ordinary big lake (tens of km²) is NOT a great lake. */
const GREAT_LAKE_MIN_ERODED_KM2 = 500;

/** Chunk length for the shoreline membership test. Short enough that a chunk
 *  doesn't straddle qualifying and non-qualifying water. */
const CHUNK_KM = 0.5;

export function filterCoastlineByStraitRule(
    lines: Feature<LineString | MultiLineString>[],
    frameBbox: [number, number, number, number],
    seeker: { lng: number; lat: number },
): Feature<LineString>[] | null {
    try {
        if (!lines || lines.length === 0) return null;
        const sea = seaFromCoastline(lines, frameBbox, seeker);
        if (!sea) return null;

        // Simplify before the heavy buffers — the rule operates at 2 km
        // scale, so ~100 m tolerance is far below the signal.
        let seaSimple = sea;
        try {
            seaSimple = turf.simplify(sea, {
                tolerance: 0.001,
                highQuality: false,
                mutate: false,
            });
        } catch {
            /* keep unsimplified */
        }

        // 2. Erode: water narrower than 2 km disappears.
        let eroded: Feature<Polygon | MultiPolygon> | undefined;
        try {
            eroded = turf.buffer(seaSimple as never, -R_KM, {
                units: "kilometers",
                steps: 8,
            }) as unknown as Feature<Polygon | MultiPolygon> | undefined;
        } catch {
            return null;
        }
        // Everything eroded away → all water is sub-2 km → no coastline.
        if (!eroded || !eroded.geometry) return [];

        const parts: Feature<Polygon>[] = [];
        if (eroded.geometry.type === "Polygon") {
            parts.push(eroded as Feature<Polygon>);
        } else {
            for (const coords of (eroded.geometry as MultiPolygon)
                .coordinates) {
                parts.push(turf.polygon(coords));
            }
        }
        if (parts.length === 0) return [];

        // 3. Ocean-grade cores: touch the frame edge (within the erosion
        // radius + slack — erosion pulled the sea back from the frame edge
        // too), or great-lake-sized.
        const frameRing = turf.polygonToLine(
            turf.bboxPolygon(frameBbox),
        ) as Feature<LineString>;
        const kept: Feature<Polygon>[] = [];
        for (const p of parts) {
            let touches = false;
            const ring = p.geometry.coordinates[0] ?? [];
            const step = Math.max(1, Math.floor(ring.length / 120));
            for (let i = 0; i < ring.length; i += step) {
                const d = turf.pointToLineDistance(
                    turf.point(ring[i]),
                    frameRing,
                    { units: "kilometers" },
                );
                if (d <= R_KM + 0.25) {
                    touches = true;
                    break;
                }
            }
            if (
                touches ||
                turf.area(p) >= GREAT_LAKE_MIN_ERODED_KM2 * 1e6
            ) {
                kept.push(p);
            }
        }
        if (kept.length === 0) return [];

        // 4. Dilate the kept cores back out to the qualifying shorelines.
        const keptUnion =
            kept.length === 1
                ? kept[0]
                : (turf.union(
                      turf.featureCollection(kept as never),
                  ) as Feature<Polygon | MultiPolygon> | null);
        if (!keptUnion) return [];
        let dilated: Feature<Polygon | MultiPolygon> | undefined;
        try {
            dilated = turf.buffer(keptUnion as never, R_KM + 0.05, {
                units: "kilometers",
                steps: 8,
            }) as unknown as Feature<Polygon | MultiPolygon> | undefined;
        } catch {
            return null;
        }
        if (!dilated) return [];

        // 5. Keep coastline chunks adjacent to qualifying water.
        const out: Feature<LineString>[] = [];
        for (const line of lines) {
            const g = line.geometry;
            const segments: LineString[] =
                g.type === "LineString"
                    ? [g]
                    : g.coordinates
                          .filter((c) => c.length >= 2)
                          .map((c) => ({
                              type: "LineString" as const,
                              coordinates: c,
                          }));
            for (const seg of segments) {
                let chunks;
                try {
                    chunks = turf.lineChunk(
                        turf.feature(seg) as never,
                        CHUNK_KM,
                        { units: "kilometers" },
                    );
                } catch {
                    continue;
                }
                for (const c of chunks.features) {
                    const coords = c.geometry?.coordinates;
                    if (!coords || coords.length < 2) continue;
                    const mid = coords[Math.floor(coords.length / 2)];
                    try {
                        if (
                            turf.booleanPointInPolygon(
                                turf.point(mid),
                                dilated as never,
                            )
                        ) {
                            out.push(c as Feature<LineString>);
                        }
                    } catch {
                        /* skip chunk */
                    }
                }
            }
        }
        return out;
    } catch {
        return null;
    }
}
