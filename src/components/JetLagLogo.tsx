/**
 * Brand marks for the seeker app, matched to the physical Jet Lag Hide+Seek
 * box and rulebook:
 *
 *   <JetLagLogo />       The official JET LAG: THE GAME plate — italic "JET",
 *                        plane glyph with red→orange→yellow contrails, italic
 *                        "LAG", yellow "THE GAME" tag. Small chrome.
 *
 *   <HideSeekMark />     The white-circle + dark-navy mountain peak mark
 *                        from the rulebook cover and box face.
 *
 *   <HideSeekWordmark /> The chunky "HIDE+SEEK" wordmark plus the
 *                        "a transit game  /  find your friends" tagline pair.
 *
 *   <SectionPill />      The dark-navy tag with white bold tracked-uppercase
 *                        text that the rulebook uses for OVERVIEW / HIDING
 *                        ZONES / ROUND START etc.
 *
 *   <SizeBadge size />   The S/M/L pill — yellow / orange / red rounded
 *                        rectangle with bold uppercase white text.
 */
import { useId } from "react";
import type { ReactNode } from "react";

import type { GameSize } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/* ────────────────── JET LAG: THE GAME plate ────────────────── */

export function JetLagLogo({
    size = 28,
    showWordmark = false,
    className,
}: {
    size?: number;
    showWordmark?: boolean;
    className?: string;
}) {
    return (
        <div className={cn("inline-flex items-center gap-2", className)}>
            <svg
                width={size}
                height={size * 0.75}
                viewBox="0 0 64 48"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-label="JET LAG: THE GAME"
                role="img"
            >
                <path
                    d="M3 12 H38"
                    stroke="hsl(2 70% 54%)"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                />
                <path
                    d="M3 24 H44"
                    stroke="hsl(22 82% 58%)"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                />
                <path
                    d="M3 36 H38"
                    stroke="hsl(44 87% 64%)"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                />
                <path
                    d="M58 24 L42 14 L46 14 L52 21 L57 18 L55 24 L57 30 L52 27 L46 34 L42 34 Z"
                    fill="currentColor"
                />
            </svg>
            {showWordmark && (
                <span className="font-inter-tight italic font-black uppercase tracking-tight text-base leading-none">
                    Jet<span className="text-jetlag-yellow">Lag</span>
                </span>
            )}
        </div>
    );
}

/* ────────────────── HIDE+SEEK mountain peak mark ────────────────── */

/**
 * The Hide+Seek logomark, matched to the box cover: a white CIRCLE (the
 * sun) and a red TRIANGLE (mountain) combined with a true boolean
 * EXCLUDE (XOR) — the region where the two OVERLAP is knocked out of
 * BOTH shapes, so the intersection reads as empty background. The sun
 * gets a triangular notch bitten out of its lower edge; the mountain
 * gets its peak bitten out by the sun's arc; between them sits an even
 * navy wedge.
 *
 * Implemented as two masks, one per shape, each subtracting the OTHER
 * shape dilated by an even gap (stroke = 2×gap) so a uniform-width sliver
 * of background separates the cut edges. The cutout is transparent, so
 * the mark works on the navy app chrome, on red, or anywhere else.
 */
export function HideSeekMark({
    size = 40,
    className,
}: {
    size?: number;
    className?: string;
}) {
    // Unique mask ids per instance — multiple marks can mount at once
    // (welcome hero + sidebar), and shared ids would cross-wire them.
    const uid = useId().replace(/:/g, "");
    const circleMaskId = `hsmark-c-${uid}`;
    const triMaskId = `hsmark-t-${uid}`;
    const TRIANGLE = "M32 30 L3 58 L61 58 Z";
    const CIRCLE = { cx: 32, cy: 26, r: 18 };
    // Stroke on each cut → the gap. Split across both shapes (each cuts
    // the other), so 3 here ≈ a 3px navy seam total.
    const GAP = 3;
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 64 64"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="Hide+Seek"
            className={className}
        >
            <defs>
                {/* Sun keeps everything EXCEPT the (dilated) mountain. */}
                <mask id={circleMaskId}>
                    <rect width="64" height="64" fill="white" />
                    <path
                        d={TRIANGLE}
                        fill="black"
                        stroke="black"
                        strokeWidth={GAP}
                        strokeLinejoin="round"
                    />
                </mask>
                {/* Mountain keeps everything EXCEPT the (dilated) sun. */}
                <mask id={triMaskId}>
                    <rect width="64" height="64" fill="white" />
                    <circle
                        cx={CIRCLE.cx}
                        cy={CIRCLE.cy}
                        r={CIRCLE.r}
                        fill="black"
                        stroke="black"
                        strokeWidth={GAP}
                    />
                </mask>
            </defs>
            {/* White sun with the mountain knocked out of its lower edge. */}
            <circle
                cx={CIRCLE.cx}
                cy={CIRCLE.cy}
                r={CIRCLE.r}
                fill="white"
                mask={`url(#${circleMaskId})`}
            />
            {/* Red mountain with the sun knocked out of its peak. */}
            <path
                d={TRIANGLE}
                fill="hsl(5 80% 55%)"
                mask={`url(#${triMaskId})`}
            />
        </svg>
    );
}

/* ────────────────── HIDE+SEEK wordmark ────────────────── */

