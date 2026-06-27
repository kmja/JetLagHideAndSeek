import { useStore } from "@nanostores/react";
import { Snowflake } from "lucide-react";

import { useNow } from "@/hooks/useNow";
import { seekersFrozenUntil } from "@/lib/gameSetup";

/**
 * Seeker-facing banner shown while a hider's Move powerup has the
 * seekers frozen (rulebook: "The seekers are frozen ... until this new
 * hiding period has concluded"). The hider re-anchors to a new station
 * during this window; the seekers must hold position.
 *
 * Reads `seekersFrozenUntil` (Unix ms). Renders a fixed top banner
 * with a live MM:SS countdown while `now < seekersFrozenUntil`, and
 * nothing otherwise. Self-clearing — once the countdown lapses the
 * banner disappears on the next tick (the atom is left as-is; scoring
 * doesn't read it, so there's no need to null it eagerly).
 */
/** Override the frozen-until atom to preview the banner in the
 *  /debug/overlays gallery without touching global state. */
export interface SeekerFrozenPreview {
    frozenUntil: number | null;
}

export function SeekerFrozenBanner({
    preview,
}: { preview?: SeekerFrozenPreview } = {}) {
    let $frozenUntil = useStore(seekersFrozenUntil);
    if (preview) $frozenUntil = preview.frozenUntil;
    const active = $frozenUntil !== null && $frozenUntil > Date.now();
    const now = useNow(active);

    if ($frozenUntil === null) return null;
    const remainingMs = $frozenUntil - now;
    if (remainingMs <= 0) return null;

    const totalSec = Math.ceil(remainingMs / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;

    return (
        <div className="fixed inset-x-0 top-0 z-[1052] flex justify-center pointer-events-none px-3 pt-3">
            <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-sky-400/40 bg-sky-950/90 px-4 py-2.5 text-sky-100 shadow-lg backdrop-blur">
                <Snowflake className="h-5 w-5 shrink-0 text-sky-300" />
                <div className="text-sm leading-tight">
                    <div className="font-semibold">Seekers frozen</div>
                    <div className="text-sky-200/80">
                        The hider played Move — hold position for{" "}
                        <span className="tabular-nums font-semibold">
                            {mm}:{String(ss).padStart(2, "0")}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
