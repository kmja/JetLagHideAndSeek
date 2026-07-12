import { useStore } from "@nanostores/react";
import { Timer } from "lucide-react";
import { useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { formatTimeRemaining, hidingPeriodEndsAt } from "@/lib/gameSetup";
import { roundFoundAt } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

/**
 * Compact golden "hiding time remaining" badge — a shrunk copy of the on-map
 * `HiderMapTimer` hiding box (same `#F2C63C` / `#1F2F3F` palette), sized to sit
 * in the corner of the Zone drawer header next to the title. Self-contained:
 * it reads `hidingPeriodEndsAt` and ticks its own 1s countdown (paused while
 * backgrounded / after the round is found), and renders nothing outside the
 * hiding period (before the whistle) so the header is clean once seeking
 * starts.
 */
export function HidingCountdownBadge({ className }: { className?: string }) {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $found = useStore(roundFoundAt);
    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(
        () => setNow(Date.now()),
        1000,
        $endsAt !== null && $found === null,
    );

    // Only during the hiding period — nothing to show once the whistle blows.
    if ($endsAt === null || now >= $endsAt) return null;
    const remainingMs = Math.max(0, $endsAt - now);

    return (
        <div
            role="status"
            aria-live="polite"
            aria-label={`Hiding time remaining: ${formatTimeRemaining(remainingMs)}`}
            className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-xl pl-3 pr-4 py-2 shadow-md bg-[#F2C63C]",
                className,
            )}
        >
            <Timer
                className="w-7 h-7 shrink-0 text-[#1F2F3F]"
                strokeWidth={2.5}
            />
            <div className="flex flex-col leading-none gap-1">
                <span className="text-[9px] font-poppins font-extrabold uppercase tracking-[0.12em] text-[#1F2F3F]">
                    Time left
                </span>
                <span className="font-inter-tight font-black tabular-nums text-2xl leading-none text-[#1F2F3F]">
                    {formatTimeRemaining(remainingMs)}
                </span>
            </div>
        </div>
    );
}

export default HidingCountdownBadge;
