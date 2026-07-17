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
            <ClockHexIcon largest={card.minutes.large} cqw={74} />
            <div
                className="font-inter-tight font-black uppercase tracking-tight leading-[0.98]"
                style={{ color: NAVY, fontSize: cu(13), marginTop: cu(3) }}
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
                <PowerupGlyph powerup={card.powerup} cqw={66} />
            </div>
            <div
                className="font-inter-tight font-black uppercase tracking-tight leading-[0.98] text-center shrink-0"
                style={{ color: NAVY, fontSize: cu(9.5), marginTop: cu(4) }}
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
                className="font-inter-tight font-black uppercase tracking-tight leading-[0.98] shrink-0"
                style={{ color: NAVY, fontSize: cu(6.3) }}
            >
                {card.name}
            </div>
            <div
                className="flex-1 min-h-0 overflow-y-auto"
                style={{ marginTop: cu(3) }}
            >
                <p
                    className="leading-snug"
                    style={{ color: NAVY, fontSize: cu(4) }}
                >
                    {renderBodyText(card.description, gameSize)}
                </p>
            </div>
            {card.castingCost && (
                // The whole casting-cost line is bold on the printed card.
                <p
                    className="leading-snug font-bold shrink-0"
                    style={{
                        color: NAVY,
                        fontSize: cu(3.7),
                        marginTop: cu(3),
                    }}
                >
                    Casting cost: {renderBodyText(card.castingCost, gameSize)}
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

/** The 11 clock tick marks from the authored time-bonus icon (the tick
 *  behind the "+" badge is intentionally omitted). */
const TB_TICKS = (
    <g fill={NAVY}>
        <rect x="157" y="60" width="4" height="12" rx="2" />
        <rect
            x="161"
            y="228.393"
            width="4"
            height="12"
            rx="2"
            transform="rotate(180 161 228.393)"
        />
        <rect
            x="220"
            y="146"
            width="4"
            height="12"
            rx="2"
            transform="rotate(-90 220 146)"
        />
        <rect
            x="98"
            y="142.393"
            width="4"
            height="12"
            rx="2"
            transform="rotate(90 98 142.393)"
        />
        <rect
            x="194"
            y="78"
            width="4"
            height="12"
            rx="2"
            transform="rotate(30 194 78)"
        />
        <rect
            x="187"
            y="200"
            width="4"
            height="12"
            rx="2"
            transform="rotate(-30 187 200)"
        />
        <rect
            x="131"
            y="88.3926"
            width="4"
            height="12"
            rx="2"
            transform="rotate(150 131 88.3926)"
        />
        <rect
            x="228.393"
            y="102"
            width="4"
            height="12"
            rx="2"
            transform="rotate(60 228.393 102)"
        />
        <rect
            x="89.6074"
            y="186.393"
            width="4"
            height="12"
            rx="2"
            transform="rotate(-120 89.6074 186.393)"
        />
        <rect
            x="218"
            y="180.465"
            width="4"
            height="12"
            rx="2"
            transform="rotate(-60 218 180.465)"
        />
        <rect
            x="100"
            y="107.928"
            width="4"
            height="12"
            rx="2"
            transform="rotate(120 100 107.928)"
        />
    </g>
);

/**
 * The Time Bonus clock — the user's authored icon (viewBox 317×288): a
 * tilted navy hexagon, an upright clock face inside it (tick marks + a
 * colored pie WEDGE from 12 o'clock whose sweep + colour grow with the
 * bonus tier), and a solid navy "+" badge overlapping the lower-left edge
 * with a white knockout ring. Only the WEDGE is dynamic (tier-driven);
 * everything else is the fixed authored geometry.
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
        TIER_METER.find((t) => largest >= t.threshold) ??
        TIER_METER[TIER_METER.length - 1];
    return (
        <div
            className="relative inline-flex items-center justify-center shrink-0"
            style={{ width: cu(cqw), height: cu(cqw) }}
        >
            <svg
                viewBox="0 0 317 288"
                className="absolute inset-0 w-full h-full"
                aria-hidden="true"
            >
                {/* tilted hexagon shell */}
                <path
                    d="M242 180.93V107.936C242 100.814 238.213 94.2298 232.057 90.6486L168.838 53.8688C162.604 50.2424 154.901 50.2525 148.678 53.8952L85.8974 90.6402C79.7672 94.2281 76 100.798 76 107.901L76 180.965C76 188.068 79.7672 194.638 85.8974 198.226L148.678 234.971C154.902 238.614 162.604 238.624 168.838 234.997L232.057 198.217C238.213 194.636 242 188.052 242 180.93Z"
                    fill="none"
                    stroke={NAVY}
                    strokeWidth="8"
                    strokeLinecap="square"
                    strokeLinejoin="round"
                />
                {/* dynamic colored wedge from 12 o'clock, sweeping clockwise */}
                <path
                    d={pieSlice(159, 144, 59, -90, tier.sweepDeg)}
                    fill={tier.color}
                />
                {TB_TICKS}
                {/* "+" badge with white knockout ring */}
                <circle
                    cx="110.5"
                    cy="199.5"
                    r="46.5"
                    fill={NAVY}
                    stroke="#ffffff"
                    strokeWidth="8"
                />
                <path
                    d="M108.48 218.092C107.376 218.092 106.48 217.197 106.48 216.092V182.02C106.48 180.915 107.376 180.02 108.48 180.02H112.927C114.032 180.02 114.927 180.915 114.927 182.02V216.092C114.927 217.197 114.032 218.092 112.927 218.092L108.48 218.092ZM93.9062 203.348C92.8017 203.348 91.9062 202.453 91.9062 201.348V196.594C91.9062 195.489 92.8017 194.594 93.9062 194.594H127.536C128.641 194.594 129.536 195.489 129.536 196.594V201.348C129.536 202.453 128.641 203.348 127.536 203.348H93.9062Z"
                    fill="#ffffff"
                />
            </svg>
        </div>
    );
}

