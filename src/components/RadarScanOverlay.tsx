import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { useEffect, useRef } from "react";

import { CATEGORIES } from "@/lib/categories";
import {
    leafletMapContext,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import type { Question, RadiusQuestion } from "@/maps/schema";

/**
 * Renders a rotating radar-sweep effect for every pending (drag:true)
 * radar question. The sweep is an SVG wedge + scan line clipped to the
 * radar's circle, rendered via Leaflet's `svgOverlay` so it auto-scales
 * with map zoom and stays anchored to the geographic center+radius.
 *
 * Mounted as a sibling of the main `Map` in index.astro. Keeps a layer
 * per question keyed by `question.key` so we can incrementally
 * add/remove sweeps as questions are asked / answered.
 */
export function RadarScanOverlay() {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const map = useStore(leafletMapContext);

    // Active sweep layers, keyed by question.key. We diff this set each
    // render against the desired set (pending radar questions) and only
    // create/remove what changed.
    const layersRef = useRef<Map<number, ActiveSweep>>(new Map());
    // Keys currently in fade-out — kept alive briefly after the
    // question is answered so the seeker reads the transition as
    // "scan complete; here's the new play area" rather than a hard
    // yank. The setTimeout id lets us cancel if the question comes
    // back (e.g. seeker un-answers via the toggle).
    const fadingRef = useRef<Map<number, number>>(new Map());
    /** Duration of the fade-out, kept in sync with PendingAnswerOverlay's
     *  "answered" hold so both finish together. */
    const FADE_OUT_MS = 900;

    useEffect(() => {
        if (!map) return;
        let cancelled = false;

        (async () => {
            const L = await import("leaflet");
            if (cancelled) return;

            const pending = $questions.filter(
                (q): q is Question & { data: RadiusQuestion } =>
                    q.id === "radius" &&
                    q.data.drag === true &&
                    Number.isFinite(q.data.lat) &&
                    Number.isFinite(q.data.lng) &&
                    Number.isFinite(q.data.radius),
            );

            const desiredKeys = new Set(pending.map((q) => q.key));
            // Start fade-out for sweeps whose question just got answered.
            for (const [key, sweep] of layersRef.current) {
                if (!desiredKeys.has(key) && !fadingRef.current.has(key)) {
                    startFadeOut(key, sweep, map);
                }
            }
            // If a question came back into pending while it was fading
            // (re-armed via the answer toggle), cancel that fade and
            // restore visibility.
            for (const key of desiredKeys) {
                const fadeId = fadingRef.current.get(key);
                if (fadeId !== undefined) {
                    window.clearTimeout(fadeId);
                    fadingRef.current.delete(key);
                    const existing = layersRef.current.get(key);
                    if (existing) {
                        const el = (existing.layer as any).getElement?.() as
                            | SVGElement
                            | undefined;
                        if (el) {
                            el.style.transition = "opacity 200ms ease-out";
                            el.style.opacity = "1";
                        }
                    }
                }
            }

            // Add or update sweeps for currently-pending radar questions.
            for (const q of pending) {
                const d = q.data;
                const radiusMeters = unitToMeters(d.radius, d.unit);
                const bounds = boundsForRadius(d.lat, d.lng, radiusMeters);

                const existing = layersRef.current.get(q.key);
                const needsRebuild =
                    !existing ||
                    existing.lat !== d.lat ||
                    existing.lng !== d.lng ||
                    existing.radiusMeters !== radiusMeters;

                if (existing && needsRebuild) {
                    map.removeLayer(existing.layer);
                    layersRef.current.delete(q.key);
                }

                if (needsRebuild) {
                    const svg = buildSweepSvg(
                        CATEGORIES.radius.color,
                        q.key,
                    );
                    const layer = L.svgOverlay(svg, bounds, {
                        interactive: false,
                        // The sweep should sit above the dashed
                        // planning polygon Leaflet draws on the overlay
                        // pane. Same pane is fine — DOM order wins, and
                        // we mount after the polygon is added.
                    });
                    layer.addTo(map);
                    layersRef.current.set(q.key, {
                        layer,
                        lat: d.lat,
                        lng: d.lng,
                        radiusMeters,
                    });
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [map, $questions]);

    // Clean up everything on unmount.
    useEffect(() => {
        return () => {
            if (!map) return;
            for (const id of fadingRef.current.values()) {
                window.clearTimeout(id);
            }
            fadingRef.current.clear();
            for (const sweep of layersRef.current.values()) {
                map.removeLayer(sweep.layer);
            }
            layersRef.current.clear();
        };
    }, [map]);

    /** Fade the SVG to 0 opacity, then actually remove the layer. The
     *  question's elimination mask update is happening in parallel in
     *  Map.tsx's render path, so the seeker sees the sweep dissolve as
     *  the new restricted play area paints in underneath. */
    function startFadeOut(
        key: number,
        sweep: ActiveSweep,
        leafletMap: any,
    ) {
        const el = (sweep.layer as any).getElement?.() as
            | SVGElement
            | undefined;
        if (el) {
            el.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
            el.style.opacity = "0";
        }
        const id = window.setTimeout(() => {
            leafletMap.removeLayer(sweep.layer);
            layersRef.current.delete(key);
            fadingRef.current.delete(key);
        }, FADE_OUT_MS);
        fadingRef.current.set(key, id);
    }

    return null;
}

interface ActiveSweep {
    // Leaflet's SVGOverlay; loosely typed here to avoid a static
    // leaflet type import dragging it into the SSR graph.
    layer: any;
    lat: number;
    lng: number;
    radiusMeters: number;
}

function unitToMeters(radius: number, unit: string): number {
    if (unit === "kilometers") return radius * 1000;
    if (unit === "miles") return radius * 1609.344;
    return radius; // meters
}

function boundsForRadius(
    lat: number,
    lng: number,
    radiusMeters: number,
): [[number, number], [number, number]] {
    // Use turf to walk the four cardinal directions for a
    // latitude-accurate bounding box. `turf.destination` takes km.
    const km = radiusMeters / 1000;
    const north = turf.destination([lng, lat], km, 0).geometry.coordinates;
    const south = turf.destination([lng, lat], km, 180).geometry.coordinates;
    const east = turf.destination([lng, lat], km, 90).geometry.coordinates;
    const west = turf.destination([lng, lat], km, 270).geometry.coordinates;
    return [
        [south[1], west[0]],
        [north[1], east[0]],
    ];
}

/**
 * Build the SVG element used as the sweep overlay. Coordinate system is
 * a 200×200 viewBox centered at (100, 100); the radar circle has radius
 * 100. The sweep has four pieces:
 *
 *   1. A faint base radial fill so the circle reads as "live" between
 *      sweeps.
 *   2. A rotating interior wake wedge (90° pie slice) — provides the
 *      faded "the radar just passed here" effect inside the circle.
 *   3. A leading scan line from center to perimeter.
 *   4. A rotating *perimeter trail* composed of fixed-position arc
 *      paths. Each arc covers a specific angular range behind the
 *      leading edge (e.g. 3–10° behind) and has its own opacity. The
 *      whole trail group rotates with the scan line via the SAME
 *      `animateTransform`, so the arcs stay anchored to "behind the
 *      scan" no matter what t is — no dashoffset / dasharray sleight
 *      of hand, no wrap-around bugs.
 *
 * The whole thing renders as a single SVG that L.svgOverlay scales to
 * the radar's geographic extent, so it follows zoom/pan for free.
 */
function buildSweepSvg(color: string, questionKey: number): SVGElement {
    const id = `radarSweep-${questionKey}`;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("xmlns", ns);
    svg.setAttribute("viewBox", "0 0 200 200");
    svg.setAttribute("preserveAspectRatio", "none");

    /**
     * Trail arcs. Each entry covers an angular range expressed as
     * *degrees behind the leading edge*: `behindStart=3, behindEnd=10`
     * means an arc 3° to 10° behind the scan line, going counter-
     * clockwise in screen-space (the direction the scan just came
     * from, since the scan rotates clockwise).
     *
     * Opacity declines smoothly from 1.0 to 0.03 across the 340° trail,
     * leaving a 20° gap between the very faint tail and the bright
     * lead so the trail visibly "just barely" doesn't complete the lap.
     */
    const trail = [
        { behindStart: 0,   behindEnd: 3,   opacity: 1.00, width: 3.5 },
        { behindStart: 3,   behindEnd: 10,  opacity: 0.85, width: 3.0 },
        { behindStart: 10,  behindEnd: 25,  opacity: 0.65, width: 2.5 },
        { behindStart: 25,  behindEnd: 50,  opacity: 0.45, width: 2.2 },
        { behindStart: 50,  behindEnd: 90,  opacity: 0.28, width: 2.0 },
        { behindStart: 90,  behindEnd: 150, opacity: 0.15, width: 2.0 },
        { behindStart: 150, behindEnd: 240, opacity: 0.07, width: 2.0 },
        { behindStart: 240, behindEnd: 340, opacity: 0.03, width: 2.0 },
    ];

    /** Build an arc path from `behindStart` (closer to scan) to
     *  `behindEnd` (further behind), as a CCW arc on a radius-99 circle
     *  centered at (100,100). The scan line at t=0 points to (200,100)
     *  (the +x axis); "behind" means decreasing screen-angle, i.e.
     *  going counter-clockwise in the y-down SVG frame.
     */
    const arcPath = (behindStart: number, behindEnd: number): string => {
        const r = 99;
        const cx = 100;
        const cy = 100;
        const toRad = (deg: number) => (deg * Math.PI) / 180;
        // "Behind by X degrees" = angle -X from the +x axis.
        const sx = cx + r * Math.cos(toRad(-behindStart));
        const sy = cy + r * Math.sin(toRad(-behindStart));
        const ex = cx + r * Math.cos(toRad(-behindEnd));
        const ey = cy + r * Math.sin(toRad(-behindEnd));
        const span = behindEnd - behindStart;
        const largeArc = span > 180 ? 1 : 0;
        // sweep-flag=0 means the arc is drawn in the direction of
        // decreasing screen-angle (CCW in y-down SVG), which is what
        // we want for "going further behind the scan".
        return `M ${sx.toFixed(3)} ${sy.toFixed(3)} A ${r} ${r} 0 ${largeArc} 0 ${ex.toFixed(3)} ${ey.toFixed(3)}`;
    };

    const trailPaths = trail
        .map(
            (l) => `
        <path d="${arcPath(l.behindStart, l.behindEnd)}"
              fill="none"
              stroke="${color}"
              stroke-opacity="${l.opacity}"
              stroke-width="${l.width}"
              stroke-linecap="round"/>`,
        )
        .join("");

    svg.innerHTML = `
        <defs>
            <clipPath id="clip-${id}">
                <circle cx="100" cy="100" r="100"/>
            </clipPath>
            <linearGradient id="grad-${id}" x1="1" y1="0.5" x2="0" y2="0.5">
                <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
                <stop offset="60%" stop-color="${color}" stop-opacity="0.10"/>
                <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
            </linearGradient>
            <radialGradient id="ping-${id}" cx="100" cy="100" r="100" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="${color}" stop-opacity="0.18"/>
                <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
            </radialGradient>
        </defs>

        <!-- Faint base fill so the radar circle reads as "live" even
             between sweeps. Kept low so the play area underneath stays
             legible. -->
        <circle cx="100" cy="100" r="100" fill="url(#ping-${id})"/>

        <g clip-path="url(#clip-${id})">
            <!-- Interior wake wedge: 90° pie slice that rotates with
                 the scan line. Lower opacity than the perimeter trail
                 so it doesn't dominate the play area underneath. -->
            <g>
                <path
                    d="M 100 100 L 200 100 A 100 100 0 0 0 100 0 Z"
                    fill="url(#grad-${id})"
                />
                <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from="0 100 100"
                    to="360 100 100"
                    dur="2.6s"
                    repeatCount="indefinite"
                />
            </g>

            <!-- Leading scan line: bright ray from center to perimeter. -->
            <g>
                <line
                    x1="100" y1="100"
                    x2="200" y2="100"
                    stroke="${color}"
                    stroke-width="2"
                    stroke-opacity="0.95"
                    stroke-linecap="round"
                />
                <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from="0 100 100"
                    to="360 100 100"
                    dur="2.6s"
                    repeatCount="indefinite"
                />
            </g>
        </g>

        <!-- Perimeter trail: rotating arc paths anchored at fixed
             angular offsets behind the scan line. Synchronized with the
             scan via the same 2.6s rotation. Drawn outside the
             clip-path so the rounded stroke ends aren't shaved. -->
        <g>
            ${trailPaths}
            <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 100 100"
                to="360 100 100"
                dur="2.6s"
                repeatCount="indefinite"
            />
        </g>

        <!-- Static center dot — anchors the eye where the seeker's pin
             actually is. -->
        <circle cx="100" cy="100" r="2.5" fill="${color}"/>
    `;
    return svg;
}

export default RadarScanOverlay;
