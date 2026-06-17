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
                "fixed top-0 inset-x-0 z-[1041]",
                "h-14 px-3",
                "bg-jetlag/95 backdrop-blur",
                "border-b border-border",
                "flex items-center justify-between gap-2",
                "pt-[env(safe-area-inset-top)]",
            )}
        >
            <div className="w-10 h-10" aria-hidden />
            <HideSeekWordmark className="text-white" />
            <NotificationsIconButton className="w-10 h-10 !bg-white/10 !border-white/30 !text-white hover:!bg-white/20" />
        </header>
    );
}

export default HiderTopBar;
