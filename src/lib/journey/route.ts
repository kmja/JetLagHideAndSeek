import type { Journey, JourneyLeg } from "@/lib/journey/plan";

/**
 * Turn a planned `Journey` into a GeoJSON FeatureCollection the map can
 * paint as a route overlay: one line per leg (coloured by mode, walking
 * legs flagged for dashing) plus point "steps" at the origin, each
 * boarding/transfer stop, and the destination.
 *
 * We only have each leg's `from`/`to` endpoints (the worker doesn't
 * return a decoded shape), so the line is a straight segment per leg —
 * a schematic of the route, not the exact street/track geometry. That's
 * still useful: it shows the shape of the trip, where you change, and
 * which line each leg is.
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

export function journeyToRouteFC(
    journey: Journey,
): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    const legs = journey.legs ?? [];

    for (const leg of legs) {
        const isWalk = leg.mode === "walk";
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
                coordinates: [
                    [leg.from.lng, leg.from.lat],
                    [leg.to.lng, leg.to.lat],
                ],
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
