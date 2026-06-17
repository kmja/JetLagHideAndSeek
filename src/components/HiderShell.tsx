import { HiderBackgroundMap } from "@/components/HiderBackgroundMap";
import { HiderBottomNav } from "@/components/HiderBottomNav";
import { HiderTimeHeader } from "@/components/HiderTimeHeader";
import { HiderTopBar } from "@/components/HiderTopBar";
import { HiderUnansweredOverlay } from "@/components/HiderUnansweredOverlay";

/**
 * Top-level hider viewport — the seeker-mirrored layout the user
 * asked for:
 *
 *   ┌─────────────────────────────────┐
 *   │  HiderTimeHeader                │  fixed top, big timer + lobby
 *   ├─────────────────────────────────┤
 *   │                                 │
 *   │  HiderBackgroundMap             │  absolute inset-0, behind chrome
 *   │  (zone / spot / scouted / GPS)  │
 *   │                                 │
 *   ├─────────────────────────────────┤
 *   │  HiderBottomNav                 │  fixed bottom-[150px]
 *   │  (Questions + Settings sheets)  │
 *   ├─────────────────────────────────┤
 *   │  HiderHandFan                   │  fixed bottom-0 (mounted at HiderPage)
 *   └─────────────────────────────────┘
 *
 * The phase-aware action UI (commit zone, lock spot, end hiding,
 * trigger endgame, mark found, etc.) lives inside the Settings
 * sheet so the map can stay dominant. The header advertises the
 * current phase and timer; tapping Settings opens the action
 * panel.
 */
export function HiderShell() {
    return (
        <div className="fixed inset-0 bg-background text-foreground overflow-hidden">
            <HiderBackgroundMap />
            <HiderTopBar />
            <HiderTimeHeader />
            <HiderUnansweredOverlay />
            <HiderBottomNav />
        </div>
    );
}

export default HiderShell;
