import { useStore } from "@nanostores/react";
import { useEffect, useState } from "react";

import {
    gameStartCelebrationAt,
    HIDING_PERIOD_MINUTES,
    gameSize,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * "It's HH:MM and we gotta GO, GO, GO!" — the Jet Lag opening
 * catchphrase. Fires once at the moment the hiding period
 * actually begins (after the boundary loads). Auto-dismisses
 * after ~4 seconds. Tappable to dismiss early.
 *
 * Subscribes to `gameStartCelebrationAt`, which `GameStartWatcher`
 * sets when both `pendingHidingDurationMin` and the boundary
 * become available. Clearing the atom on dismiss prevents a
 * remount from re-firing the banner.
 */
const VISIBLE_MS = 4000;

export function GoGoGoOverlay() {
    const $at = useStore(gameStartCelebrationAt);
    const [hiding, setHiding] = useState(false);

    useEffect(() => {
        if ($at === null) {
            setHiding(false);
            return;
        }
        setHiding(false);
        const fade = window.setTimeout(() => setHiding(true), VISIBLE_MS - 350);
        const close = window.setTimeout(() => {
            gameStartCelebrationAt.set(null);
        }, VISIBLE_MS);
        return () => {
            window.clearTimeout(fade);
            window.clearTimeout(close);
        };
    }, [$at]);

    if ($at === null) return null;

    const date = new Date($at);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");

    const minutes = HIDING_PERIOD_MINUTES[gameSize.get()];

    return (
        <div
            className={cn(
                "fixed inset-0 z-[1070]",
                "flex items-center justify-center px-6",
                "bg-background/85 backdrop-blur-sm",
                "transition-opacity duration-300",
                hiding ? "opacity-0" : "opacity-100",
            )}
            role="status"
            aria-live="assertive"
            onClick={() => {
                setHiding(true);
                window.setTimeout(
                    () => gameStartCelebrationAt.set(null),
                    300,
                );
            }}
        >
            <div
                className={cn(
                    "max-w-md w-full text-center",
                    "rounded-md border-2 border-primary bg-card shadow-xl",
                    "px-6 py-8 space-y-4",
                )}
            >
                <div className="text-[10px] uppercase tracking-[0.18em] font-poppins font-bold text-muted-foreground">
                    {hh}:{mm} · {minutes}-min hiding period begins
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
                <div className="text-xs text-muted-foreground pt-1">
                    Tap to dismiss
                </div>
            </div>
        </div>
    );
}

export default GoGoGoOverlay;
