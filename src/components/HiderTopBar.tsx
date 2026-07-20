import { BookOpen, Settings } from "lucide-react";

import { HideSeekWordmark } from "@/components/JetLagLogo";
import { moreSheetOpen } from "@/lib/gameSetup";
import { openRulebookAt } from "@/lib/rulebook";
import { cn } from "@/lib/utils";

/** Icon button styled for the dark (bg-jetlag) header — matches
 *  SeekerTopBar's `headerBtn`. */
const headerBtn = cn(
    "relative h-10 w-10 flex items-center justify-center rounded-md",
    "border border-white/30 bg-white/10 text-white transition-colors",
    "hover:bg-white/20",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
);

/**
 * HiderTopBar — brand chrome at the top of the hider viewport.
 *
 * Layout (v632, parity with SeekerTopBar): [debug] — HIDE+SEEK wordmark
 * — [Settings · Notifications]. Settings moved here from the bottom nav
 * (opens the shared AppSettingsDrawer via `moreSheetOpen`).
 *
 * Stays visible at all viewport sizes, since the hider page has no
 * sidebars to provide brand cues on desktop.
 *
 * v633: the phase label + countdown moved off a header row onto the
 * floating `HiderMapTimer` card on the map, so this brand bar is the
 * hider's only top chrome now — matching the seeker's `SeekerTopBar`.
 */
export function HiderTopBar() {
    return (
        <header
            className={cn(
                // v462: flow row at the top of the hider column (was
                // `fixed top-0`), so it sits ABOVE the map.
                "shrink-0 z-[1041]",
                "px-3 pb-2",
                // v292: drop the rigid `h-14` (which fixed-height
                // squashed the wordmark on Dynamic Island devices
                // where env(safe-area-inset-top) ≈ 59 px alone). Now
                // the bar sizes itself as safe-area + content + pb.
                "pt-[max(0.5rem,env(safe-area-inset-top))]",
                "bg-jetlag/95 backdrop-blur",
                "border-b border-border",
                "flex items-center justify-between gap-2",
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

export default HiderTopBar;
