import type { LucideIcon } from "lucide-react";
import {
    Beef,
    BookOpen,
    Building2,
    Camera,
    Check,
    FerrisWheel,
    Film,
    Fish,
    Flag,
    Hospital,
    Hourglass,
    Landmark,
    Mountain,
    PawPrint,
    Plane,
    Ruler,
    ShoppingBag,
    Train,
    TrainFront,
    TrainTrack,
    TreePine,
    Trees,
    Waves,
} from "lucide-react";
import type { ReactNode } from "react";

import { CATEGORIES, type CategoryId } from "@/lib/categories";
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

const SUBTYPE_ICONS: Record<string, LucideIcon> = {
    airport: Plane,
    city: Building2,
    "major-city": Building2,
    aquarium: Fish,
    hospital: Hospital,
    peak: Mountain,
    museum: Landmark,
    theme_park: FerrisWheel,
    zoo: PawPrint,
    cinema: Film,
    library: BookOpen,
    golf_course: Flag,
    consulate: Landmark,
    park: Trees,
    coastline: Waves,
    mcdonalds: Beef,
    seven11: ShoppingBag,
    "rail-measure": Train,
    "same-train-line": TrainTrack,
    "same-length-station": Ruler,
    "highspeed-measure-shinkansen": TrainFront,
    tree: TreePine,
    selfie: Camera,
};

function getSubtypeIcon(type: string | undefined): LucideIcon | null {
    if (!type) return null;
    const stripped = type.endsWith("-full")
        ? type.slice(0, -"-full".length)
        : type;
    return SUBTYPE_ICONS[stripped] ?? null;
}

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
            return "Shinkansen";
        case "same-train-line":
            return "Train line";
        case "same-length-station":
            return "Station length";
        default:
            return stripped.replace(/[-_]/g, " ");
    }
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
function deepColor(hex: string): string {
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
    right,
    answered = false,
    onClick,
    ariaLabel,
    className,
}: {
    categoryId: string;
    summary: QuestionSummary;
    /** Right-hand slot — timer, retry button, countdown, chevron, … */
    right?: ReactNode;
    answered?: boolean;
    onClick?: () => void;
    ariaLabel?: string;
    className?: string;
}) {
    const meta = CATEGORIES[categoryId as CategoryId];
    const base = meta?.color ?? "#999";
    // `deep` (saturated/dark) reads on a LIGHT card; the original pastel
    // `base` reads on a DARK card. We expose both as CSS vars so the
    // label + timer can switch on `.dark` without knowing the theme.
    const deep = answered ? "#10b981" : deepColor(base);
    const bright = answered ? "#34d399" : base;
    const Icon = summary.icon ?? meta?.icon ?? Hourglass;
    const interactive = Boolean(onClick);

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
                {answered ? (
                    <Check
                        size={24}
                        strokeWidth={3}
                        className="animate-[jlAnsweredPop_400ms_ease-out]"
                    />
                ) : (
                    <Icon size={22} strokeWidth={2.5} />
                )}
            </span>

            {/* Big coloured label + one short description (middle). */}
            <div className="min-w-0 flex-1 px-3 py-2 flex flex-col justify-center">
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

            {/* Live status — timer / retry / answered (right). */}
            {right && (
                <div className="shrink-0 flex items-center justify-center pl-1 pr-3 min-w-[3.75rem]">
                    {right}
                </div>
            )}
        </div>
    );
}
