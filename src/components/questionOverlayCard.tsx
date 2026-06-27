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

/** hex (#rrggbb) → rgba() string, for the show-style category tinting. */
export function hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return hex;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
    const color = meta?.color ?? "#999";
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
            className={cn(
                // Fixed height so the left icon block can resolve to a
                // SQUARE — `aspect-square` only computes a width when the
                // height is definite, which a content-driven flex row is
                // not.
                "pointer-events-auto relative flex items-stretch overflow-hidden h-[4.5rem]",
                "bg-background/95 backdrop-blur-md shadow-xl",
                "border-2 transition-all duration-300",
                interactive &&
                    "cursor-pointer select-none active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className,
            )}
            style={{
                borderColor: answered
                    ? "rgb(16 185 129 / 0.8)"
                    : hexToRgba(color, 0.55),
            }}
        >
            {/* Category wash across the whole card (behind content). */}
            <div
                className="absolute inset-0 pointer-events-none transition-colors duration-300"
                style={{
                    backgroundColor: answered
                        ? "rgb(16 185 129 / 0.10)"
                        : hexToRgba(color, 0.1),
                }}
                aria-hidden
            />

            {/* Square solid category-colour icon block (left). `h-full`
                makes the height definite so `aspect-square` resolves the
                width to match (true square). */}
            <span
                className="relative h-full aspect-square flex items-center justify-center shrink-0 transition-colors duration-300"
                style={{ backgroundColor: answered ? "#10b981" : color }}
                aria-hidden="true"
            >
                {answered ? (
                    <Check
                        size={22}
                        strokeWidth={3}
                        className="text-white animate-[jlAnsweredPop_400ms_ease-out]"
                    />
                ) : (
                    <Icon size={20} strokeWidth={2.5} className="text-white" />
                )}
            </span>

            {/* Big label + one short description (two lines). */}
            <div className="relative min-w-0 flex-1 px-3 py-2 flex flex-col justify-center">
                <div
                    className="font-display font-extrabold uppercase leading-[1.05] text-base sm:text-lg truncate"
                    style={{
                        color: answered ? undefined : color,
                        letterSpacing: "-0.01em",
                    }}
                >
                    {summary.bigLabel}
                </div>
                {summary.detail && (
                    <div className="text-[11px] text-muted-foreground leading-snug truncate mt-0.5">
                        {summary.detail}
                    </div>
                )}
            </div>

            {/* Caller-supplied right slot. */}
            {right && (
                <div className="relative shrink-0 flex items-center justify-center px-3">
                    {right}
                </div>
            )}
        </div>
    );
}
