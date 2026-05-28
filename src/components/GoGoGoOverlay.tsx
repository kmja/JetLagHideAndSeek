import { useStore } from "@nanostores/react";
import { Rocket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    formatTimeRemaining,
    gameSize,
    gameStartCelebrationAt,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import { useState } from "react";

/**
 * "GAME READY — we gotta GO, GO, GO!" — a celebration banner that
 * fires the moment the hiding-period clock starts ticking. Shown on
 * every device in the room (seeker AND hider) — kickoff happens in
 * the lobby's Start button (on the host) or via the host's
 * `setupChanged` push (on guests). The overlay is purely
 * informational: dismiss when you're ready to look at the map.
 *
 * Behavior:
 *  - Auto-opened by `GameStartWatcher` when `hidingPeriodEndsAt`
 *    transitions from null → non-null.
 *  - Shows a live MM:SS countdown so the player can see the hider's
 *    head-start ticking while the message is up.
 *  - Single button "Got it — show me the map" clears the celebration
 *    and reveals the live map underneath. The hiding period itself
 *    keeps running.
 *
 * Controlled by `gameStartCelebrationAt` (non-null = visible).
 */
export function GoGoGoOverlay() {
    const $at = useStore(gameStartCelebrationAt);
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $gameSize = useStore(gameSize);

    const [now, setNow] = useState(() => Date.now());
    const running = $at !== null && $endsAt !== null && $endsAt > now;
    useVisibleInterval(() => setNow(Date.now()), 1000, running);

    if ($at === null) return null;

    const date = new Date($at);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const totalMinutes = HIDING_PERIOD_MINUTES[$gameSize];
    const remainingMs = Math.max(0, ($endsAt ?? 0) - now);

    const handleDismiss = () => {
        gameStartCelebrationAt.set(null);
    };

    return (
        <div
            className={cn(
                "fixed inset-0 z-[1070]",
                "flex items-center justify-center px-6",
                "bg-background/90 backdrop-blur-sm",
            )}
            role="dialog"
            aria-modal="true"
            aria-live="assertive"
        >
            <div
                className={cn(
                    "max-w-md w-full text-center",
                    "rounded-md border-2 border-primary bg-card shadow-xl",
                    "px-6 py-8 space-y-4",
                )}
            >
                <div className="text-[10px] uppercase tracking-[0.18em] font-display font-extrabold text-muted-foreground">
                    Game on · {totalMinutes}-min hiding period
                </div>
                <div
                    className="font-display font-black uppercase text-3xl sm:text-4xl leading-none"
                    style={{ letterSpacing: "-0.02em" }}
                >
                    It&apos;s {hh}:{mm} and we gotta
                </div>
                <div
                    className={cn(
                        "font-display font-black uppercase",
                        "text-5xl sm:text-6xl leading-none",
                        "text-primary",
                    )}
                    style={{ letterSpacing: "-0.04em" }}
                >
                    GO, GO, GO!
                </div>
                {$endsAt !== null && (
                    <div className="pt-2 space-y-1">
                        <div className="text-[10px] uppercase tracking-[0.18em] font-display font-extrabold text-muted-foreground">
                            Hiding period
                        </div>
                        <div
                            className="font-inter-tight italic font-black tabular-nums text-5xl leading-none"
                            style={{ color: "hsl(var(--accent-yellow))" }}
                        >
                            {formatTimeRemaining(remainingMs)}
                        </div>
                    </div>
                )}
                <Button
                    onClick={handleDismiss}
                    size="lg"
                    className={cn(
                        "w-full mt-2 gap-2 text-base h-14",
                        "font-display font-extrabold uppercase tracking-[0.02em]",
                    )}
                >
                    <Rocket className="w-5 h-5" />
                    Got it — show me the map
                </Button>
            </div>
        </div>
    );
}

export default GoGoGoOverlay;
