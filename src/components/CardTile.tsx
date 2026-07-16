import { Check } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import type { GameSize } from "@/lib/gameSetup";
import type { Card, PowerupKind } from "@/lib/hiderDeck";
import { cn } from "@/lib/utils";

/**
 * Visual card-tile rendering for the hider deck. Designed to match
 * the physical Jet Lag cards as faithfully as possible:
 *
 *   - Pure white card body with a thin border and rounded corners
 *   - Dark navy typography (the JetLag brand `#1F2F3F`)
 *   - Bold uppercase title in inter-tight black, wrapping to multiple
 *     lines if the name is long
 *   - Hexagonal icons for time-bonus + powerup cards; curses have no
 *     icon and lead with the "CURSE OF THE …" title instead
 *   - Inline colored S/M/L badges (yellow / orange / red) embedded in
 *     description text, with only the current game-size's value
 *     visible — the physical cards have to show all three because
 *     they're size-agnostic, the digital UI knows the size and
 *     collapses the triplet
 *
 * Used in the hand panel, hand-picker dialog, draw-picker dialog,
 * and discard-pile preview.
 */

/* ────────────────── Brand palette ────────────────── */

const NAVY = "#1F2F3F";
// Veto's prohibition glyph is red on the physical card.
const CARD_RED = "#DC3D38";
const SIZE_BG: Record<GameSize, string> = {
    small: "hsl(44 87% 60%)", // yellow
    medium: "hsl(22 82% 56%)", // orange
    large: "hsl(2 70% 52%)", // red — matches brand primary
};
const SIZE_FG: Record<GameSize, string> = {
    small: NAVY, // yellow is too light for white text
    medium: "#ffffff",
    large: "#ffffff",
};
const SIZE_LETTER: Record<GameSize, string> = {
    small: "S",
    medium: "M",
    large: "L",
};
// Clock-wedge tier per time-bonus size (matched to the printed cards:
// bigger bonuses show a larger pie wedge in a "cooler" colour).
const TIER_METER: { threshold: number; color: string; sweepDeg: number }[] = [
    { threshold: 30, color: "#3B82F6", sweepDeg: 170 }, // blue
    { threshold: 20, color: "#22C55E", sweepDeg: 130 }, // green
    { threshold: 15, color: "#EAA13C", sweepDeg: 100 }, // amber
    { threshold: 10, color: "#E2854A", sweepDeg: 65 }, // orange
    { threshold: 0, color: "#DC3D38", sweepDeg: 38 }, // small red wedge
];

/* ────────────────── Scale-invariant sizing ────────────────── */

/**
 * v912: every card renders ONE canonical layout at ANY display size —
 * a mini card in the hand is literally the full carousel card SHRUNK,
 * like a photo resized, never a re-laid-out "compact" variant. This is
 * achieved with CSS **container query units** (`cqw` = 1% of the card's
 * own width): the card root is a query container (`container-type:
 * inline-size`) and EVERY font-size / padding / icon / gap below is
 * expressed in `cqw`, so the whole thing scales as one with the card's
 * width (its height follows from the fixed 5:7 aspect). No `size` prop
 * changes the layout anymore.
 *
 * The numbers below are `px ÷ 3` — chosen so a ~300 px-wide full card
 * matches the old absolute pixel sizes, and every smaller/larger render
 * is a faithful proportional scale of it.
 */
const cu = (n: number) => `${n}cqw`;

/* ────────────────── Public API ────────────────── */

/** @deprecated Kept only so old `size="compact"` call-sites still type
 *  — the card no longer re-lays-out by size (v912). */
export type CardTileSize = "default" | "compact";

