import type { Journey, JourneyLeg } from "@/lib/journey/plan";

/**
 * Turn a planned `Journey` into a GeoJSON FeatureCollection the map can
 * paint as a route overlay: one line per leg (coloured by mode, walking
 * legs flagged for dashing) plus point "steps" at the origin, each
 * boarding/transfer stop, and the destination.
 *
 * When the adapter supplied a decoded shape (`leg.geometry`, from
 * MOTIS/OTP `legGeometry`), we draw the leg's REAL path — the actual
 * walking-street route or track geometry, not a straight from→to line.
 * Legs without a shape (adapters that don't return one) fall back to a
 * straight segment: still useful — it shows the shape of the trip, where
 * you change, and which line each leg is.
 */

const MODE_COLORS: Record<string, string> = {
    walk: "hsl(220, 9%, 65%)",
    subway: "hsl(280, 60%, 60%)",
    bus: "hsl(35, 90%, 55%)",
    ferry: "hsl(200, 85%, 55%)",
    train: "hsl(140, 55%, 45%)",
    tram: "hsl(330, 75%, 60%)",
    transit: "hsl(210, 70%, 62%)",
};

function colorFor(mode: string): string {
    return MODE_COLORS[mode] ?? MODE_COLORS.transit;
}

function hhmm(unixMs: number): string {
    const d = new Date(unixMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes(),
    ).padStart(2, "0")}`;
}

/** Short human label for a leg's boarding point, e.g. "Bus 12", "Walk",
 *  "Train". */
function legLabel(leg: JourneyLeg): string {
    if (leg.mode === "walk") return "Walk";
    const name =
        leg.mode === "transit"
            ? "Transit"
            : leg.mode.charAt(0).toUpperCase() + leg.mode.slice(1);
    return leg.line ? `${name} ${leg.line}` : name;
}

/** True when a leg endpoint is a real coordinate. Some upstream parsers
 *  default a missing place to (0, 0) — a Null Island line/stop would
 *  drag the route (and the map fit) across the globe, so both the leg
 *  lines and the step dots skip such endpoints. */
function validPoint(p: { lat: number; lng: number }): boolean {
    return (
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        !(p.lat === 0 && p.lng === 0)
    );
}

export function journeyToRouteFC(
    journey: Journey,
): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    const legs = (journey.legs ?? []).filter(
        (l) => validPoint(l.from) && validPoint(l.to),
    );

    for (const leg of legs) {
        const isWalk = leg.mode === "walk";
        // Prefer the adapter's real decoded shape (street/track geometry)
        // when it has one; otherwise fall back to a straight from→to
        // segment. Guard the shape's points to finite, non-Null-Island
        // coords so a bad vertex can't drag the line across the globe.
        const shape = (leg.geometry ?? []).filter(
            (p) =>
                Array.isArray(p) &&
                Number.isFinite(p[0]) &&
                Number.isFinite(p[1]) &&
                !(p[0] === 0 && p[1] === 0),
        );
        const coordinates: [number, number][] =
            shape.length >= 2
                ? shape.map((p) => [p[0], p[1]])
                : [
                      [leg.from.lng, leg.from.lat],
                      [leg.to.lng, leg.to.lat],
                  ];
        features.push({
            type: "Feature",
            properties: {
                kind: "leg",
                mode: leg.mode,
                color: colorFor(leg.mode),
                walk: isWalk,
            },
            geometry: {
                type: "LineString",
                coordinates,
            },
        });
    }

    if (legs.length > 0) {
        // Start
        const first = legs[0];
        features.push(
            stopFeature(first.from.lng, first.from.lat, "Start", "start"),
        );
        // Each leg's arrival point. The last is the destination; the
        // others are transfer/boarding points labelled with the NEXT
        // leg to take.
        legs.forEach((leg, i) => {
            const isLast = i === legs.length - 1;
            if (isLast) {
                features.push(
                    stopFeature(leg.to.lng, leg.to.lat, "Arrive", "end"),
                );
            } else {
                const next = legs[i + 1];
                const label = `${legLabel(next)} · ${hhmm(next.departAt)}`;
                features.push(
                    stopFeature(leg.to.lng, leg.to.lat, label, "stop"),
                );
            }
        });
    }

    return { type: "FeatureCollection", features };
}

function stopFeature(
    lng: number,
    lat: number,
    label: string,
    role: "start" | "stop" | "end",
): GeoJSON.Feature {
    return {
        type: "Feature",
        properties: { kind: "stop", label, role },
        geometry: { type: "Point", coordinates: [lng, lat] },
    };
}