/* The user-authored card art for the fanned/single card powerups, drawn in
 * the shared 316×307 viewBox. TWO_CARDS = the discard/draw glyph (back card
 * + folded-corner front card); ONE_CARD = the draw+expand glyph (a single
 * card). Both sit under the badge circles + dynamic numbers in `cardsGlyph`. */
const TWO_CARDS = (
    <>
        <rect
            x="179"
            y="207"
            width="64"
            height="88"
            rx="12"
            transform="rotate(180 179 207)"
            fill="none"
            stroke={NAVY}
            strokeWidth="8"
        />
        <path
            d="M189 97L149 97L148.587 97.0049C140.079 97.2205 133.22 104.079 133.005 112.587L133 115L141 115C141 110.582 144.582 105 149 105L189 105C193.418 105 197 108.582 197 113L197 177C197 181.418 193.418 185 189 185L183 185L183 193L189 193C197.837 193 205 185.837 205 177L205 113L204.995 112.587C204.779 104.079 197.921 97.2205 189.413 97.0049L189 97Z"
            fill={NAVY}
        />
    </>
);
const ONE_CARD = (
    <rect
        x="190"
        y="198"
        width="64"
        height="88"
        rx="12"
        transform="rotate(180 190 198)"
        fill="none"
        stroke={NAVY}
        strokeWidth="8"
    />
);

/**
 * Fanned-cards glyph (the discard/draw/expand powerups) — the user's
 * authored art: a tilted navy hexagon, the card art (`cards`), an OUTLINED
 * white draw badge (bottom-left) and a SOLID navy delta badge (top-right).
 * The badge NUMBERS are dynamic bold Poppins text (the design bakes them as
 * paths; here they're live so one glyph serves every draw/keep combo).
 */
function cardsGlyph(
    cards: ReactNode,
    drawLabel: string,
    deltaLabel: string,
): ReactNode {
    return (
        <>
            <path
                d="M241 190.93V117.936C241 110.814 237.213 104.23 231.057 100.649L167.838 63.8688C161.604 60.2424 153.901 60.2525 147.678 63.8952L84.8974 100.64C78.7672 104.228 75 110.798 75 117.901L75 190.965C75 198.068 78.7672 204.638 84.8974 208.226L147.678 244.971C153.902 248.614 161.604 248.624 167.838 244.997L231.057 208.217C237.213 204.636 241 198.052 241 190.93Z"
                fill="none"
                stroke={NAVY}
                strokeWidth="8"
                strokeLinecap="square"
                strokeLinejoin="round"
            />
            {cards}
            {/* draw badge — outlined white circle, bottom-left */}
            <circle
                cx="98"
                cy="214"
                r="56"
                fill="#ffffff"
                stroke={NAVY}
                strokeWidth="8"
            />
            {/* hand-delta badge — solid navy circle, top-right */}
            <circle cx="209" cy="75" r="40" fill={NAVY} />
            <text
                x="98"
                y="214"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="66"
                fontWeight="700"
                fill={NAVY}
                fontFamily={ICON_FONT}
            >
                {drawLabel}
            </text>
            <text
                x="209"
                y="75"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="50"
                fontWeight="700"
                fill="#ffffff"
                fontFamily={ICON_FONT}
            >
                {deltaLabel}
            </text>
        </>
    );
}

