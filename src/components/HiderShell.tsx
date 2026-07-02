import { useStore } from "@nanostores/react";

import { AppShell } from "@/components/AppShell";
import { HiderBackgroundMap } from "@/components/HiderBackgroundMap";
import { HiderBottomNav } from "@/components/HiderBottomNav";
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
 *   ├─────────────────────────────────┤
 *   │  map area (flex-1, relative)    │  HiderBackgroundMap fills it;
 *   │                                 │  the floating HiderMapTimer +
 *   │                                 │  unanswered banner float over it.
 *   ├─────────────────────────────────┤
 *   │  HiderBottomNav    (flow, btm)  │  Questions / Zone / Map / Lobby
 *   └─────────────────────────────────┘
 *
 * v633: the phase/countdown moved OFF the header flow-row onto a floating
 * timer card on the map (HiderMapTimer), matching the seeker layout —
 * brand header on top, a Jet-Lag-show timer card on the map.
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
        <AppShell
            className="fixed inset-0 bg-background text-foreground overflow-hidden"
            style={{
                // Reserve the HiderHandFan's peek-strip height when a hand
                // is held, so the bottom nav lands directly above the
                // (still fixed) fan.
                paddingBottom: hasCards
                    ? `${FAN_HEIGHT_PX}px`
                    : "env(safe-area-inset-bottom)",
            }}
            header={<HiderTopBar />}
            footer={<HiderBottomNav />}
        >
            <HiderBackgroundMap />
            <HiderUnansweredOverlay />
        </AppShell>
    );
}

export default HiderShell;
