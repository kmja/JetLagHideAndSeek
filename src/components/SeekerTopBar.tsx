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

import { Settings } from "lucide-react";

import { HideSeekWordmark } from "@/components/JetLagLogo";
import { NotificationsIconButton } from "@/components/NotificationsToggle";
import { debugPanelOpen } from "@/lib/debugState";
import { moreSheetOpen } from "@/lib/gameSetup";
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

            {/* Center — wordmark; tap opens the developer debug panel
                (replaced the standalone debug launcher, v747). */}
            <button
                type="button"
                onClick={() => debugPanelOpen.set(true)}
                className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                aria-label="Open developer debug panel"
            >
                <HideSeekWordmark className="text-white" />
            </button>

            {/* Right — notifications. */}
            <NotificationsIconButton className="w-10 h-10 !bg-white/10 !border-white/30 !text-white hover:!bg-white/20" />
        </header>
    );
}

export default SeekerTopBar;
