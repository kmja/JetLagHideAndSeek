import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Check, Hourglass } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { adminDivisionName, adminTierToOsmLevel } from "@/lib/adminDivisions";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { mapGeoLocation } from "@/lib/context";
import { iconForSubtype } from "@/lib/subtypes";
import { cn } from "@/lib/utils";

/**
 * Shared Jet-Lag-show-style card chrome for the question overlays — the
 * seeker's pending-answer overlay AND the hider's unanswered-question
 * overlay use the same shell so the two sides look identical:
 *
 *   - a SQUARE solid category-colour icon block on the left (sharp
 *     corners, full card height),
 *   - NO border radius (matches the show's rectangular cards),
 *   - a single big uppercase label + one short description (two lines),
 *   - a faint category wash + a category-tinted border,
 *   - a caller-supplied right slot (timer / retry / countdown / chevron).
 */

/* ────────────────── Subtype icons + labels ────────────────── */

// Subtype icons come from ONE source — `iconForSubtype` in
// `src/lib/subtypes.ts` — shared with the on-map markers so a question's
// header card and its map markers always show the SAME icon.
const getSubtypeIcon = iconForSubtype;

/** Human-readable subtype label (e.g. "Museum", "McDonald's"). */
function subtypeLabel(type: string | undefined): string | null {
    if (!type) return null;
    const stripped = type.endsWith("-full")
        ? type.slice(0, -"-full".length)
        : type;
    switch (stripped) {
        case "mcdonalds":
            return "McDonald's";
        case "seven11":
            return "7-Eleven";
        case "rail-measure":
            return "Train station";
        case "major-city":
            return "Major city";
        case "highspeed-measure-shinkansen":
            return "High-speed rail";
        case "same-train-line":
            return "Train line";
        case "same-length-station":
            return "Station length";
        case "admin1-border":
        case "admin2-border":
            return adminBorderLabel(stripped);
        default:
            return stripped.replace(/[-_]/g, " ");
    }
}

/** Locale-specific label for the measuring admin-division border subtypes
 *  (v869) — "State border" / "County border" for the play area's country,
 *  matching the picker tile. Reads the play-area country (non-reactive, but
 *  it never changes during a question's life); falls back to the generic
 *  wording when the country is unknown/untabled. */
function adminBorderLabel(value: string): string {
    const tier = value === "admin1-border" ? 1 : 2;
    const iso = (
        mapGeoLocation.get()?.properties as { countrycode?: string } | undefined
    )?.countrycode;
    if (iso) {
        const name = adminDivisionName(iso, adminTierToOsmLevel(iso, tier));
        if (!name.startsWith("OSM") && !name.includes("admin division")) {
            return `${name.replace(/\s*\(.*\)\s*$/, "")} border`;
        }
    }
    return tier === 1 ? "1st admin border" : "2nd admin border";
}

/* ────────────────── Summary ────────────────── */

export interface QuestionSummary {
    /** Subtype-specific icon, falls back to the category icon. */
    icon?: LucideIcon;
    /** The one big uppercase headline, e.g. "5 km Radar",
     *  "Matching · Museum". */
    bigLabel: string;
    /** One short description line under the label. */
    detail?: string;
}

/**
 * Deepen a pastel category colour into a punchy, saturated tone that
 * reads as bold coloured TEXT on a white card and as a solid block with
 * WHITE content — the Jet Lag show's lower-third look. Near-grey inputs
 * (matching) collapse to the brand navy, like the show's train blocks.
 */
export function deepColor(hex: string): string {
    const h = hex.replace("#", "");
    let r = parseInt(h.slice(0, 2), 16);
    let g = parseInt(h.slice(2, 4), 16);
    let b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return hex;
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let s = 0;
    let hue = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                hue = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                hue = (b - r) / d + 2;
                break;
            default:
                hue = (r - g) / d + 4;
        }
        hue /= 6;
    }
    // Greys (matching) → brand navy, like the show's train blocks.
    if (s < 0.12) return "#1F2F3F";
    const ns = Math.max(s, 0.6);
    const nl = Math.min(l, 0.4);
    return `hsl(${Math.round(hue * 360)} ${Math.round(ns * 100)}% ${Math.round(nl * 100)}%)`;
}