export function CardTile({
    card,
    gameSize,
    selected,
    onClick,
    selectionIndicator = "checkbox",
    footer,
    className,
    ariaLabel,
}: {
    card: Card;
    gameSize: GameSize;
    /** @deprecated no longer changes the layout — see the v912 note. */
    size?: CardTileSize;
    selected?: boolean;
    onClick?: () => void;
    selectionIndicator?: "checkbox" | "ring" | "none";
    footer?: ReactNode;
    className?: string;
    ariaLabel?: string;
}) {
    const interactive = Boolean(onClick);
    const Wrapper = interactive ? "button" : "div";
    const wrapperProps = interactive
        ? {
              type: "button" as const,
              onClick,
              "aria-pressed": selected,
              "aria-label": ariaLabel,
          }
        : {};

    return (
        <Wrapper
            {...wrapperProps}
            className={cn(
                "relative flex flex-col overflow-hidden text-left",
                "bg-white border border-zinc-300 shadow-sm",
                // Poker-card proportions (2.5" × 3.5", 5:7). Held
                // uniformly across every surface that renders a card
                // — fan miniature, hand grid, draw picker, discard
                // pile — so the digital cards always read as the
                // physical ones (v289).
                "aspect-[5/7]",
                interactive &&
                    "transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                interactive && "hover:shadow-md",
                selected &&
                    selectionIndicator !== "none" &&
                    "ring-2 ring-primary ring-offset-2 ring-offset-background",
                className,
            )}
            // `containerType: inline-size` makes `cqw` below resolve to
            // this card's own width; `borderRadius` in cqw so the corner
            // radius scales with the card too (a mini card isn't more
            // rounded than a full one).
            style={{
                color: NAVY,
                containerType: "inline-size",
                borderRadius: cu(4),
            }}
        >
            {/* Selection checkmark — floats in the top-right corner so
                it doesn't compete with the title or icon for layout
                space. Only visible when the parent picker enabled the
                checkbox indicator and the card is selected. */}
            {selected && selectionIndicator === "checkbox" && (
                <span
                    className="absolute inline-flex items-center justify-center rounded-sm bg-primary text-primary-foreground z-10"
                    style={{
                        top: cu(2.7),
                        right: cu(2.7),
                        width: cu(6.7),
                        height: cu(6.7),
                    }}
                    aria-hidden="true"
                >
                    <Check style={{ width: cu(4.7), height: cu(4.7) }} />
                </span>
            )}

            {card.kind === "time-bonus" && (
                <TimeBonusBody card={card} gameSize={gameSize} />
            )}
            {card.kind === "powerup" && (
                <PowerupBody card={card} gameSize={gameSize} />
            )}
            {card.kind === "curse" && (
                <CurseBody card={card} gameSize={gameSize} />
            )}

            {footer && (
                <div
                    className="border-t border-zinc-200 bg-zinc-50"
                    style={{ padding: `${cu(2.7)} ${cu(3.3)}` }}
                >
                    {footer}
                </div>
            )}
        </Wrapper>
    );
}

/* ────────────────── Per-kind bodies ────────────────── */

function TimeBonusBody({
    card,
    gameSize,
}: {
    card: Extract<Card, { kind: "time-bonus" }>;
    gameSize: GameSize;
}) {
    // Faithful to the physical card: the tilted clock-hexagon icon (with
    // the "+" badge overlapping its lower-left) at the top, the stacked
    // "TIME / BONUS" title, then the calendar-style minute badge at the
    // bottom. The printed card shows all three S/M/L badges because it
    // can't know the game size; the digital card knows, so it shows ONLY
    // the active size's badge (per the user's direction). All cqw.
    return (
        <div
            className="flex-1 flex flex-col items-center text-center"
            style={{ padding: cu(5.3), paddingTop: cu(7) }}
        >
            <ClockHexIcon largest={card.minutes.large} cqw={40} />
            <div
                className="font-inter-tight font-black uppercase tracking-tight leading-[0.98]"
                style={{ color: NAVY, fontSize: cu(9.3), marginTop: cu(4) }}
            >
                <div>Time</div>
                <div>Bonus</div>
            </div>
            <div style={{ marginTop: "auto", paddingTop: cu(3) }}>
                <SizeMinutesBadge
                    size={gameSize}
                    minutes={card.minutes[gameSize]}
                />
            </div>
        </div>
    );
}

