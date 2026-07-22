import { cn } from "@/lib/utils";

/**
 * Shared bottom-nav primitives for the seeker (`BottomNav`) and hider
 * (`HiderBottomNav`) navs, which are structurally identical (v632 parity) and
 * had hand-kept byte-identical class strings + a 6×-duplicated badge pill.
 * v1121 (dedup batch 2, C4) single-sources the layout so the two navs can't
 * drift. Per-slot COLOUR (tone / border) stays with each caller — the seeker
 * and hider deliberately tint some badges differently — so this only unifies
 * the geometry, not the palette (no visual change).
 */

/** A standard nav slot button (Questions / Map / Lobby). */
export const NAV_BTN_CLASS = cn(
    "relative flex-1 flex flex-col items-center justify-center gap-0.5",
    "py-2 px-1 rounded-md min-h-[48px]",
    "text-muted-foreground hover:text-foreground hover:bg-secondary",
    "active:bg-secondary/80 transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

/** The centre PRIMARY CTA (seeker "New question" / hider "Zone") — filled red, wider. */
export const NAV_PRIMARY_CLASS = cn(
    "relative flex-[1.4] flex flex-col items-center justify-center gap-0.5",
    "py-2 px-1 rounded-md min-h-[48px]",
    "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
    "transition-colors font-poppins",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

export const NAV_LABEL_CLASS = "text-[10px] font-poppins font-semibold";
export const NAV_PRIMARY_LABEL_CLASS =
    "text-[10px] font-bold uppercase tracking-wider";

/**
 * The small count pill in a nav slot's top-right corner. Base geometry is
 * shared; the caller passes its tone/border via `className` (seeker uses
 * secondary+border on Questions/Lobby, primary+border-background on Map; the
 * hider uses a borderless primary everywhere).
 */
export function NavBadge({
    count,
    className,
    "aria-label": ariaLabel,
}: {
    count: number;
    className?: string;
    "aria-label"?: string;
}) {
    return (
        <span
            className={cn(
                "absolute top-1 right-2",
                "text-[9px] font-mono font-semibold",
                "px-1.5 min-w-[18px] h-[18px]",
                "rounded-full flex items-center justify-center",
                className,
            )}
            aria-label={ariaLabel}
        >
            {count}
        </span>
    );
}
