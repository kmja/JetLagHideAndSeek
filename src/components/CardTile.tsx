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
const TIER_METER: { threshold: number; color: string; fillFrac: number }[] = [
    { threshold: 30, color: "#3B82F6", fillFrac: 0.85 }, // blue
    { threshold: 20, color: "#22C55E", fillFrac: 0.62 }, // green
    { threshold: 15, color: "#E2854A", fillFrac: 0.45 }, // orange
    { threshold: 10, color: "#DC3D38", fillFrac: 0.3 }, // red
    { threshold: 0, color: "#DC3D38", fillFrac: 0.14 }, // small red triangle
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
    // Faithful to the physical card: the clock-hexagon icon at TOP, the
    // "TIME BONUS" title, then the three S/M/L minute badges pinned at the
    // BOTTOM. All sizes are cqw so a mini card is this exact layout shrunk.
    const sizes: GameSize[] = ["small", "medium", "large"];
    return (
        <div
            className="flex-1 flex flex-col items-center text-center"
            style={{ padding: cu(4.7) }}
        >
            <ClockHexIcon largest={card.minutes.large} cqw={31} />
            <div
                className="font-inter-tight font-black uppercase tracking-tight leading-[0.95]"
                style={{ color: NAVY, fontSize: cu(8), marginTop: cu(3) }}
            >
                Time Bonus
            </div>
            <div
                className="flex items-stretch justify-center w-full"
                style={{ gap: cu(1.6), marginTop: "auto" }}
            >
                {sizes.map((sz) => (
                    <SizeMinutesBadge
                        key={sz}
                        size={sz}
                        minutes={card.minutes[sz]}
                        active={sz === gameSize}
                    />
                ))}
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
            <div className="flex justify-center shrink-0">
                <PowerupGlyph powerup={card.powerup} cqw={27} />
            </div>
            <div
                className="font-inter-tight font-black uppercase tracking-tight leading-[0.95] text-center shrink-0"
                style={{ color: NAVY, fontSize: cu(6), marginTop: cu(4) }}
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

// Flat-sided hexagon used by the Time Bonus clock, Veto, and Move icons.
const HEX_PTS = "50,6 90,28 90,72 50,94 10,72 10,28";
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
 * The Time Bonus clock — a hexagon with clock ticks, a colored pie WEDGE
 * whose sweep grows with the bonus tier (the physical card's "how much
 * time" meter), and a navy "+" hub at the centre. Matches the printed card
 * much more closely than the old scaled-solid-hexagon.
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
    const cx = 50;
    const cy = 50;
    const faceR = 30;
    const sweep = 30 + tier.fillFrac * 220; // ~60° (small) .. ~217° (big)
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
                <polygon
                    points={HEX_PTS}
                    fill="none"
                    stroke={NAVY}
                    strokeWidth="6"
                    strokeLinejoin="round"
                />
                {/* colored wedge from 12 o'clock, sweeping clockwise */}
                <path d={pieSlice(cx, cy, faceR, -90, sweep)} fill={tier.color} />
                {/* clock ticks just inside the hexagon */}
                {Array.from({ length: 12 }).map((_, i) => {
                    const [x1, y1] = pointOnCircle(cx, cy, faceR + 3, i * 30);
                    const [x2, y2] = pointOnCircle(cx, cy, faceR + 7, i * 30);
                    return (
                        <line
                            key={i}
                            x1={x1.toFixed(1)}
                            y1={y1.toFixed(1)}
                            x2={x2.toFixed(1)}
                            y2={y2.toFixed(1)}
                            stroke={NAVY}
                            strokeWidth="2.4"
                            strokeLinecap="round"
                        />
                    );
                })}
                {/* navy "+" hub at the centre */}
                <circle cx={cx} cy={cy} r="12" fill={NAVY} />
                <path
                    d={`M ${cx - 6} ${cy} H ${cx + 6} M ${cx} ${cy - 6} V ${cy + 6}`}
                    stroke="#ffffff"
                    strokeWidth="3.6"
                    strokeLinecap="round"
                />
            </svg>
        </div>
    );
}

/** Overlapping-cards glyph (the discard/draw/expand powerups) with a
 *  draw badge (top-left) and a keep/expand badge (top-right). */
function cardsGlyph(drawLabel: string, keepLabel: string): ReactNode {
    return (
        <>
            <rect
                x="30"
                y="40"
                width="26"
                height="36"
                rx="4.5"
                fill="#ffffff"
                stroke={NAVY}
                strokeWidth="5"
                transform="rotate(-10 43 58)"
            />
            <rect
                x="44"
                y="34"
                width="26"
                height="36"
                rx="4.5"
                fill="#ffffff"
                stroke={NAVY}
                strokeWidth="5"
            />
            <circle cx="30" cy="33" r="13" fill={NAVY} />
            <text
                x="30"
                y="38.5"
                textAnchor="middle"
                fontSize="15"
                fontWeight="800"
                fill="#ffffff"
                fontFamily={ICON_FONT}
            >
                {drawLabel}
            </text>
            <circle cx="72" cy="30" r="11" fill={NAVY} />
            <text
                x="72"
                y="34.8"
                textAnchor="middle"
                fontSize="13"
                fontWeight="800"
                fill="#ffffff"
                fontFamily={ICON_FONT}
            >
                {keepLabel}
            </text>
        </>
    );
}

function renderPowerupGlyph(powerup: PowerupKind): ReactNode {
    switch (powerup) {
        case "veto":
            // Red prohibition sign in a red hexagon.
            return (
                <>
                    <polygon
                        points={HEX_PTS}
                        fill="none"
                        stroke={CARD_RED}
                        strokeWidth="6"
                        strokeLinejoin="round"
                    />
                    <circle
                        cx="50"
                        cy="50"
                        r="18"
                        fill="none"
                        stroke={CARD_RED}
                        strokeWidth="6"
                    />
                    <line
                        x1="38"
                        y1="62"
                        x2="62"
                        y2="38"
                        stroke={CARD_RED}
                        strokeWidth="6"
                        strokeLinecap="round"
                    />
                </>
            );
        case "move":
            // Location pin inside a hexagon.
            return (
                <>
                    <polygon
                        points={HEX_PTS}
                        fill="none"
                        stroke={NAVY}
                        strokeWidth="6"
                        strokeLinejoin="round"
                    />
                    <path
                        d="M50 31 C41.7 31 35 37.7 35 46 C35 57 50 70 50 70 C50 70 65 57 65 46 C65 37.7 58.3 31 50 31 Z"
                        fill={NAVY}
                    />
                    <circle cx="50" cy="45.5" r="5.5" fill="#ffffff" />
                </>
            );
        case "randomize":
            // A die face with a "?".
            return (
                <>
                    <rect
                        x="25"
                        y="25"
                        width="50"
                        height="50"
                        rx="12"
                        fill="none"
                        stroke={NAVY}
                        strokeWidth="6"
                    />
                    <circle cx="38" cy="38" r="4.2" fill={NAVY} />
                    <circle cx="62" cy="62" r="4.2" fill={NAVY} />
                    <text
                        x="50"
                        y="60"
                        textAnchor="middle"
                        fontSize="30"
                        fontWeight="800"
                        fill={NAVY}
                        fontFamily={ICON_FONT}
                    >
                        ?
                    </text>
                </>
            );
        case "duplicate":
            // A card copied to a second card (a "+").
            return (
                <>
                    <rect
                        x="28"
                        y="38"
                        width="30"
                        height="40"
                        rx="5"
                        fill="#ffffff"
                        stroke={NAVY}
                        strokeWidth="5"
                    />
                    <rect
                        x="42"
                        y="28"
                        width="30"
                        height="40"
                        rx="5"
                        fill="#ffffff"
                        stroke={NAVY}
                        strokeWidth="5"
                    />
                    <path
                        d="M57 40 V56 M49 48 H65"
                        stroke={NAVY}
                        strokeWidth="5"
                        strokeLinecap="round"
                    />
                </>
            );
        case "discard1draw2":
            return cardsGlyph("+2", "1");
        case "discard2draw3":
            return cardsGlyph("+3", "2");
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
 * One S/M/L minute badge for the Time Bonus card's bottom row — a colored
 * chip (yellow / orange / red, like the printed card) with the size letter,
 * the big minutes value, and "MIN". The chip for the active game size is
 * ringed (the digital card knows the size), while all three still show for
 * fidelity to the physical card. Sized in cqw so it scales with the card.
 */
function SizeMinutesBadge({
    size,
    minutes,
    active,
}: {
    size: GameSize;
    minutes: number;
    active?: boolean;
}) {
    return (
        <div
            className="flex flex-col items-center justify-center leading-none"
            style={{
                backgroundColor: SIZE_BG[size],
                color: SIZE_FG[size],
                flex: "1 1 0",
                borderRadius: cu(1.6),
                padding: `${cu(1.4)} ${cu(1)}`,
                gap: cu(0.6),
                boxShadow: active ? `0 0 0 ${cu(0.7)} ${NAVY}` : undefined,
            }}
        >
            <span
                className="font-poppins font-bold uppercase"
                style={{ fontSize: cu(2.7), opacity: 0.85 }}
            >
                {SIZE_LETTER[size]}
            </span>
            <span
                className="font-inter-tight font-black tabular-nums"
                style={{ fontSize: cu(6.5) }}
            >
                {minutes}
            </span>
            <span
                className="font-poppins font-bold uppercase"
                style={{ fontSize: cu(2.2), opacity: 0.85 }}
            >
                Min
            </span>
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