function PowerupBody({
    card,
    gameSize,
}: {
    card: Extract<Card, { kind: "powerup" }>;
    gameSize: GameSize;
}) {
    // Physical layout: hex icon at top-centre, title below, description
    // below that — top-anchored, all cqw so it scales as one.
    return (
        <div
            className="flex-1 flex flex-col min-h-0"
            style={{ padding: cu(5.3) }}
        >
            <div
                className="flex justify-center shrink-0"
                style={{ marginTop: cu(2) }}
            >
                <PowerupGlyph powerup={card.powerup} cqw={36} />
            </div>
            <div
                className="font-inter-tight font-black uppercase tracking-tight leading-[0.98] text-center shrink-0"
                style={{ color: NAVY, fontSize: cu(7), marginTop: cu(4) }}
            >
                {card.name}
            </div>
            {/* Scroll within the card if the description overflows (v306
                safety net); short ones just sit under the title. */}
            <div
                className="flex-1 min-h-0 overflow-y-auto"
                style={{ marginTop: cu(2.7) }}
            >
                <p
                    className="leading-snug text-center"
                    style={{ color: NAVY, fontSize: cu(3.7) }}
                >
                    {renderBodyText(card.description, gameSize)}
                </p>
            </div>
        </div>
    );
}

function CurseBody({
    card,
    gameSize,
}: {
    card: Extract<Card, { kind: "curse" }>;
    gameSize: GameSize;
}) {
    // Physical layout: "CURSE OF THE …" name at top-left, description
    // below, casting cost pinned at the bottom. All cqw so it scales.
    return (
        <div
            className="flex-1 flex flex-col min-h-0"
            style={{ padding: cu(4.7) }}
        >
            <div
                className="font-inter-tight font-black uppercase tracking-tight leading-[0.95] shrink-0"
                style={{ color: NAVY, fontSize: cu(4.7) }}
            >
                {card.name}
            </div>
            <div
                className="flex-1 min-h-0 overflow-y-auto"
                style={{ marginTop: cu(2.7) }}
            >
                <p
                    className="leading-snug"
                    style={{ color: NAVY, fontSize: cu(3.7) }}
                >
                    {renderBodyText(card.description, gameSize)}
                </p>
            </div>
            {card.castingCost && (
                <p
                    className="leading-snug border-t border-zinc-200 shrink-0"
                    style={{
                        color: NAVY,
                        fontSize: cu(3.3),
                        marginTop: cu(2.7),
                        paddingTop: cu(2.7),
                    }}
                >
                    <span className="font-bold">Casting cost:</span>{" "}
                    {renderBodyText(card.castingCost, gameSize)}
                </p>
            )}
        </div>
    );
}

/* ────────────────── Card icons (SVG, matched to the physical cards) ────────────────── */

const ICON_FONT = "Poppins, system-ui, sans-serif";

