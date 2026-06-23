import { useStore } from "@nanostores/react";

import { HiderBackgroundMap } from "@/components/HiderBackgroundMap";
import { HiderBottomNav } from "@/components/HiderBottomNav";
import { HiderTimeHeader } from "@/components/HiderTimeHeader";
import { HiderTopBar } from "@/components/HiderTopBar";
import { HiderUnansweredOverlay } from "@/components/HiderUnansweredOverlay";
import { hiderHand } from "@/lib/hiderRole";

/**
 * Top-level hider viewport. v462: mirrors the seeker refactor — the
 * chrome are real flow rows in a flex column, not `fixed` bars overlaid
 * on a full-screen map:
 *
 *   ┌─────────────────────────────────┐
 *   │  HiderTopBar       (flow, top)  │  brand
 *   │  HiderTimeHeader   (flow)       │  phase + countdown
 *   ├─────────────────────────────────┤
 *   │  map area (flex-1, relative)    │  HiderBackgroundMap fills it;
 *   │                                 │  the unanswered banner floats
 *   ├─────────────────────────────────┤  over its top.
 *   │  HiderBottomNav    (flow, btm)  │  Questions / Zone / Lobby / Settings
 *   └─────────────────────────────────┘
 *
 * The HiderHandFan (cards) stays a `fixed bottom-0` overlay — its cards
 * are clipped by the viewport edge by design — so the column reserves
 * its peek-strip height as bottom padding when a hand is held, keeping
 * the bottom nav directly above the fan.
 */
const FAN_HEIGHT_PX = 69;

export function HiderShell() {
    const $hand = useStore(hiderHand);
    const hasCards = $hand.length > 0;
    return (
        <div
            className="fixed inset-0 flex flex-col bg-background text-foreground overflow-hidden"
            style={{
                paddingBottom: hasCards
                    ? `${FAN_HEIGHT_PX}px`
                    : "env(safe-area-inset-bottom)",
            }}
        >
            <HiderTopBar />
            <HiderTimeHeader />
            <div className="relative flex-1 min-h-0">
                <HiderBackgroundMap />
                <HiderUnansweredOverlay />
            </div>
            <HiderBottomNav />
        </div>
    );
}

export default HiderShell;
