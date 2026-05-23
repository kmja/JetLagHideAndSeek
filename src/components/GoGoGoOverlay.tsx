import { useStore } from "@nanostores/react";
import { Rocket } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    gameSize,
    gameStartCelebrationAt,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    pendingHidingDurationMin,
} from "@/lib/gameSetup";
import { hostPushSetup } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

/**
 * "GAME READY — we gotta GO, GO, GO!" — fires once the boundary
 * has finished loading. The dialog blocks the rest of the UI and
 * waits for the player to tap the big "Start hiding period!"
 * button before the clock actually starts.
 *
 * Why the manual button instead of an automatic kick-off:
 *  • Country-sized loads take 20-60 s. An auto-start during that
 *    time means the timer was running while the user was just
 *    staring at "Loading…".
 *  • A conscious tap is a clearer "we're starting" moment for a
 *    physical-meeting game where players need to coordinate.
 *  • Matches the show's catchphrase: someone says "GO GO GO" and
 *    the players actually GO.
 *
 * Controlled by `gameStartCelebrationAt` (non-null = dialog
 * visible). Clearing it closes the dialog. Subscribes to
 * `pendingHidingDurationMin` so we know the duration we should
 * commit when the player taps Start.
 */
export function GoGoGoOverlay() {
    const $at = useStore(gameStartCelebrationAt);
    const $pendingMin = useStore(pendingHidingDurationMin);
    const $gameSize = useStore(gameSize);

    if ($at === null) return null;

    const date = new Date($at);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    // Use the queued duration when we have it; fall back to the
    // current `gameSize` mapping so the label is still right if
    // the player re-triggers the dialog from a different angle.
    const minutes =
        $pendingMin && $pendingMin > 0
            ? $pendingMin
            : HIDING_PERIOD_MINUTES[$gameSize];

    const handleStart = () => {
        // Commit the timer NOW. The "go" moment is the user
        // clicking — the celebration is the gate, not just a toast.
        if ($pendingMin && $pendingMin > 0) {
            hidingPeriodEndsAt.set(Date.now() + $pendingMin * 60_000);
            pendingHidingDurationMin.set(null);
        } else {
            hidingPeriodEndsAt.set(
                Date.now() + minutes * 60_000,
            );
        }
        // Mirror the freshly-started hiding period to peers in
        // any active online room. No-op offline.
        hostPushSetup();
        // Close the dialog.
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
                    "px-6 py-8 space-y-5",
                )}
            >
                <div className="text-[10px] uppercase tracking-[0.18em] font-poppins font-bold text-muted-foreground">
                    Game ready · {minutes}-min hiding period
                </div>
                <div className="font-inter-tight font-black uppercase text-3xl sm:text-4xl tracking-tight leading-none">
                    It&apos;s {hh}:{mm} and we gotta
                </div>
                <div
                    className={cn(
                        "font-inter-tight italic font-black uppercase",
                        "text-5xl sm:text-6xl tracking-tight leading-none",
                        "text-primary",
                    )}
                >
                    GO, GO, GO!
                </div>
                <p className="text-xs text-muted-foreground leading-snug pt-1">
                    Tap below to start the {minutes}-minute hiding
                    period. The clock begins the moment you press.
                </p>
                <Button
                    onClick={handleStart}
                    size="lg"
                    className={cn(
                        "w-full gap-2 text-base font-poppins font-bold",
                        "h-14 shadow-lg",
                    )}
                >
                    <Rocket className="w-5 h-5" />
                    Start hiding period
                </Button>
            </div>
        </div>
    );
}

export default GoGoGoOverlay;