export function HideSeekWordmark({
    className,
    showTagline = false,
    /**
     * Box-cover layout: wordmark, full-width horizontal rule, then
     * `a transit game · find your friends` split left/right beneath.
     * Implies `showTagline`. Used for hero surfaces (welcome screen,
     * setup wizard header, splash) where we want to echo the rulebook
     * cover. Defaults off to keep tight inline usages unaffected.
     */
    boxLayout = false,
    size = "default",
}: {
    className?: string;
    showTagline?: boolean;
    boxLayout?: boolean;
    size?: "default" | "lg" | "xl";
}) {
    const tagline = showTagline || boxLayout;
    const wordmarkClass =
        size === "xl"
            ? "text-5xl"
            : size === "lg"
              ? "text-4xl"
              : "text-3xl";
    return (
        <div className={cn("inline-flex flex-col", className)}>
            <span
                className={cn(
                    "font-display font-black uppercase leading-none",
                    wordmarkClass,
                )}
                style={{ letterSpacing: "-0.05em" }}
            >
                HIDE
                <span className="text-primary">+</span>
                SEEK
            </span>
            {boxLayout && (
                <div className="mt-2.5 h-[2px] w-full bg-current opacity-95" />
            )}
            {tagline && (
                <div
                    className={cn(
                        "flex justify-between font-medium",
                        boxLayout
                            ? "mt-2 text-[13px] tracking-[0.005em]"
                            : "mt-1.5 text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground",
                    )}
                >
                    <span>a transit game</span>
                    <span>find your friends</span>
                </div>
            )}
        </div>
    );
}

/* ────────────────── Section pill ────────────────── */

/**
 * The little dark-navy tag the rulebook uses everywhere — "OVERVIEW",
 * "CHOOSING GAME SIZE", "HIDING ZONES" etc. Use anywhere you'd otherwise
 * reach for a small uppercase section heading.
 */
export function SectionPill({
    children,
    className,
    tone = "dark",
}: {
    children: React.ReactNode;
    className?: string;
    tone?: "dark" | "light";
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center px-2 py-0.5 rounded-sm",
                "font-inter-tight font-extrabold uppercase tracking-[0.08em] text-[11px] leading-none",
                tone === "dark"
                    ? "bg-[hsl(210_30%_14%)] text-white"
                    : "bg-white text-[hsl(210_30%_14%)]",
                className,
            )}
        >
            {children}
        </span>
    );
}

/* ────────────────── Role chip ────────────────── */

/**
 * Outlined chip showing the local player's role — modeled on the
 * JET LAG · THE GAME lockup from the box: an outlined rectangle
 * with heavy uppercase text and a small yellow "tag" pill underneath.
 *
 * Tone:
 *   - "onDark"  (default) — white border + text, transparent fill.
 *   - "onLight"            — primary border + text, on a transparent fill.
 *
 * Pass `tag` to render the secondary yellow pill (e.g. a room code).
 */
export function RoleChip({
    role,
    tag,
    onDark = true,
    className,
}: {
    role: "seeker" | "hider" | "coHider";
    tag?: string;
    onDark?: boolean;
    className?: string;
}) {
    const label =
        role === "seeker"
            ? "Seeker"
            : role === "hider"
              ? "Hider"
              : "Co-hider";
    const border = onDark ? "border-white text-white" : "border-primary text-primary";
    return (
        <span
            className={cn(
                "inline-flex flex-col items-center gap-0.5",
                "rounded-md border-[1.5px] px-2.5 pt-1 pb-1.5",
                "leading-none",
                border,
                className,
            )}
            aria-label={`Your role: ${label}`}
        >
            <span
                className="font-display font-extrabold uppercase text-[13px]"
                style={{ letterSpacing: "0.02em" }}
            >
                {label}
            </span>
            {tag && (
                <span
                    className={cn(
                        "rounded-[3px] px-1 py-[1px]",
                        "font-display font-extrabold uppercase text-[8px]",
                        "tabular-nums tracking-[0.08em]",
                        "bg-[hsl(var(--accent-yellow))] text-[hsl(var(--sidebar-background))]",
                    )}
                >
                    {tag}
                </span>
            )}
        </span>
    );
}

/* ────────────────── S / M / L size badge ────────────────── */

const SIZE_BADGE: Record<GameSize, { bg: string; label: string }> = {
    small: { bg: "hsl(44 87% 64%)", label: "SMALL" },
    medium: { bg: "hsl(22 82% 58%)", label: "MEDIUM" },
    large: { bg: "hsl(2 70% 54%)", label: "LARGE" },
};

export function SizeBadge({
    size,
    abbreviated = false,
    className,
    trailing,
}: {
    size: GameSize;
    abbreviated?: boolean;
    className?: string;
    /** Optional node rendered INSIDE the coloured pill, after the label
     *  (e.g. a dropdown chevron so it reads as part of the same pill). */
    trailing?: ReactNode;
}) {
    const meta = SIZE_BADGE[size];
    return (
        <span
            className={cn(
                "inline-flex items-center justify-center gap-1 rounded-md px-2 py-0.5",
                "font-inter-tight font-black uppercase tracking-[0.08em] text-[11px] leading-none text-white",
                "shadow-[0_1px_0_rgba(0,0,0,0.25)]",
                className,
            )}
            style={{ background: meta.bg }}
        >
            {abbreviated ? meta.label.charAt(0) : meta.label}
            {trailing}
        </span>
    );
}

export default JetLagLogo;
