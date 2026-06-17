import type { LucideIcon } from "lucide-react";
import { Ban, Check, Copy, Dices, Layers, MapPinned, Plus } from "lucide-react";
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

/* ────────────────── Public API ────────────────── */

export type CardTileSize = "default" | "compact";

export function CardTile({
    card,
    gameSize,
    size = "default",
    selected,
    onClick,
    selectionIndicator = "checkbox",
    footer,
    className,
    ariaLabel,
}: {
    card: Card;
    gameSize: GameSize;
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
                "relative flex flex-col rounded-xl overflow-hidden text-left",
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
            style={{ color: NAVY }}
        >
            {/* Selection checkmark — floats in the top-right corner so
                it doesn't compete with the title or icon for layout
                space. Only visible when the parent picker enabled the
                checkbox indicator and the card is selected. */}
            {selected && selectionIndicator === "checkbox" && (
                <span
                    className="absolute top-2 right-2 inline-flex items-center justify-center w-5 h-5 rounded-sm bg-primary text-primary-foreground z-10"
                    aria-hidden="true"
                >
                    <Check className="w-3.5 h-3.5" />
                </span>
            )}

            {card.kind === "time-bonus" && (
                <TimeBonusBody
                    card={card}
                    gameSize={gameSize}
                    compact={size === "compact"}
                />
            )}
            {card.kind === "powerup" && (
                <PowerupBody
                    card={card}
                    gameSize={gameSize}
                    compact={size === "compact"}
                />
            )}
            {card.kind === "curse" && (
                <CurseBody
                    card={card}
                    gameSize={gameSize}
                    compact={size === "compact"}
                />
            )}

            {footer && (
                <div className="px-2.5 py-2 border-t border-zinc-200 bg-zinc-50">
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
    compact,
}: {
    card: Extract<Card, { kind: "time-bonus" }>;
    gameSize: GameSize;
    compact: boolean;
}) {
    // Layout matches the physical cards:
    //   1. Centered "TIME BONUS" header in big bold uppercase
    //   2. Large centered minutes value for the active game size
    //   3. Centered hexagon meter icon below
    // Compact variant keeps the same vertical stack but shrinks
    // everything so the card fits in the discard pile grid.
    return (
        <div
            className={cn(
                "flex-1 flex flex-col items-center text-center",
                compact ? "p-2.5" : "px-4 py-4",
            )}
        >
            <div
                className={cn(
                    "font-inter-tight font-black uppercase tracking-tight leading-[0.95]",
                    compact ? "text-base" : "text-2xl",
                )}
                style={{ color: NAVY }}
            >
                Time Bonus
            </div>
            <div
                className={cn(
                    "font-inter-tight italic font-black tabular-nums leading-none",
                    compact ? "text-3xl mt-1.5" : "text-5xl mt-3",
                )}
                style={{ color: SIZE_BG[gameSize] }}
            >
                {card.minutes[gameSize]}
                <span
                    className={cn(
                        "ml-1 not-italic font-bold",
                        compact ? "text-xs" : "text-base",
                    )}
                    style={{ color: NAVY }}
                >
                    MIN
                </span>
            </div>
            <div className={cn(compact ? "mt-2" : "mt-4")}>
                <TimeBonusHexIcon
                    largest={card.minutes.large}
                    size={compact ? 50 : 88}
                />
            </div>
        </div>
    );
}

function PowerupBody({
    card,
    gameSize,
    compact,
}: {
    card: Extract<Card, { kind: "powerup" }>;
    gameSize: GameSize;
    compact: boolean;
}) {
    return (
        <div
            className={cn(
                "flex-1 flex flex-col min-h-0",
                compact ? "p-2.5" : "px-4 py-4",
            )}
        >
            {/* Centered, bigger icon + centered title — matches the
                physical powerup card layout where the hex icon and
                title are the dominant elements at the top. */}
            <div className="flex justify-center shrink-0">
                <PowerupHexIcon
                    powerup={card.powerup}
                    size={compact ? 48 : 80}
                />
            </div>
            <div
                className={cn(
                    "font-inter-tight font-black uppercase tracking-tight leading-[0.95] mt-3 text-center shrink-0",
                    compact ? "text-sm" : "text-lg",
                )}
                style={{ color: NAVY }}
            >
                {card.name}
            </div>
            {!compact && (
                // v306: scroll within the card if the description
                // overflows the available body height (same as
                // CurseBody).
                <div className="flex-1 min-h-0 overflow-y-auto mt-2">
                    <p
                        className="text-[11px] leading-snug"
                        style={{ color: NAVY }}
                    >
                        {renderBodyText(card.description, gameSize)}
                    </p>
                </div>
            )}
        </div>
    );
}

function CurseBody({
    card,
    gameSize,
    compact,
}: {
    card: Extract<Card, { kind: "curse" }>;
    gameSize: GameSize;
    compact: boolean;
}) {
    return (
        <div
            className={cn(
                "flex-1 flex flex-col min-h-0",
                compact ? "p-2.5" : "p-3.5",
            )}
        >
            <div
                className={cn(
                    "font-inter-tight font-black uppercase tracking-tight leading-[0.95]",
                    compact ? "text-xs" : "text-sm",
                )}
                style={{ color: NAVY }}
            >
                {card.name}
            </div>
            {!compact && (
                // v306: scroll-within-card safety net. With the
                // poker aspect ratio in place (the carousel, hand
                // grid, draw picker) some curses have descriptions
                // long enough to overflow the available body
                // height. Letting the inner column scroll keeps
                // every word reachable without forcing the picker
                // to grow taller than the viewport.
                <div className="flex-1 min-h-0 overflow-y-auto mt-2">
                    <p
                        className="text-[11px] leading-snug"
                        style={{ color: NAVY }}
                    >
                        {renderBodyText(card.description, gameSize)}
                    </p>
                </div>
            )}
            {!compact && card.castingCost && (
                <p
                    className="text-[10px] leading-snug mt-2 pt-2 border-t border-zinc-200 shrink-0"
                    style={{ color: NAVY }}
                >
                    <span className="font-bold">Casting cost:</span>{" "}
                    {renderBodyText(card.castingCost, gameSize)}
                </p>
            )}
        </div>
    );
}

/* ────────────────── Hexagonal icons ────────────────── */

/**
 * SVG hexagonal frame with content centred inside. Flat-top hexagon
 * (so it reads like the icons on the physical cards) at the given
 * pixel size.
 */
function HexFrame({
    children,
    sizePx = 56,
    fill = "none",
}: {
    children?: ReactNode;
    sizePx?: number;
    fill?: string;
}) {
    return (
        <div
            className="relative inline-flex items-center justify-center shrink-0"
            style={{ width: sizePx, height: sizePx }}
        >
            <svg
                viewBox="0 0 100 100"
                className="absolute inset-0 w-full h-full"
                aria-hidden="true"
            >
                <polygon
                    points="50,4 91,27.5 91,72.5 50,96 9,72.5 9,27.5"
                    fill={fill}
                    stroke={NAVY}
                    strokeWidth="7"
                    strokeLinejoin="round"
                />
            </svg>
            <div className="relative">{children}</div>
        </div>
    );
}

/**
 * Hexagon with a colored "fill meter" indicating the time-bonus tier.
 * Approximates the physical cards' visual where bigger time bonuses
 * show progressively larger / differently-coloured wedges inside
 * the hex. A small "+" circle sits at the bottom-right corner.
 */
function TimeBonusHexIcon({
    largest,
    size: sizePx = 56,
}: {
    largest: number;
    size?: number;
}) {
    const tier =
        TIER_METER.find((t) => largest >= t.threshold) ?? TIER_METER[TIER_METER.length - 1];
    // Render the meter as a smaller filled hexagon scaled by tier
    // fraction. Not a perfect match to the physical "pie wedge" style
    // but reads correctly as "tier indicator" at small sizes.
    const innerScale = tier.fillFrac;
    return (
        <div
            className="relative inline-flex items-center justify-center shrink-0"
            style={{ width: sizePx, height: sizePx }}
        >
            <svg
                viewBox="0 0 100 100"
                className="absolute inset-0 w-full h-full"
                aria-hidden="true"
            >
                {/* Outer hex outline */}
                <polygon
                    points="50,4 91,27.5 91,72.5 50,96 9,72.5 9,27.5"
                    fill="none"
                    stroke={NAVY}
                    strokeWidth="7"
                    strokeLinejoin="round"
                />
                {/* Inner filled hex (tier meter) */}
                <polygon
                    points={scaleHexPoints(innerScale)}
                    fill={tier.color}
                />
                {/* "+" circle at bottom right — matches physical layout */}
                <circle cx="78" cy="78" r="14" fill={NAVY} />
                <path
                    d="M71,78 L85,78 M78,71 L78,85"
                    stroke="white"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                />
            </svg>
        </div>
    );
}

/** Scale hex vertices toward centre by `frac` (0..1). */
function scaleHexPoints(frac: number): string {
    const cx = 50;
    const cy = 50;
    const verts = [
        [50, 4],
        [91, 27.5],
        [91, 72.5],
        [50, 96],
        [9, 72.5],
        [9, 27.5],
    ];
    return verts
        .map(
            ([x, y]) =>
                `${cx + (x - cx) * frac},${cy + (y - cy) * frac}`,
        )
        .join(" ");
}

/**
 * Hex frame with a powerup-specific symbol inside. Symbol choice
 * approximates the physical cards' iconography using Lucide icons
 * (the real cards use custom stylised glyphs we don't have assets
 * for, but the meaning carries through).
 */
function PowerupHexIcon({
    powerup,
    size: sizePx = 56,
}: {
    powerup: PowerupKind;
    size?: number;
}) {
    const InnerIcon = POWERUP_ICON[powerup];
    return (
        <HexFrame sizePx={sizePx}>
            <InnerIcon
                style={{
                    color: NAVY,
                    width: sizePx * 0.42,
                    height: sizePx * 0.42,
                    strokeWidth: 2.5,
                }}
            />
        </HexFrame>
    );
}

const POWERUP_ICON: Record<PowerupKind, LucideIcon> = {
    veto: Ban,
    randomize: Dices,
    discard1draw2: Layers,
    discard2draw3: Layers,
    draw1expand: Layers,
    duplicate: Copy,
    move: MapPinned,
};

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
    const style: CSSProperties = {
        backgroundColor: SIZE_BG[size],
        color: SIZE_FG[size],
    };
    return (
        <span
            className="inline-flex items-baseline gap-0.5 px-1 py-[1px] rounded-sm font-poppins font-bold uppercase text-[9px] tracking-[0.04em] mx-0.5 align-baseline"
            style={style}
        >
            <span className="text-[9px]">{SIZE_LETTER[size]}</span>
            <span className="tabular-nums text-[9px]">{value}</span>
            {unit && <span className="text-[8px] opacity-90">{unit}</span>}
        </span>
    );
}

/**
 * Single time-bonus badge for the active game size — shows
 * `<letter> <minutes> MIN`. The physical card prints all three
 * S/M/L badges; the digital UI knows which size is active and only
 * renders that one.
 */
function SizeMinutesBadge({
    size,
    minutes,
}: {
    size: GameSize;
    minutes: number;
}) {
    const style: CSSProperties = {
        backgroundColor: SIZE_BG[size],
        color: SIZE_FG[size],
    };
    return (
        <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-poppins font-bold uppercase text-[10px] tracking-tight"
            style={style}
        >
            <span className="text-[10px]">{SIZE_LETTER[size]}</span>
            <span className="tabular-nums text-[10px]">{minutes}</span>
            <span className="text-[7px] opacity-80">MIN</span>
        </span>
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
