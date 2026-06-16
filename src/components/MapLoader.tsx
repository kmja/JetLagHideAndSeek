import { cn } from "@/lib/utils";

/**
 * Custom map-themed loader used in MapTilesVeil. Mimics a city map
 * being drawn from the ground up:
 *
 *   1. The river fades in and the river path draws across.
 *   2. The park (green block) settles in beneath the river.
 *   3. The road grid draws — two horizontals, two verticals.
 *   4. A handful of building footprints pop up.
 *   5. A pin drops at the centre, holds, then everything fades and
 *      the loop restarts.
 *
 * All animation timing lives in globals.css (jl-map-* keyframes)
 * so the SVG markup here stays focused on geometry. Each element
 * has its own `style.animation` so we can dial individual delays
 * without redefining the keyframe per shape.
 *
 * Designed against MapTilesVeil's available area on mobile — roughly
 * 200×120 reads clearly without crowding the labels beneath.
 */
export function MapLoader({ className }: { className?: string }) {
    const SHARED = "2.6s linear infinite both";
    return (
        <svg
            viewBox="0 0 200 120"
            className={cn("h-20 w-32", className)}
            role="img"
            aria-label="Loading map"
        >
            {/* Map paper — slight rounded card to read as a tile */}
            <rect
                x="2"
                y="2"
                width="196"
                height="116"
                rx="8"
                ry="8"
                fill="hsl(var(--secondary))"
                opacity="0.45"
            />

            {/* Park */}
            <rect
                x="20"
                y="62"
                width="42"
                height="32"
                rx="3"
                ry="3"
                fill="hsl(140, 48%, 58%)"
                style={{
                    animation: `jl-map-park-fade ${SHARED}`,
                    transformOrigin: "41px 78px",
                }}
            />

            {/* River — wide blue curve */}
            <path
                d="M 4 32 Q 60 22 110 44 T 196 60"
                stroke="hsl(202, 78%, 60%)"
                strokeWidth="5"
                fill="none"
                strokeLinecap="round"
                strokeDasharray="260"
                style={{
                    animation: `jl-map-river-draw ${SHARED}`,
                }}
            />

            {/* Roads */}
            <line
                x1="2"
                y1="84"
                x2="198"
                y2="84"
                stroke="hsl(var(--muted-foreground))"
                strokeOpacity="0.7"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeDasharray="210"
                style={{
                    animation: `jl-map-road-draw ${SHARED}`,
                    animationDelay: "0.05s",
                }}
            />
            <line
                x1="2"
                y1="100"
                x2="198"
                y2="100"
                stroke="hsl(var(--muted-foreground))"
                strokeOpacity="0.5"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeDasharray="210"
                style={{
                    animation: `jl-map-road-draw ${SHARED}`,
                    animationDelay: "0.20s",
                }}
            />
            <line
                x1="78"
                y1="2"
                x2="78"
                y2="118"
                stroke="hsl(var(--muted-foreground))"
                strokeOpacity="0.5"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeDasharray="210"
                style={{
                    animation: `jl-map-road-draw ${SHARED}`,
                    animationDelay: "0.35s",
                }}
            />
            <line
                x1="142"
                y1="2"
                x2="142"
                y2="118"
                stroke="hsl(var(--muted-foreground))"
                strokeOpacity="0.7"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeDasharray="210"
                style={{
                    animation: `jl-map-road-draw ${SHARED}`,
                    animationDelay: "0.45s",
                }}
            />

            {/* Buildings — scattered along the right block and across
                the top quadrant. transformOrigin per rect keeps the
                "pop up from base" feel rather than scaling outward
                from centre. */}
            {[
                { x: 86, y: 70, w: 10, h: 14, delay: 0 },
                { x: 100, y: 64, w: 12, h: 20, delay: 0.05 },
                { x: 116, y: 72, w: 8, h: 12, delay: 0.1 },
                { x: 148, y: 54, w: 14, h: 30, delay: 0.15 },
                { x: 168, y: 64, w: 10, h: 20, delay: 0.2 },
                { x: 184, y: 70, w: 8, h: 14, delay: 0.25 },
                { x: 88, y: 14, w: 18, h: 14, delay: 0.05 },
                { x: 112, y: 18, w: 10, h: 10, delay: 0.15 },
                { x: 152, y: 14, w: 14, h: 14, delay: 0.1 },
            ].map((b, i) => (
                <rect
                    key={i}
                    x={b.x}
                    y={b.y}
                    width={b.w}
                    height={b.h}
                    rx="1"
                    ry="1"
                    fill="hsl(var(--foreground))"
                    fillOpacity="0.55"
                    style={{
                        animation: `jl-map-building-pop ${SHARED}`,
                        animationDelay: `${b.delay}s`,
                        transformOrigin: `${b.x + b.w / 2}px ${b.y + b.h}px`,
                    }}
                />
            ))}

            {/* Pin — drops at the centre after the map is laid out.
                Two parts: the teardrop body and a small hole, plus a
                tiny shadow ellipse beneath for grounding. */}
            <g
                style={{
                    animation: `jl-map-pin-bob ${SHARED}`,
                    transformOrigin: "100px 60px",
                }}
            >
                <ellipse
                    cx="100"
                    cy="68"
                    rx="6"
                    ry="1.6"
                    fill="hsl(var(--foreground))"
                    fillOpacity="0.25"
                />
                <path
                    d="M 100 38 C 92 38 86 44 86 52 C 86 60 100 66 100 66 C 100 66 114 60 114 52 C 114 44 108 38 100 38 Z"
                    fill="hsl(var(--primary))"
                />
                <circle cx="100" cy="50" r="3.5" fill="hsl(var(--background))" />
            </g>
        </svg>
    );
}

export default MapLoader;