/**
 * Build the big label + short description for a question. Works from any
 * `{ id, data }` shape, so both the seeker's `Question`s and the hider's
 * inbox entries feed it.
 */
export function summarizeQuestion(q: {
    id: string;
    data: Record<string, unknown>;
}): QuestionSummary {
    const d = q.data;
    const cat = CATEGORIES[q.id as CategoryId];
    const categoryLabel = cat?.label ?? q.id;

    switch (q.id) {
        case "radius": {
            const radius = d.radius as number | undefined;
            const unit = d.unit as string | undefined;
            const u = unit === "miles" ? "mi" : unit === "meters" ? "m" : "km";
            return {
                bigLabel:
                    radius !== undefined
                        ? `${radius} ${u} ${categoryLabel}`
                        : categoryLabel,
                detail: "Inside or outside the radius?",
            };
        }
        case "thermometer": {
            const dist = d.distance as string | undefined;
            return {
                bigLabel: dist
                    ? `${categoryLabel} · ${dist}`
                    : categoryLabel,
                detail: "Warmer or colder after the move?",
            };
        }
        case "matching": {
            const subType = d.type ? String(d.type) : undefined;
            const subLabel = subtypeLabel(subType) ?? undefined;
            return {
                icon: getSubtypeIcon(subType) ?? undefined,
                bigLabel: subLabel
                    ? `${categoryLabel} · ${subLabel}`
                    : categoryLabel,
                detail: "Same nearest one as you?",
            };
        }
        case "measuring": {
            const subType = d.type ? String(d.type) : undefined;
            const subLabel = subtypeLabel(subType) ?? undefined;
            return {
                icon: getSubtypeIcon(subType) ?? undefined,
                bigLabel: subLabel
                    ? `${categoryLabel} · ${subLabel}`
                    : categoryLabel,
                detail: "Closer or further than you?",
            };
        }
        case "tentacles": {
            const subType = d.locationType ? String(d.locationType) : undefined;
            const subLabel = subtypeLabel(subType) ?? undefined;
            return {
                icon: getSubtypeIcon(subType) ?? undefined,
                bigLabel: subLabel
                    ? `${categoryLabel} · ${subLabel}`
                    : categoryLabel,
                detail: "Which one is closest to you?",
            };
        }
        case "photo": {
            const subType = d.type ? String(d.type) : undefined;
            const subLabel = subtypeLabel(subType) ?? undefined;
            return {
                icon: getSubtypeIcon(subType) ?? undefined,
                bigLabel: subLabel
                    ? `${categoryLabel} · ${subLabel}`
                    : categoryLabel,
                detail: "Send a photo back",
            };
        }
        default:
            return { bigLabel: categoryLabel };
    }
}

/* ────────────────── Card chrome ────────────────── */

