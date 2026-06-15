/**
 * SeekerTopBar — fixed-top app chrome for the seeker view.
 *
 * Layout: Settings (left, opens the "More" sheet that BottomNav
 * still owns the content for), HIDE+SEEK wordmark (centre),
 * Notifications (right). Matches the bottom nav's z-index so its
 * sheet sits above both.
 *
 * Mobile-only — desktop has the left/right sidebars and doesn't
 * need a header. The header sits above the map and offsets the
 * small overlay chrome (HiderTimer, CacheStatusPill,
 * MapDisplayControls) downward by their existing `top-2`/`top-[72px]`
 * classes.
 *
 * Owns the "More" sheet's open state via the shared
 * `moreSheetOpen` atom — the sheet content lives in BottomNav for
 * now so this header is purely a trigger.
 */

import { Settings } from "lucide-react";

import { HideSeekWordmark } from "@/components/JetLagLogo";
import { NotificationsIconButton } from "@/components/NotificationsToggle";
import { moreSheetOpen } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

const ICON_BTN =
    "w-10 h-10 inline-flex items-center justify-center rounded-md " +
    "text-foreground hover:bg-secondary active:bg-accent " +
    "transition-colors focus-visible:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-ring";

export function SeekerTopBar() {
    return (
        <header
            className={cn(
                "md:hidden fixed top-0 inset-x-0 z-[1040]",
                "h-14 px-2",
                "bg-jetlag/95 backdrop-blur",
                "border-b border-border",
                "flex items-center justify-between gap-2",
                "pt-[env(safe-area-inset-top)]",
                "group-[.fullscreen]:hidden",
            )}
        >
            <button
                type="button"
                onClick={() => moreSheetOpen.set(true)}
                className={ICON_BTN}
                title="Settings & options"
                aria-label="Open settings"
            >
                <Settings className="w-5 h-5" strokeWidth={2} />
            </button>

            <HideSeekWordmark className="text-foreground" />

            <NotificationsIconButton className="w-10 h-10" />
        </header>
    );
}

export default SeekerTopBar;
