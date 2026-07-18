import { useStore } from "@nanostores/react";
import { Footprints } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    hidingPeriodEndsAt,
    seekingStartCelebrationAt,
    seekingStartFiredFor,
    setupCompleted,
} from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { notify } from "@/lib/notifications";
import {
    HIDER_NOTIFICATION_PROMPT,
    maybePromptForNotifications,
} from "@/lib/notificationPrompt";
import { cn } from "@/lib/utils";

/**
 * Watcher + overlay for the round's other big beat: the moment the
 * hiding-period clock crosses zero and the seeking phase begins.
 *
 * The seeker just got handed the go-ahead to start asking questions;
 * the hider sees their elapsed-since-hidden tally start ticking up.
 * That's a major game-flow transition for both roles, so we fire:
 *
 *   - A full-screen "SEEK!" overlay (mirror of GoGoGoOverlay) until
 *     the player taps Got it. (v350: dropped the duplicate toast
 *     banner — the overlay already owns the moment on-screen.)
 *   - An OS notification (via notify()) so a backgrounded device
 *     still gets a buzz.
 *
 * Idempotency: `seekingStartFiredFor` (persistent atom) stores the
 * `hidingPeriodEndsAt` value we already fired for. The watcher only
 * fires when the current period-end timestamp differs from the
 * recorded one — so reloading mid-round doesn't replay, and a fresh
 * round (which clears seekingStartFiredFor in roundActions) fires
 * cleanly. Mounted on both SeekerPage and HiderPage but the work
 * runs in only one instance via the persistent flag's atomic write.
 */

export function SeekingStartWatcher() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $setupCompleted = useStore(setupCompleted);
    const $firedFor = useStore(seekingStartFiredFor);
    const $role = useStore(playerRole);

    const [now, setNow] = useState(() => Date.now());
    // Tick while we're actively waiting for zero. Once we've crossed
    // (or there's no timer), stop the interval — no need to burn cycles.
    const running =
        $setupCompleted &&
        $endsAt !== null &&
        Number.isFinite($endsAt) &&
        $endsAt > now &&
        $firedFor !== $endsAt;
    useVisibleInterval(() => setNow(Date.now()), 1000, running);

    useEffect(() => {
        if (!$setupCompleted) return;
        if ($endsAt === null) return;
        // v820: a non-finite (NaN) clock must NEVER fire SEEK. `NaN === NaN`
        // is false, so the dedupe can't hold and `now < NaN` is false, so
        // without this guard SEEK re-fires every render/tick (the thrash +
        // frozen-map bug). Treat NaN as "no clock".
        if (!Number.isFinite($endsAt)) return;
        if (now < $endsAt) return;
        if ($firedFor === $endsAt) return;
        // Claim this fire — write to the persistent atom first so a
        // mounted copy on the other route doesn't double-fire.
        seekingStartFiredFor.set($endsAt);
        seekingStartCelebrationAt.set(Date.now());
        const isHider = $role === "hider";
        // v350: no toast banner here — the full-screen SEEK! /
        // ON THE HUNT! overlay below already announces the moment, so a
        // duplicate banner is noise. The OS notification stays: it's
        // for a BACKGROUNDED device, which the overlay can't reach.
        notify({
            title: "Seeking phase started",
            body: isHider
                ? "Seekers can ask questions now. Stay sharp."
                : "Time to start asking questions and closing in on the hider.",
            tag: "seeking-start",
        });
        // v946: the hider's contextual "get notified" ask — mirrors the
        // seeker's post-first-question prompt, fired at the moment questions
        // actually start (once per device; no-op if already decided).
        if (isHider) {
            maybePromptForNotifications(HIDER_NOTIFICATION_PROMPT);
        }
    }, [$endsAt, $setupCompleted, $firedFor, $role, now]);

    return null;
}

/**
 * Full-screen celebration overlay. Sister to GoGoGoOverlay — same
 * visual language so the two round-beat moments feel symmetrical.
 * Auto-clears when the player taps the dismiss button.
 */
export function SeekingStartOverlay() {
    const $at = useStore(seekingStartCelebrationAt);
    const $role = useStore(playerRole);

    if ($at === null) return null;

    const isHider = $role === "hider";
    const date = new Date($at);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");

    const handleDismiss = () => seekingStartCelebrationAt.set(null);

    return (
        <div
            className={cn(
                "fixed inset-0 z-[1070]",
                // pointer-events-auto: this is a PLAIN div (not a Radix modal),
                // so when the contextual notification prompt (a Radix Dialog)
                // opens ~simultaneously at seeking-start and sets
                // body{pointer-events:none}, this overlay would otherwise
                // INHERIT none and go inert — "Got it" stops working and clicks
                // pass through to the Radix layer beneath. Forcing auto keeps
                // it interactive + captures its own clicks. (v958)
                "pointer-events-auto",
                "flex items-center justify-center px-6",
                "bg-background/90 backdrop-blur-sm",
                "animate-in fade-in duration-200",
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
                    "animate-in zoom-in-90 duration-300",
                )}
            >
                <div className="text-[10px] uppercase tracking-[0.18em] font-display font-extrabold text-muted-foreground">
                    {hh}:{mm} · Hiding period over
                </div>
                <div
                    className="font-display font-black uppercase text-3xl sm:text-4xl leading-none"
                    style={{ letterSpacing: "-0.02em" }}
                >
                    {isHider ? "The seekers are" : "Now it's your turn"}
                </div>
                <div
                    className={cn(
                        "font-display font-black uppercase",
                        "text-5xl sm:text-6xl leading-none",
                        "text-primary",
                        // Pulse animation to signal the big moment.
                        "animate-pulse",
                    )}
                    style={{ letterSpacing: "-0.04em" }}
                >
                    {isHider ? "ON THE HUNT!" : "SEEK!"}
                </div>
                <p className="text-sm text-muted-foreground leading-snug pt-2">
                    {isHider
                        ? "Sit tight and keep your hand of cards ready. Every minute you stay hidden counts toward your score."
                        : "Ask questions, eliminate possibilities, and close the gap. The hiding clock starts counting up as your time pressure."}
                </p>
                <Button
                    onClick={handleDismiss}
                    size="lg"
                    className={cn(
                        "w-full mt-2 gap-2 text-base h-14",
                        "font-display font-extrabold uppercase tracking-[0.02em]",
                    )}
                >
                    <Footprints className="w-5 h-5" />
                    Got it
                </Button>
            </div>
        </div>
    );
}

export default SeekingStartOverlay;
