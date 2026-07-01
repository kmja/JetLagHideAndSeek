/**
 * SeekerTopBar — fixed-top app chrome for the seeker view.
 *
 * Layout (v623): [debug · lobby] — HIDE+SEEK wordmark — [settings ·
 * notifications]. Lobby + Settings moved here from the bottom nav so
 * the nav is down to Questions / New question / Map.
 *
 * Mobile-only — desktop has the left/right sidebars and doesn't
 * need a header. The header sits above the map and offsets the
 * small overlay chrome (HiderTimer, MapDisplayControls) downward
 * by their existing `top-2`/`top-[72px]` classes.
 */

import { useStore } from "@nanostores/react";
import { Settings, Users } from "lucide-react";

import { DebugLaunchButton } from "@/components/DebugLaunchButton";
import { HideSeekWordmark } from "@/components/JetLagLogo";
import { NotificationsIconButton } from "@/components/NotificationsToggle";
import { moreSheetOpen } from "@/lib/gameSetup";
import { lobbyManualOpen, participants } from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/** Icon button styled for the dark (bg-jetlag) header. */
const headerBtn = cn(
    "relative h-10 w-10 flex items-center justify-center rounded-md",
    "border border-white/30 bg-white/10 text-white transition-colors",
    "hover:bg-white/20",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
);

export function SeekerTopBar() {
    const $participants = useStore(participants);
    const onlineCount = $participants.filter((p) => p.online).length;

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
            {/* Left cluster — debug launcher + lobby. */}
            <div className="flex items-center gap-2">
                <DebugLaunchButton />
                <button
                    type="button"
                    onClick={() => lobbyManualOpen.set(true)}
                    className={headerBtn}
                    aria-label="Open game lobby"
                    title="Players, room code, role rotation"
                >
                    <Users className="w-4 h-4" />
                    {onlineCount > 0 && (
                        <span
                            className={cn(
                                "absolute -top-1.5 -right-1.5",
                                "inline-flex items-center justify-center",
                                "min-w-[18px] h-[18px] px-1 rounded-full",
                                "bg-primary text-primary-foreground",
                                "text-[10px] font-poppins font-bold tabular-nums",
                                "border border-white/40",
                            )}
                            aria-label={`${onlineCount} players online`}
                        >
                            {onlineCount}
                        </span>
                    )}
                </button>
            </div>

            <HideSeekWordmark className="text-white" />

            {/* Right cluster — settings + notifications. */}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => moreSheetOpen.set(true)}
                    className={headerBtn}
                    aria-label="Settings"
                    title="Settings — tutorial, rulebook, units, theme, preload"
                >
                    <Settings className="w-4 h-4" />
                </button>
                <NotificationsIconButton className="w-10 h-10 !bg-white/10 !border-white/30 !text-white hover:!bg-white/20" />
            </div>
        </header>
    );
}

export default SeekerTopBar;