export function QuestionOverlayCard({
    categoryId,
    summary,
    eyebrow,
    right,
    answered = false,
    error = false,
    onClick,
    ariaLabel,
    className,
}: {
    categoryId: string;
    summary: QuestionSummary;
    /** Small eyebrow line above the big label (e.g. "10m ago"). Caller
     *  supplies its own colour; the slot provides the size/tracking. */
    eyebrow?: ReactNode;
    /** Right-hand slot — timer, retry button, countdown, chevron, … */
    right?: ReactNode;
    answered?: boolean;
    /** Failed-to-send state: red icon block + label + border, alert icon. */
    error?: boolean;
    onClick?: () => void;
    ariaLabel?: string;
    className?: string;
}) {
    const meta = CATEGORIES[categoryId as CategoryId];
    const base = meta?.color ?? "#999";
    // `deep` (saturated/dark) reads on a LIGHT card; the original pastel
    // `base` reads on a DARK card. We expose both as CSS vars so the
    // label + timer can switch on `.dark` without knowing the theme.
    // `error` / `answered` override the category colour entirely — routed
    // through the semantic state tokens (theme-aware) instead of literals.
    const stateColor = error
        ? "hsl(var(--destructive))"
        : "hsl(var(--success))";
    const deep = error || answered ? stateColor : deepColor(base);
    const bright = error || answered ? stateColor : base;
    const Icon = summary.icon ?? meta?.icon ?? Hourglass;
    const interactive = Boolean(onClick);

    // Fire the one-shot celebratory flash only on the moment a question
    // flips from awaiting → answered (not on every mount/re-render, so an
    // already-answered card opened later in the list stays calm).
    const [justAnswered, setJustAnswered] = useState(false);
    const prevAnswered = useRef(answered);
    useEffect(() => {
        if (answered && !prevAnswered.current) {
            setJustAnswered(true);
            const t = window.setTimeout(() => setJustAnswered(false), 750);
            prevAnswered.current = answered;
            return () => window.clearTimeout(t);
        }
        prevAnswered.current = answered;
    }, [answered]);

    return (
        <div
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            onClick={onClick}
            onKeyDown={
                interactive
                    ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onClick?.();
                          }
                      }
                    : undefined
            }
            aria-label={ariaLabel}
            style={
                {
                    "--cat-deep": deep,
                    "--cat-bright": bright,
                    // Error/answered tint the whole border to match.
                    ...(error || answered ? { borderColor: deep } : {}),
                } as React.CSSProperties
            }
            className={cn(
                // Jet-Lag-show lower-third: a card with a solid colour icon
                // block on the LEFT, a big bold coloured label, and the
                // live status on the RIGHT. Light card in light mode, dark
                // card in dark mode — themed via CSS vars (NOT `dark:`
                // variants) so the gallery can preview both. Sharp corners,
                // fixed height so the icon block resolves to a square.
                "pointer-events-auto relative flex items-stretch overflow-hidden h-[4.5rem]",
                "shadow-xl border",
                "bg-[var(--overlay-card)] text-[color:var(--overlay-card-fg)] border-[color:var(--overlay-card-border)]",
                interactive &&
                    "cursor-pointer select-none active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "transition-transform duration-200",
                justAnswered &&
                    "animate-[jlAnsweredCard_750ms_ease-out] z-[1]",
                className,
            )}
        >
            {/* Solid category-colour square icon block (left). White icon;
                `aspect-square` resolves against the card's fixed height. */}
            <span
                className="h-full aspect-square shrink-0 flex items-center justify-center text-white"
                style={{ backgroundColor: deep }}
                aria-hidden="true"
            >
                {error ? (
                    <AlertTriangle size={36} strokeWidth={2.5} />
                ) : answered ? (
                    <Check
                        size={36}
                        strokeWidth={3}
                        className="animate-[jlAnsweredPop_400ms_ease-out]"
                    />
                ) : (
                    // Big, show-style icon filling the colour block.
                    <Icon size={38} strokeWidth={2.25} />
                )}
            </span>

            {/* Eyebrow + big coloured label + one short description
                (middle). Roomier horizontal padding (`px-5`) than the
                icon-block flush so the text has space to breathe. */}
            <div className="min-w-0 flex-1 px-5 py-2 flex flex-col justify-center">
                {eyebrow && (
                    <div className="text-[10px] uppercase tracking-wider font-poppins font-bold leading-none mb-1 truncate">
                        {eyebrow}
                    </div>
                )}
                <div
                    className="font-display font-extrabold uppercase leading-[1.0] text-lg sm:text-xl truncate text-[color:var(--cat-label)]"
                    style={{ letterSpacing: "-0.01em" }}
                >
                    {summary.bigLabel}
                </div>
                {summary.detail && (
                    <div className="text-[11px] sm:text-xs text-[color:var(--overlay-card-desc)] leading-snug truncate mt-0.5">
                        {summary.detail}
                    </div>
                )}
            </div>

            {/* Live status — timer / retry / answer action (right). Sizes
                to its content so error messages / CTAs have room. */}
            {right && (
                <div className="shrink-0 flex items-center justify-center pl-2 pr-5">
                    {right}
                </div>
            )}
        </div>
    );
}