function pointOnCircle(
    cx: number,
    cy: number,
    r: number,
    deg: number,
): [number, number] {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** SVG path for a pie slice (clock wedge) from `startDeg`, sweeping
 *  clockwise by `sweepDeg`. */
function pieSlice(
    cx: number,
    cy: number,
    r: number,
    startDeg: number,
    sweepDeg: number,
): string {
    const [sx, sy] = pointOnCircle(cx, cy, r, startDeg);
    const [ex, ey] = pointOnCircle(cx, cy, r, startDeg + sweepDeg);
    const large = sweepDeg > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)} Z`;
}

/**
 * The Time Bonus clock, drawn to match the printed card: a TILTED thick
 * navy hexagon, an upright clock face inside it (short radial tick marks
 * + a colored pie WEDGE from 12 o'clock whose sweep grows with the bonus
 * tier), and a big solid-navy "+" badge overlapping the hexagon's
 * LOWER-LEFT edge with a white knockout ring separating the two.
 */
function ClockHexIcon({
    largest,
    cqw = 20,
}: {
    largest: number;
    /** Icon size as a container-query-width unit (scales with the card). */
    cqw?: number;
}) {
    const tier =
        TIER_METER.find((t) => largest >= t.threshold) ?? TIER_METER[TIER_METER.length - 1];
    const cx = 52;
    const cy = 47;
    return (
        <div
            className="relative inline-flex items-center justify-center shrink-0"
            style={{ width: cu(cqw), height: cu(cqw) }}
        >
            <svg
                viewBox="0 0 100 100"
                className="absolute inset-0 w-full h-full"
                aria-hidden="true"
            >
                {/* tilted hexagon shell (the clock face stays upright) */}
                <polygon
                    points="52,9 85,26 88,62 52,85 19,68 16,32"
                    fill="none"
                    stroke={NAVY}
                    strokeWidth="7"
                    strokeLinejoin="round"
                />
                {/* colored wedge from 12 o'clock, sweeping clockwise */}
                <path
                    d={pieSlice(cx, cy, 21, -90, tier.sweepDeg)}
                    fill={tier.color}
                />
                {/* short radial tick marks around the face */}
                {Array.from({ length: 12 }).map((_, i) => {
                    const [x1, y1] = pointOnCircle(cx, cy, 25, i * 30 - 90);
                    const [x2, y2] = pointOnCircle(cx, cy, 30, i * 30 - 90);
                    return (
                        <line
                            key={i}
                            x1={x1.toFixed(1)}
                            y1={y1.toFixed(1)}
                            x2={x2.toFixed(1)}
                            y2={y2.toFixed(1)}
                            stroke={NAVY}
                            strokeWidth="3"
                            strokeLinecap="round"
                        />
                    );
                })}
                {/* "+" badge overlapping the lower-left edge: white knockout
                    ring first, then the solid navy circle + white plus */}
                <circle cx="27" cy="70" r="23" fill="#ffffff" />
                <circle cx="27" cy="70" r="18.5" fill={NAVY} />
                <path
                    d="M 18.5 70 H 35.5 M 27 61.5 V 78.5"
                    stroke="#ffffff"
                    strokeWidth="5.5"
                    strokeLinecap="round"
                />
            </svg>
        </div>
    );
}

/** A rounded-rect "card" drawn TWICE — a fat white understroke first, then
 *  the colored outline — so it knocks out whatever it overlaps (the white
 *  separation rings the printed icons use everywhere). */
function knockoutRect(
    x: number,
    y: number,
    w: number,
    h: number,
    rotate: string,
    color: string,
): ReactNode {
    const common = { x, y, width: w, height: h, rx: 5, transform: rotate };
    return (
        <>
            <rect {...common} fill="#ffffff" stroke="#ffffff" strokeWidth="13" />
            <rect {...common} fill="#ffffff" stroke={color} strokeWidth="5" />
        </>
    );
}

/** Teardrop location-pin path: circle of radius `r` at (cx, cy) with the
 *  tip at cy + 2.1r. */
function pinPath(cx: number, cy: number, r: number): string {
    return (
        `M ${cx} ${cy + 2.1 * r}` +
        ` C ${cx - 1.05 * r} ${cy + r * 0.9} ${cx - r} ${cy + r * 0.55} ${cx - r} ${cy}` +
        ` A ${r} ${r} 0 1 1 ${cx + r} ${cy}` +
        ` C ${cx + r} ${cy + r * 0.55} ${cx + 1.05 * r} ${cy + r * 0.9} ${cx} ${cy + 2.1 * r} Z`
    );
}

/**
 * Fanned-cards glyph (the discard/draw/expand powerups), matching the
 * printed icon: a tilted hexagon, three fanned outline cards, an OUTLINED
 * white circle bottom-left with the draw count ("+2"), and a SOLID navy
 * circle top-right with the hand delta ("-1"). White knockout rings
 * separate every overlap.
 */
function cardsGlyph(drawLabel: string, deltaLabel: string): ReactNode {
    return (
        <>
            <polygon
                points="50,6 87,21 91,60 56,90 19,75 11,34"
                fill="none"
                stroke={NAVY}
                strokeWidth="6.5"
                strokeLinejoin="round"
            />
            {knockoutRect(30, 26, 23, 33, "rotate(-20 41 42)", NAVY)}
            {knockoutRect(41, 26, 23, 33, "rotate(-7 52 42)", NAVY)}
            {knockoutRect(52, 28, 23, 33, "rotate(6 63 44)", NAVY)}
            {/* draw badge — outlined circle, bottom-left */}
            <circle cx="24" cy="73" r="21" fill="#ffffff" />
            <circle
                cx="24"
                cy="73"
                r="16.5"
                fill="#ffffff"
                stroke={NAVY}
                strokeWidth="5"
            />
            <text
                x="24"
                y="78"
                textAnchor="middle"
                fontSize="14"
                fontWeight="800"
                fill={NAVY}
                fontFamily={ICON_FONT}
            >
                {drawLabel}
            </text>
            {/* hand-delta badge — solid circle, top-right */}
            <circle cx="80" cy="20" r="18.5" fill="#ffffff" />
            <circle cx="80" cy="20" r="14" fill={NAVY} />
            <text
                x="80"
                y="24.5"
                textAnchor="middle"
                fontSize="13"
                fontWeight="800"
                fill="#ffffff"
                fontFamily={ICON_FONT}
            >
                {deltaLabel}
            </text>
        </>
    );
}

function renderPowerupGlyph(powerup: PowerupKind): ReactNode {
    switch (powerup) {
        case "veto":
            // All-red: hexagon, a tilted card inside it, and a slash through
            // both (the printed "ø card" mark) with white knockouts.
            return (
                <>
                    <polygon
                        points="50,8 85,25 87,61 52,88 17,70 14,33"
                        fill="none"
                        stroke={CARD_RED}
                        strokeWidth="6.5"
                        strokeLinejoin="round"
                    />
                    {knockoutRect(37, 29, 26, 38, "rotate(10 50 48)", CARD_RED)}
                    <line
                        x1="30"
                        y1="76"
                        x2="71"
                        y2="21"
                        stroke="#ffffff"
                        strokeWidth="10"
                        strokeLinecap="round"
                    />
                    <line
                        x1="30"
                        y1="76"
                        x2="71"
                        y2="21"
                        stroke={CARD_RED}
                        strokeWidth="6"
                        strokeLinecap="round"
                    />
                </>
            );
        case "move":
            // Two location pins in a hexagon — outline pin behind,
            // solid pin (with a white dot) in front.
            return (
                <>
                    <polygon
                        points="50,8 84,28 82,64 50,88 16,66 18,28"
                        fill="none"
                        stroke={NAVY}
                        strokeWidth="7"
                        strokeLinejoin="round"
                    />
                    <path
                        d={pinPath(41, 42, 11)}
                        fill="#ffffff"
                        stroke={NAVY}
                        strokeWidth="5"
                        strokeLinejoin="round"
                    />
                    <path
                        d={pinPath(57, 45, 13)}
                        fill={NAVY}
                        stroke="#ffffff"
                        strokeWidth="4"
                        strokeLinejoin="round"
                    />
                    <circle cx="57" cy="44.5" r="5" fill="#ffffff" />
                </>
            );
        case "randomize":
            // Isometric die: 2 pips on the top face, 1 on the right face,
            // and a "?" on the left face.
            return (
                <>
                    <polygon
                        points="50,16 78,31 50,46 22,31"
                        fill="#ffffff"
                        stroke={NAVY}
                        strokeWidth="5.5"
                        strokeLinejoin="round"
                    />
                    <polygon
                        points="22,31 50,46 50,80 22,65"
                        fill="#ffffff"
                        stroke={NAVY}
                        strokeWidth="5.5"
                        strokeLinejoin="round"
                    />
                    <polygon
                        points="50,46 78,31 78,65 50,80"
                        fill="#ffffff"
                        stroke={NAVY}
                        strokeWidth="5.5"
                        strokeLinejoin="round"
                    />
                    <ellipse cx="43" cy="28" rx="4.4" ry="2.8" fill={NAVY} />
                    <ellipse cx="57" cy="34" rx="4.4" ry="2.8" fill={NAVY} />
                    <ellipse cx="64" cy="55" rx="3" ry="4.2" fill={NAVY} />
                    <text
                        x="36"
                        y="67"
                        textAnchor="middle"
                        fontSize="19"
                        fontWeight="800"
                        fill={NAVY}
                        fontFamily={ICON_FONT}
                        transform="rotate(8 36 62)"
                    >
                        ?
                    </text>
                </>
            );
        case "duplicate":
            // A card copied to a second card, "+" on the front copy.
            return (
                <>
                    {knockoutRect(29, 29, 27, 39, "rotate(-10 42 48)", NAVY)}
                    {knockoutRect(45, 32, 27, 39, "rotate(6 58 51)", NAVY)}
                    <path
                        d="M 52 51 H 66 M 59 44 V 58"
                        stroke={NAVY}
                        strokeWidth="5"
                        strokeLinecap="round"
                        transform="rotate(6 58 51)"
                    />
                </>
            );
        case "discard1draw2":
            return cardsGlyph("+2", "-1");
        case "discard2draw3":
            return cardsGlyph("+3", "-2");
        case "draw1expand":
            return cardsGlyph("+1", "+1");
    }
}

/**
 * Powerup icon — a custom SVG per powerup, drawn to resemble the printed
 * card's glyph (Veto's red prohibition hexagon, the overlapping-cards
 * discard/draw badges, the die-with-? randomize, the location-pin Move…)
 * rather than a generic Lucide stand-in.
 */
function PowerupGlyph({
    powerup,
    cqw = 20,
}: {
    powerup: PowerupKind;
    /** Icon size as a container-query-width unit (scales with the card). */
    cqw?: number;
}) {
    return (
        <svg
            viewBox="0 0 100 100"
            className="shrink-0"
            style={{ width: cu(cqw), height: cu(cqw) }}
            aria-hidden="true"
        >
            {renderPowerupGlyph(powerup)}
        </svg>
    );
}

/* ────────────────── Inline size badge ────────────────── */

/**
 * Small rounded rectangle showing a size + value (+ optional unit).
 * Matches the physical cards' inline S/M/L style. Rendered inline in
 * body text where the description originally said `S X M Y L Z` (or
 * the legacy `X (S) / Y (M) / Z (L)` format), with only the current
 * game-size's value visible.
 */
function SizeBadge({
    size,
    value,
    unit,
}: {
    size: GameSize;
    value: string;
    unit?: string;
}) {
    // v912: sized in `em` (relative to the surrounding description text,
    // itself sized in cqw) so the inline badge scales WITH the card —
    // a mini card's badges shrink in lockstep, no fixed px.
    const style: CSSProperties = {
        backgroundColor: SIZE_BG[size],
        color: SIZE_FG[size],
        fontSize: "0.82em",
        padding: "0.08em 0.35em",
        margin: "0 0.15em",
        gap: "0.15em",
        letterSpacing: "0.04em",
    };
    return (
        <span
            className="inline-flex items-baseline rounded-sm font-poppins font-bold uppercase align-baseline"
            style={style}
        >
            <span>{SIZE_LETTER[size]}</span>
            <span className="tabular-nums">{value}</span>
            {unit && (
                <span style={{ fontSize: "0.85em", opacity: 0.9 }}>
                    {unit}
                </span>
            )}
        </span>
    );
}

/**
 * The Time Bonus minute badge, drawn like the printed card's
 * calendar-page badges: a colored rounded-rect border, a SOLID colored
 * header band with the size letter in white, and a white body with the
 * big colored minutes value over a small colored "MIN". The physical card
 * prints all three S/M/L badges; the digital card shows only the active
 * game size's. Sized in cqw so it scales with the card.
 */
function SizeMinutesBadge({
    size,
    minutes,
}: {
    size: GameSize;
    minutes: number;
}) {
    const color = SIZE_BG[size];
    return (
        <div
            className="flex flex-col items-stretch overflow-hidden leading-none bg-white"
            style={{
                minWidth: cu(21),
                border: `${cu(0.9)} solid ${color}`,
                borderRadius: cu(2.7),
            }}
        >
            <div
                className="font-poppins font-bold uppercase text-center"
                style={{
                    backgroundColor: color,
                    color: "#ffffff",
                    fontSize: cu(4),
                    padding: `${cu(0.9)} 0 ${cu(1.1)}`,
                }}
            >
                {SIZE_LETTER[size]}
            </div>
            <div
                className="flex flex-col items-center"
                style={{ padding: `${cu(1.2)} ${cu(2)} ${cu(1.6)}`, gap: cu(0.5) }}
            >
                <span
                    className="font-inter-tight font-black tabular-nums"
                    style={{ color, fontSize: cu(9) }}
                >
                    {minutes}
                </span>
                <span
                    className="font-poppins font-bold uppercase"
                    style={{ color, fontSize: cu(3), letterSpacing: "0.08em" }}
                >
                    Min
                </span>
            </div>
        </div>
    );
}

/* ────────────────── Body-text rendering with inline badges ────────────────── */

/**
 * Render a card's body text with size-conditional values replaced by
 * inline `<SizeBadge>` chips. Recognises two source patterns:
 *
 *   - Physical-card format: `S 0.5 M 0.5 L 1 km` — three size tokens
 *     in a row, optionally followed by a shared trailing unit word.
 *   - Legacy transcription format: `X-min (S) / Y-min (M) / Z-min (L)`
 *     — what I'd been writing in the deck data file before seeing
 *     the actual card images.
 *
 * Both collapse to a single inline badge showing just the current
 * game-size's value (per the user's directive — the physical card
 * has to show all three because it doesn't know the size, but the
 * digital UI does).
 */
export function renderBodyText(text: string, gameSize: GameSize): ReactNode {
    // Value shape, in two parts so decimals work cleanly:
    //   1. The numeric portion — one or more digits, optionally
    //      followed by `.<digits>` for decimals. Required.
    //   2. An optional unit — separated from the number by either a
    //      hyphen (`10-minute`) or a single space (`0.5 h`,
    //      `30 minutes`).
    // This catches all four formats the deck uses:
    //   `30`, `10-minute`, `0.5`, `0.5 h`.
    // An earlier version used `[\d.][\w-]*` which broke on decimals
    // because `\w` doesn't include `.`, so "0.5" would only match
    // "0" and the legacy `(S)/(M)/(L)` regex stopped matching.
    const valueShape = `\\d+(?:\\.\\d+)?(?:[\\s-]\\w+)?`;

    // Normalise the legacy `VAL (S) / VAL (M) / VAL (L)` format to
    // the physical `S VAL M VAL L VAL` format so we only have one
    // tokeniser to maintain. The legacy pattern is how I'd
    // originally transcribed the cards into the deck before seeing
    // the actual card photos.
    const legacyPattern = new RegExp(
        `(${valueShape})\\s*\\(S\\)\\s*\\/\\s*(${valueShape})\\s*\\(M\\)\\s*\\/\\s*(${valueShape})\\s*\\(L\\)`,
        "g",
    );
    const normalised = text.replace(legacyPattern, (_, s, m, l) => {
        // The values may already include their unit (e.g. "0.5 h"),
        // so the trailing shared-unit isn't needed when normalising.
        return `S ${s} M ${m} L ${l}`;
    });

    // Now scan for `S <val> M <val> L <val>` triples, optionally
    // followed by a shared trailing unit word (the physical-card
    // format `S 30 M 45 L 60 minutes`). The values themselves may
    // also already carry their own units (after legacy
    // normalisation), in which case the trailing capture is empty.
    const triplePattern = new RegExp(
        `S\\s+(${valueShape})\\s+M\\s+(${valueShape})\\s+L\\s+(${valueShape})(?:\\s+(\\w+))?`,
        "g",
    );
    const nodes: ReactNode[] = [];
    let cursor = 0;
    let counter = 0;
    let m: RegExpExecArray | null;
    while ((m = triplePattern.exec(normalised)) !== null) {
        if (m.index > cursor) {
            nodes.push(normalised.slice(cursor, m.index));
        }
        const [, sVal, mVal, lVal, sharedUnit] = m;
        // Value-embedded units win over the shared-trailing unit —
        // i.e. "0.5 h" already has its unit, no need to add another.
        const value =
            gameSize === "small"
                ? sVal
                : gameSize === "medium"
                  ? mVal
                  : lVal;
        const valueHasUnit = /\s\w+$/.test(value);
        nodes.push(
            <SizeBadge
                key={`b-${counter++}`}
                size={gameSize}
                value={valueHasUnit ? value : value}
                unit={valueHasUnit ? undefined : sharedUnit}
            />,
        );
        cursor = m.index + m[0].length;
    }
    if (cursor < normalised.length) {
        nodes.push(normalised.slice(cursor));
    }
    return nodes.length > 0 ? nodes : normalised;
}

/* ────────────────── Backwards-compatible export ────────────────── */

/**
 * Legacy helper that still exists for any caller that wants a
 * plain-string formatted description (no inline badge JSX). Keeps
 * the old `formatDescriptionForSize` name; the body-renderer above
 * is what the card surfaces actually use.
 */
export function formatDescriptionForSize(
    description: string,
    size: GameSize,
): string {
    const legacyPattern =
        /([\d.][\w-]*)\s*\(S\)\s*\/\s*([\d.][\w-]*)\s*\(M\)\s*\/\s*([\d.][\w-]*)\s*\(L\)/g;
    const triplePattern =
        /S\s+([\d.][\w-]*)\s+M\s+([\d.][\w-]*)\s+L\s+([\d.][\w-]*)/g;
    return description
        .replace(legacyPattern, (_, s, m, l) =>
            size === "small" ? s : size === "medium" ? m : l,
        )
        .replace(triplePattern, (_, s, m, l) =>
            size === "small" ? s : size === "medium" ? m : l,
        );
}

export default CardTile;