/** Per-powerup authored art — each carries its OWN viewBox (the icons were
 *  drawn at slightly different frames), rendered by `PowerupGlyph`. */
function powerupArt(powerup: PowerupKind): {
    viewBox: string;
    body: ReactNode;
} {
    switch (powerup) {
        case "veto":
            // The red "ø card" mark: a prohibition hexagon + a card + the
            // slash cutting through both.
            return {
                viewBox: "0 0 297 301",
                body: (
                    <>
                        <path
                            d="M107.375 223.65L75.8974 205.226C69.7672 201.638 66 195.068 66 187.965L66 114.901C66 107.798 69.7672 101.228 75.8974 97.6402L138.678 60.8952C144.902 57.2525 152.604 57.2424 158.838 60.8688L190.375 79.2165M107.375 223.65L138.678 241.971C144.902 245.614 152.604 245.624 158.838 241.997L222.057 205.217C228.213 201.636 232 195.052 232 187.93V114.936C232 107.814 228.213 101.23 222.057 97.6486L190.375 79.2165M107.375 223.65L190.375 79.2165"
                            fill="none"
                            stroke={CARD_RED}
                            strokeWidth="8"
                            strokeLinecap="square"
                        />
                        <rect
                            x="181"
                            y="195"
                            width="64"
                            height="88"
                            rx="12"
                            transform="rotate(180 181 195)"
                            fill="none"
                            stroke={CARD_RED}
                            strokeWidth="8"
                        />
                    </>
                ),
            };
        case "move":
            // Two location pins in a hexagon — outline pin behind, solid pin
            // (with a white dot) in front.
            return {
                viewBox: "0 0 327 280",
                body: (
                    <>
                        <path
                            d="M247 176.93V103.936C247 96.8142 243.213 90.2298 237.057 86.6486L173.838 49.8688C167.604 46.2424 159.901 46.2525 153.678 49.8952L90.8974 86.6402C84.7672 90.2281 81 96.7981 81 103.901L81 176.965C81 184.068 84.7672 190.638 90.8974 194.226L153.678 230.971C159.902 234.614 167.604 234.624 173.838 230.997L237.057 194.217C243.213 190.636 247 184.052 247 176.93Z"
                            fill="none"
                            stroke={NAVY}
                            strokeWidth="8"
                            strokeLinecap="square"
                        />
                        <path
                            d="M179.5 92C196.897 92 211 106.108 211 123.512C211 129.603 209.27 135.289 206.278 140.11C206.194 140.387 206.087 140.663 205.953 140.935L184.191 185.071C182.265 188.977 176.697 188.976 174.773 185.069L153.041 140.932C152.905 140.656 152.796 140.376 152.712 140.094C149.726 135.277 148 129.597 148 123.512C148 106.108 162.103 92 179.5 92Z"
                            fill={NAVY}
                        />
                        <path
                            d="M147.5 96C162.686 96 175 108.316 175 123.512C175 128.835 173.491 133.794 170.88 138L170.602 138.448L170.449 138.952C170.427 139.024 170.4 139.095 170.365 139.166L148.604 183.303C148.145 184.233 146.82 184.232 146.361 183.302L124.63 139.165C124.593 139.089 124.564 139.017 124.544 138.948L124.392 138.438L124.111 137.986C121.506 133.783 120 128.829 120 123.512C120 108.316 132.314 96 147.5 96Z"
                            fill="none"
                            stroke={NAVY}
                            strokeWidth="8"
                        />
                        <circle cx="180" cy="124" r="14" fill="#ffffff" />
                    </>
                ),
            };
        case "randomize":
            // Isometric die: "?" + pips on its faces.
            return {
                viewBox: "0 0 321 319",
                body: (
                    <>
                        <path
                            d="M244 180.497V107.502C244 100.381 240.213 93.7963 234.057 90.215L170.838 53.4352C164.604 49.8088 156.901 49.8189 150.678 53.4616L87.8974 90.2066C81.7672 93.7945 78 100.364 78 107.467L78 180.531C78 187.634 81.7672 194.204 87.8974 197.792L150.678 234.537C156.902 238.18 164.604 238.19 170.838 234.564L234.057 197.784C240.213 194.203 244 187.618 244 180.497Z"
                            fill="none"
                            stroke={NAVY}
                            strokeWidth="8"
                            strokeLinecap="square"
                        />
                        <path
                            d="M161 229.566L161 155.602C161 148.334 164.944 141.637 171.3 138.112L239 100.566"
                            fill="none"
                            stroke={NAVY}
                            strokeWidth="8"
                            strokeLinecap="square"
                        />
                        <path
                            d="M161 227.566L161 153.602C161 146.334 157.056 139.637 150.7 136.112L83 98.5664"
                            fill="none"
                            stroke={NAVY}
                            strokeWidth="8"
                            strokeLinecap="square"
                        />
                        <path
                            d="M84.9998 100.115L153.485 137.468C158.18 140.028 163.844 140.074 168.58 137.589L239.999 100.117"
                            fill="none"
                            stroke={NAVY}
                            strokeWidth="8"
                            strokeLinecap="square"
                        />
                        <path
                            d="M119.914 166.551L119.336 172.486L112.264 169.338L111.621 159.129L119.079 157.735L123 159.481V151.458L114 147.451V153.785L105 149.778V139.715L112.457 138.32L124.543 143.701L132 151.736V167.217L124.543 168.612L119.914 166.551ZM109.693 188.459V175.089L121.907 180.527V193.897L109.693 188.459Z"
                            fill={NAVY}
                        />
                        <circle
                            cx="10"
                            cy="10"
                            r="10"
                            transform="matrix(0.939693 -0.34202 0 1 194 162.209)"
                            fill={NAVY}
                        />
                        <circle
                            cx="10"
                            cy="10"
                            r="10"
                            transform="matrix(-0.819152 -0.573576 0.819152 -0.573576 160.383 119.898)"
                            fill={NAVY}
                        />
                        <circle
                            cx="10"
                            cy="10"
                            r="10"
                            transform="matrix(-0.819152 -0.573576 0.819152 -0.573576 160.383 88.9434)"
                            fill={NAVY}
                        />
                    </>
                ),
            };
        case "duplicate":
            // A card copied to a second card (the "+" duplicate glyph).
            return {
                viewBox: "0 0 321 319",
                body: (
                    <>
                        <path
                            d="M234 185.93V112.936C234 105.814 230.213 99.2298 224.057 95.6486L160.838 58.8688C154.604 55.2424 146.901 55.2525 140.678 58.8952L77.8974 95.6402C71.7672 99.2281 68 105.798 68 112.901L68 185.965C68 193.068 71.7672 199.638 77.8974 203.226L140.678 239.971C146.902 243.614 154.604 243.624 160.838 239.997L224.057 203.217C230.213 199.636 234 193.052 234 185.93Z"
                            fill="none"
                            stroke={NAVY}
                            strokeWidth="8"
                            strokeLinecap="square"
                        />
                        <rect
                            x="130"
                            y="96"
                            width="64"
                            height="88"
                            rx="12"
                            fill="none"
                            stroke={NAVY}
                            strokeWidth="8"
                        />
                        <path
                            d="M120 206H160L160.413 205.995C168.921 205.779 175.779 198.921 175.995 190.413L176 188H168C168 192.418 164.418 198 160 198H120C115.582 198 112 194.418 112 190V126C112 121.582 115.582 118 120 118L126 118V110H120C111.163 110 104 117.163 104 126V190L104.005 190.413C104.221 198.921 111.079 205.779 119.587 205.995L120 206Z"
                            fill={NAVY}
                        />
                        <path
                            d="M159.92 156C158.815 156 157.92 155.105 157.92 154V126C157.92 124.895 158.815 124 159.92 124H164.08C165.185 124 166.08 124.895 166.08 126V154C166.08 155.105 165.185 156 164.08 156H159.92ZM148 144.08C146.895 144.08 146 143.185 146 142.08V137.92C146 136.815 146.895 135.92 148 135.92H176C177.105 135.92 178 136.815 178 137.92V142.08C178 143.185 177.105 144.08 176 144.08H148Z"
                            fill={NAVY}
                        />
                    </>
                ),
            };
        case "discard1draw2":
            return {
                viewBox: "0 0 316 307",
                body: cardsGlyph(TWO_CARDS, "+2", "-1"),
            };
        case "discard2draw3":
            return {
                viewBox: "0 0 316 307",
                body: cardsGlyph(TWO_CARDS, "+3", "-2"),
            };
        case "draw1expand":
            return {
                viewBox: "0 0 316 307",
                body: cardsGlyph(ONE_CARD, "+1", "+1"),
            };
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
    const { viewBox, body } = powerupArt(powerup);
    return (
        <svg
            viewBox={viewBox}
            className="shrink-0"
            style={{ width: cu(cqw), height: cu(cqw) }}
            aria-hidden="true"
        >
            {body}
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
