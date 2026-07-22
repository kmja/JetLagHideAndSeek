import { BookOpen, Settings } from "lucide-react";

import { HideSeekWordmark } from "@/components/JetLagLogo";
import { moreSheetOpen } from "@/lib/gameSetup";
import { openRulebookAt } from "@/lib/rulebook";
import { cn } from "@/lib/utils";

/** Icon button styled for the dark (bg-jetlag) header. */
const headerBtn = cn(
    "relative h-10 w-10 flex items-center justify-center rounded-md",
    "border border-white/30 bg-white/10 text-white transition-colors",
    "hover:bg-white/20",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
);

/**
 * Shared fixed-top app chrome: `[Settings · HIDE+SEEK wordmark · Rulebook]`.
 *
 * v1120: the SINGLE source for both `SeekerTopBar` and `HiderTopBar`, which
 * were ~90% identical (only z-index / `md:hidden` / fullscreen-hide differed).
 * The centered wordmark is a hidden debug-panel gesture — 5 quick taps in the
 * top-centre of the screen (`installDebugSecretTap`, v883) — no visible
 * launcher. Notifications live in Settings (v1044).
 *
 * @param hideOnDesktop  seeker: hides on `md:` (the desktop sidebars carry the
 *   brand); hider: always visible (no sidebars).
 * @param className  per-role z-index (+ the seeker's `group-[.fullscreen]:hidden`).
 */
export function AppTopBar({
    hideOnDesktop = false,
    className,
}: {
    hideOnDesktop?: boolean;
    className?: string;
}) {
    return (
        <header
            className={cn(
                hideOnDesktop && "md:hidden",
                // v462: a real flow row at the top of the column (was
                // `fixed top-0`), so it sits ABOVE the map instead of
                // overlaying it. v292: no rigid `h-14` — size to
                // safe-area + content + pb (Dynamic Island devices).
                "shrink-0",
                "px-3 pb-2",
                "pt-[max(0.5rem,env(safe-area-inset-top))]",
                "bg-jetlag/95 backdrop-blur",
                "border-b border-border",
                "flex items-center justify-between gap-2",
                className,
            )}
        >
            {/* Left — settings. */}
            <button
                type="button"
                onClick={() => moreSheetOpen.set(true)}
                className={headerBtn}
                aria-label="Settings"
                title="Settings — tutorial, rulebook, units, theme, preload"
            >
                <Settings className="w-4 h-4" />
            </button>

            {/* Center — wordmark (plain branding; hidden debug gesture). */}
            <HideSeekWordmark className="text-white" />

            {/* Right — rulebook (v1044). Notifications moved into Settings. */}
            <button
                type="button"
                onClick={() => openRulebookAt("")}
                className={headerBtn}
                aria-label="Rulebook"
                title="Open the Hide + Seek rulebook (searchable)"
            >
                <BookOpen className="w-4 h-4" />
            </button>
        </header>
    );
}

export default AppTopBar;
