import { DebugLaunchButton } from "@/components/DebugLaunchButton";
import { HideSeekWordmark } from "@/components/JetLagLogo";
import { NotificationsIconButton } from "@/components/NotificationsToggle";
import { cn } from "@/lib/utils";

/**
 * HiderTopBar — brand chrome at the top of the hider viewport.
 *
 * Mirrors SeekerTopBar's content (HIDE+SEEK wordmark + notifications
 * icon) but stays visible at all viewport sizes, since the hider
 * page has no sidebars to provide brand cues on desktop.
 *
 * Sits ABOVE HiderTimeHeader (which carries the phase label +
 * countdown). The two together form the hider's full top chrome —
 * brand on top, status below — matching the seeker's vertical
 * hierarchy.
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
            <DebugLaunchButton />
            <HideSeekWordmark className="text-white" />
            <NotificationsIconButton className="w-10 h-10 !bg-white/10 !border-white/30 !text-white hover:!bg-white/20" />
        </header>
    );
}

export default HiderTopBar;
