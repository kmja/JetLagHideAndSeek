/**
 * SeekerTopBar — fixed-top app chrome for the seeker view.
 *
 * Layout (v628): [debug] — HIDE+SEEK wordmark — [settings ·
 * notifications]. Lobby moved back to the bottom nav (v628); Settings
 * stays here.
 *
 * Mobile-only — desktop has the left/right sidebars and doesn't
 * need a header. The header sits above the map and offsets the
 * small overlay chrome (HiderTimer, MapDisplayControls) downward
 * by their existing `top-2`/`top-[72px]` classes.
 */

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

export function SeekerTopBar() {
    return (
        <header
            className={cn(
                // v462: a real flow row at the top of the seeker column
                // (was `fixed top-0`). Sits ABOVE the map instead of
                // overlaying it, so the map's top controls no longer need
                // to dodge it with a magic top offset.
                "md:hidden shrink-0 z-[1040]",
                "px-3 pb-2",
                // v292: drop the rigid `h-14` and let the bar size
                // itself as safe-area + content + pb.
                "pt-[max(0.5rem,env(safe-area-inset-top))]",
                "bg-jetlag/95 backdrop-blur",
                "border-b border-border",
                "flex items-center justify-between gap-2",
                "group-[.fullscreen]:hidden",
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

            {/* Center — wordmark (plain branding). The debug panel is a
                hidden gesture: 5 quick taps in the top-centre of the screen
                (installDebugSecretTap, v883) — no visible launcher. */}
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

export default SeekerTopBar;
