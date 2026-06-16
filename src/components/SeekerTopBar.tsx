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
                "h-14 px-3",
                "bg-jetlag/95 backdrop-blur",
                "border-b border-border",
                "flex items-center justify-between gap-2",
                "pt-[env(safe-area-inset-top)]",
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
