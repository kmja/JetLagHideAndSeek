import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { distance, point } from "@turf/turf";
import { MapPin, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Map, { Layer, type MapRef, Marker, Source } from "react-map-gl/maplibre";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { hidingZone } from "@/lib/hiderRole";
import { darkOsmMapLibreStyle } from "@/lib/mapTiles";
import {
    participants,
    seekerLocations,
} from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * Hider-only panel showing live seeker positions (rulebook p5).
 *
 * Two views stacked:
 *
 *   - A small MapLibre map centered on the hider's hiding zone if
 *     it's committed, otherwise on the seekers' centroid. One pin
 *     per seeker, plus the hiding-zone circle for distance reference.
 *   - A list with each seeker's display name, last-seen-age, raw
 *     distance to the hiding zone (or to the seekers' centroid if no
 *     zone yet), and GPS accuracy.
 *
 * Hides itself entirely if no seekers have broadcast yet — the hider
 * shouldn't see an empty "no signal" widget before the round starts.
 * Re-renders every second to keep the "last seen" labels fresh.
 */
export function SeekerLivePositions() {
    const $locations = useStore(seekerLocations);
    const $participants = useStore(participants);
    const $hidingZone = useStore(hidingZone);

    // 1 Hz tick for the relative-time labels. Visibility-aware so the
    // hider's phone doesn't keep waking the CPU once a second.
    const [, setTick] = useState(0);
    useVisibleInterval(() => setTick((n) => n + 1), 1000, true);

    const rows = useMemo(() => {
        const entries = Object.entries($locations);
        return entries
            .map(([id, loc]) => {
                const p = $participants.find((q) => q.id === id);
                const name =
                    p?.displayName?.trim() || "Anonymous seeker";
                let km: number | null = null;
                if ($hidingZone) {
                    km = distance(
                        point([$hidingZone.stationLng, $hidingZone.stationLat]),
                        point([loc.lng, loc.lat]),
                        { units: "kilometers" },
                    );
                }
                return { id, name, km, loc };
            })
            .sort((a, b) => {
                if (a.km != null && b.km != null) return a.km - b.km;
                return b.loc.ts - a.loc.ts;
            });
    }, [$locations, $participants, $hidingZone]);

    const mapRef = useRef<MapRef | null>(null);

    // Fit the camera to the hiding zone + every seeker pin whenever
    // either side moves. Keeps the closest closer-than-1km flyover
    // useful at a glance.
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        const lats: number[] = [];
        const lngs: number[] = [];
        if ($hidingZone) {
            lats.push($hidingZone.stationLat);
            lngs.push($hidingZone.stationLng);
        }
        for (const { loc } of rows) {
            lats.push(loc.lat);
            lngs.push(loc.lng);
        }
        if (lats.length === 0) return;
        if (lats.length === 1) {
            map.flyTo({
                center: [lngs[0], lats[0]],
                zoom: 12,
                duration: 400,
            });
            return;
        }
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs);
        const maxLng = Math.max(...lngs);
        try {
            map.fitBounds(
                [
                    [minLng, minLat],
                    [maxLng, maxLat],
                ],
                { padding: 36, duration: 400, maxZoom: 14 },
            );
        } catch {
            /* ignore — map may not be ready */
        }
    }, [rows, $hidingZone]);

    // The hiding-zone circle: approximate as a ~64-point regular polygon
    // around the station so the line renders as a real circle. Use a
    // simple equirectangular projection — meters/degree is constant
    // enough at these radii.
    const zoneCircle = useMemo<GeoJSON.Feature<GeoJSON.Polygon> | null>(
        () => {
            if (!$hidingZone) return null;
            const { stationLat, stationLng, radiusMeters } = $hidingZone;
            const coords: [number, number][] = [];
            const steps = 64;
            const latDeg = radiusMeters / 111_320;
            const lngDeg =
                radiusMeters /
                (111_320 * Math.cos((stationLat * Math.PI) / 180));
            for (let i = 0; i <= steps; i++) {
                const t = (i / steps) * Math.PI * 2;
                coords.push([
                    stationLng + Math.cos(t) * lngDeg,
                    stationLat + Math.sin(t) * latDeg,
                ]);
            }
            return {
                type: "Feature",
                properties: {},
                geometry: { type: "Polygon", coordinates: [coords] },
            };
        },
        [$hidingZone],
    );

    const mapStyle = useMemo(() => darkOsmMapLibreStyle(), []);

    if (rows.length === 0) return null;

    return (
        <section className="mt-5">
            <div className="flex items-center gap-2 mb-2">
                <Search className="w-4 h-4 text-primary" />
                <span className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                    Seekers — live position
                </span>
                <span
                    className={cn(
                        "ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm",
                        "text-[9px] uppercase tracking-wider font-poppins font-bold",
                        "bg-primary/15 text-primary border border-primary/40",
                    )}
                >
                    {rows.length}
                </span>
            </div>

            <div className="w-full h-[220px] rounded-md overflow-hidden border border-border">
                <Map
                    ref={mapRef}
                    initialViewState={{
                        longitude: rows[0].loc.lng,
                        latitude: rows[0].loc.lat,
                        zoom: 11,
                    }}
                    style={{ width: "100%", height: "100%" }}
                    mapStyle={mapStyle}
                    attributionControl={false}
                    interactive={false}
                >
                    {zoneCircle && (
                        <Source id="zone" type="geojson" data={zoneCircle}>
                            <Layer
                                id="zone-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(2, 70%, 54%)",
                                    "fill-opacity": 0.12,
                                }}
                            />
                            <Layer
                                id="zone-line"
                                type="line"
                                paint={{
                                    "line-color": "hsl(2, 70%, 54%)",
                                    "line-width": 2,
                                }}
                            />
                        </Source>
                    )}
                    {/* Zone center pin so the hider can see where
                        their station sits relative to the seekers. */}
                    {$hidingZone && (
                        <Marker
                            longitude={$hidingZone.stationLng}
                            latitude={$hidingZone.stationLat}
                            anchor="center"
                        >
                            <div
                                style={{
                                    width: 14,
                                    height: 14,
                                    borderRadius: "50%",
                                    background: "hsl(2, 70%, 54%)",
                                    border: "2px solid white",
                                    boxShadow:
                                        "0 0 0 1px rgba(0,0,0,0.4)",
                                }}
                                aria-label="Your hiding zone"
                            />
                        </Marker>
                    )}
                    {/* Seeker pins. Bright blue for distinction from
                        the radius circle / hider zone center. */}
                    {rows.map(({ id, loc }) => (
                        <Marker
                            key={id}
                            longitude={loc.lng}
                            latitude={loc.lat}
                            anchor="bottom"
                        >
                            <div
                                style={{
                                    width: 20,
                                    height: 28,
                                }}
                                dangerouslySetInnerHTML={{
                                    __html: SEEKER_PIN_SVG,
                                }}
                            />
                        </Marker>
                    ))}
                </Map>
            </div>

            <ul className="mt-2 space-y-1">
                {rows.map(({ id, name, km, loc }) => (
                    <li
                        key={id}
                        className={cn(
                            "rounded-sm border border-border bg-secondary/40",
                            "px-2.5 py-1.5 flex items-center gap-2 text-xs",
                        )}
                    >
                        <MapPin className="w-3.5 h-3.5 text-primary shrink-0" />
                        <div className="min-w-0 flex-1">
                            <div className="font-poppins font-semibold truncate">
                                {name}
                            </div>
                            <div className="text-[10px] tabular-nums text-muted-foreground">
                                {ageLabel(loc.ts)} ·{" "}
                                ±{Math.round(loc.accuracy)} m
                            </div>
                        </div>
                        {km != null && (
                            <span className="font-inter-tight italic font-black tabular-nums text-primary">
                                {formatKm(km)}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}

function ageLabel(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}

function formatKm(km: number): string {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
}

const SEEKER_PIN_SVG = `
<svg width="20" height="28" viewBox="0 0 20 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M10 0C4.48 0 0 4.48 0 10c0 7.5 10 18 10 18s10-10.5 10-18C20 4.48 15.52 0 10 0z" fill="#3b82f6" stroke="white" stroke-width="2"/>
  <circle cx="10" cy="10" r="3.5" fill="white"/>
</svg>
`.trim();

export default SeekerLivePositions;
