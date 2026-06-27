import { useStore } from "@nanostores/react";
import { MapPinOff, PauseCircle } from "lucide-react";

import { useNow } from "@/hooks/useNow";
import {
    gamePausedForLocationAt,
    LOCATION_SHARE_GRACE_MS,
    locationGraceStartedAt,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * Top banner for the "seekers must share location" rule. Two states:
 *
 *   - GRACE: a countdown — seekers stopped sharing, the game pauses
 *     when it hits zero.
 *   - PAUSED: the game is frozen until a seeker shares again.
 *
 * State is driven by `LocationPauseWatcher` (the hider authority).
 * Both roles mount this so seekers see the warning that THEY need to
 * turn location sharing back on, and the hider sees that their clock
 * is protected.
 */
/** Override the grace/paused atoms to preview either banner state in the
 *  /debug/overlays gallery without touching global state. */
export interface LocationPausePreview {
    grace?: number | null;
    paused?: number | null;
}

export function LocationPauseBanner({
    preview,
}: { preview?: LocationPausePreview } = {}) {
    let $grace = useStore(locationGraceStartedAt);
    let $pausedAt = useStore(gamePausedForLocationAt);
    if (preview) {
        $grace = preview.grace ?? null;
        $pausedAt = preview.paused ?? null;
    }
    const active = $grace != null || $pausedAt != null;
    const now = useNow(active);

    if ($pausedAt != null) {
        return (
            <Banner tone="paused">
                <PauseCircle className="h-5 w-5 shrink-0" />
                <div className="leading-tight">
                    <div className="font-semibold">Game paused</div>
                    <div className="text-xs opacity-90">
                        Waiting for a seeker to share their location.
                    </div>
                </div>
            </Banner>
        );
    }

    if ($grace != null) {
        const remaining = Math.max(
            0,
            $grace + LOCATION_SHARE_GRACE_MS - now,
        );
        const mm = Math.floor(remaining / 60_000);
        const ss = Math.floor((remaining % 60_000) / 1000);
        return (
            <Banner tone="grace">
                <MapPinOff className="h-5 w-5 shrink-0" />
                <div className="leading-tight">
                    <div className="font-semibold">
                        Seekers must share their location
                    </div>
                    <div className="text-xs font-bold tabular-nums text-yellow-300">
                        Game pauses in {mm}:{String(ss).padStart(2, "0")}
                    </div>
                </div>
            </Banner>
        );
    }

    return null;
}

function Banner({
    tone,
    children,
}: {
    tone: "grace" | "paused";
    children: React.ReactNode;
}) {
    return (
        <div className="fixed inset-x-0 top-0 z-[1052] flex justify-center pointer-events-none px-3 pt-3">
            <div
                className={cn(
                    "pointer-events-auto flex items-center gap-3 rounded-2xl border px-4 py-2.5 shadow-lg backdrop-blur",
                    tone === "grace"
                        ? "border-yellow-400/50 bg-yellow-950/90 text-yellow-100"
                        : "border-sky-400/50 bg-sky-950/90 text-sky-100",
                )}
            >
                {children}
            </div>
        </div>
    );
}

export default LocationPauseBanner;
