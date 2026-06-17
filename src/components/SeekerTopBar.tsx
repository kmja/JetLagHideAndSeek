/**
 * SeekerTopBar — fixed-top app chrome for the seeker view.
 *
 * Layout: HIDE+SEEK wordmark (centre), Notifications (right). The
 * left-side gear button was retired in v270 when the Settings
 * drawer moved into the bottom nav's rightmost slot; surfacing the
 * same trigger twice was clutter.
 *
 * Mobile-only — desktop has the left/right sidebars and doesn't
 * need a header. The header sits above the map and offsets the
 * small overlay chrome (HiderTimer, MapDisplayControls) downward
 * by their existing `top-2`/`top-[72px]` classes.
 */

import { HideSeekWordmark } from "@/components/JetLagLogo";
import { NotificationsIconButton } from "@/components/NotificationsToggle";
import { cn } from "@/lib/utils";

export function SeekerTopBar() {
    return (
        <header
            className={cn(
                "md:hidden fixed top-0 inset-x-0 z-[1040]",
                "px-3 pb-2",
                // v292: drop the rigid `h-14` and let the bar size
                // itself as safe-area + content + pb. With h-14 the
                // env(safe-area-inset-top) padding-top was eating into
                // the fixed 56 px box (Dynamic Island devices report
                // ~59 px of inset), squashing the wordmark under the
                // notch.
                "pt-[max(0.5rem,env(safe-area-inset-top))]",
                "bg-jetlag/95 backdrop-blur",
                "border-b border-border",
                "flex items-center justify-between gap-2",
                "group-[.fullscreen]:hidden",
            )}
        >
            {/* Spacer so the wordmark stays optically centred even
                with the notif button on the right. */}
            <div className="w-10 h-10" aria-hidden />

            <HideSeekWordmark className="text-white" />

            <NotificationsIconButton className="w-10 h-10 !bg-white/10 !border-white/30 !text-white hover:!bg-white/20" />
        </header>
    );
}

export default SeekerTopBar;
