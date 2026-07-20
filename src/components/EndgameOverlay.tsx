import { useStore } from "@nanostores/react";
import { MapPinOff, Sparkles, Target } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import {
    endgameDeniedAt,
    endgameDeniedReason,
    endgameSuccessAt,
    pendingEndgameZone,
} from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { seekerStartEndgame } from "@/lib/multiplayer/store";
import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

/**
 * The big endgame milestone moment (v959). Reaching the endgame is a major
 * game beat, so instead of a small toast/banner we throw a full-screen
 * animation on BOTH roles:
 *
 *   - SUCCESS (`endgameSuccessAt`): the seekers correctly reached the hider's
 *     zone. A gold burst + confetti; the seeker map ALSO cuts down to just the
 *     final zone (see Map.tsx's endgame-focus). Dismissed by tapping through.
 *   - FAIL (`endgameDeniedAt`): the server validated the claim as the WRONG
 *     zone — nothing was armed, the seekers can re-try. A red shake; auto-
 *     clears after a few seconds (or on tap).
 *
 * Replaces the old small `EndgameDeniedBanner`. Portaled to <body> at a high
 * z-index (like the GO-GO-GO overlay) so no map/nav stacking context traps it;
 * `pointer-events-auto` so a co-open Radix modal's body lock can't make it
 * inert (same lesson as the SEEK overlay).
 */

/** How long the FAIL overlay stays before auto-clearing. */
const FAIL_MS = 6500;

const CONFETTI_COLORS = [
    "hsl(45 93% 58%)",
    "hsl(5 69% 55%)",
    "hsl(150 55% 50%)",
    "hsl(210 80% 60%)",
    "hsl(275 60% 62%)",
];

interface Burst {
    dx: string;
    dy: string;
    rot: string;
    color: string;
    delay: string;
    left: string;
    top: string;
}

/** A deterministic confetti ring (no Math.random — index-driven angles). */
function useConfetti(count: number, colors: string[]): Burst[] {
    return useMemo(() => {
        const pieces: Burst[] = [];
        for (let i = 0; i < count; i++) {
            const ang = (i / count) * Math.PI * 2;
            const dist = 120 + (i % 4) * 46;
            pieces.push({
                dx: `${Math.cos(ang) * dist}px`,
                dy: `${Math.sin(ang) * dist - 40}px`,
                rot: `${(i % 2 ? 1 : -1) * (180 + (i % 5) * 60)}deg`,
                color: colors[i % colors.length],
                delay: `${(i % 6) * 30}ms`,
                left: `${48 + (i % 3) * 2}%`,
                top: `${46 + (i % 3) * 2}%`,
            });
        }
        return pieces;
    }, [count, colors]);
}

export function EndgameOverlay() {
    const $success = useStore(endgameSuccessAt);
    const $denied = useStore(endgameDeniedAt);
    const $deniedReason = useStore(endgameDeniedReason);
    const $role = useStore(playerRole);

    // Which beat is live, keyed on its trigger timestamp so a re-fire replays.
    const [beat, setBeat] = useState<{
        kind: "success" | "fail";
        at: number;
    } | null>(null);

    useEffect(() => {
        if ($success == null) return;
        setBeat({ kind: "success", at: $success });
        play("roundEnd");
    }, [$success]);

    useEffect(() => {
        if ($denied == null) return;
        setBeat({ kind: "fail", at: $denied });
        play("elimination");
        const t = window.setTimeout(() => {
            if (endgameDeniedAt.get() === $denied) endgameDeniedAt.set(null);
            setBeat((b) => (b?.at === $denied ? null : b));
        }, FAIL_MS);
        return () => window.clearTimeout(t);
    }, [$denied]);

    // If a trigger is cleared externally (e.g. a round reset while the
    // success overlay is still up, un-dismissed), drop the overlay.
    useEffect(() => {
        if (beat?.kind === "success" && $success == null) setBeat(null);
        if (beat?.kind === "fail" && $denied == null) setBeat(null);
    }, [$success, $denied, beat]);

    const confetti = useConfetti(28, CONFETTI_COLORS);

    if (!beat || typeof document === "undefined") return null;

    const isHider = $role === "hider";
    const success = beat.kind === "success";

    const dismiss = () => {
        if (beat.kind === "fail" && endgameDeniedAt.get() === beat.at) {
            endgameDeniedAt.set(null);
            endgameDeniedReason.set(null);
        }
        if (beat.kind === "success" && endgameSuccessAt.get() === beat.at)
            endgameSuccessAt.set(null);
        setBeat(null);
    };

    // v970: a denial can be "right zone but still ON TRANSIT" (rulebook p75
    // — the endgame begins only once the seekers are off transit).
    const transitDenied = !success && $deniedReason === "transit";
    const eyebrow = success
        ? "Endgame started"
        : transitDenied
          ? "Still on transit"
          : "Wrong zone";
    const headline = success
        ? isHider
            ? "THE ENDGAME BEGINS"
            : "YOU'RE IN THE ENDGAME"
        : transitDenied
          ? isHider
              ? "THEY'RE STILL RIDING"
              : "GET OFF TRANSIT FIRST"
          : isHider
            ? "ENDGAME ATTEMPTED"
            : "NOT THE RIGHT ZONE";
    const body = success
        ? isHider
            ? "The seekers reached your zone and the endgame has started. Lock down your final spot — you can't move now."
            : "You've reached the hider's zone — the endgame is on. Get off transit and search on foot to find them."
        : transitDenied
          ? isHider
              ? "The seekers reached your zone but are still on transit — the endgame hasn't started. Stay ready."
              : "You're at the zone, but the endgame only begins once you're off transit. Disembark and declare again."
          : isHider
            ? "The seekers guessed the wrong zone. Nothing's locked in — stay hidden and keep your lead."
            : "The hider isn't in this zone. Nothing's locked in — keep searching and try again once you're in the right place.";

    const overlay = (
        <div
            className={cn(
                "pointer-events-auto fixed inset-0 z-[1075]",
                "flex items-center justify-center px-6",
                "backdrop-blur-sm animate-in fade-in duration-200",
                success ? "bg-background/90" : "bg-background/85",
            )}
            role="dialog"
            aria-modal="true"
            aria-live="assertive"
            onClick={dismiss}
        >
            {/* Confetti burst — success only. */}
            {success && (
                <div
                    className="pointer-events-none absolute inset-0 overflow-hidden"
                    aria-hidden="true"
                >
                    {confetti.map((p, i) => (
                        <span
                            key={i}
                            className="absolute block h-2.5 w-2.5 rounded-[2px]"
                            style={
                                {
                                    left: p.left,
                                    top: p.top,
                                    background: p.color,
                                    animation: `jlConfettiPop 1100ms ease-out ${p.delay} both`,
                                    "--dx": p.dx,
                                    "--dy": p.dy,
                                    "--rot": p.rot,
                                } as CSSProperties
                            }
                        />
                    ))}
                </div>
            )}

            <div
                className={cn(
                    "relative max-w-md w-full text-center",
                    "rounded-2xl border-2 bg-card shadow-2xl px-6 py-8 space-y-4",
                    success
                        ? "border-[hsl(45_93%_50%)]"
                        : "border-destructive",
                )}
                style={{
                    animation: success
                        ? "jlGoExplode 480ms cubic-bezier(0.22,1.2,0.36,1) both"
                        : "jlFizzleShake 520ms ease-in-out both, jlFizzleFlash 620ms ease-out both",
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <span
                    className={cn(
                        "inline-flex items-center justify-center w-16 h-16 rounded-full",
                        success
                            ? "bg-[hsl(45_93%_50%)]/15 text-[hsl(40_90%_45%)]"
                            : "bg-destructive/15 text-destructive",
                    )}
                >
                    {success ? (
                        <Target className="w-8 h-8" strokeWidth={2.25} />
                    ) : (
                        <MapPinOff className="w-8 h-8" strokeWidth={2.25} />
                    )}
                </span>
                <div className="text-[10px] uppercase tracking-[0.2em] font-display font-extrabold text-muted-foreground">
                    {eyebrow}
                </div>
                <div
                    className={cn(
                        "font-display font-black uppercase leading-none",
                        "text-3xl sm:text-4xl",
                        success
                            ? "text-[hsl(40_90%_45%)]"
                            : "text-destructive",
                    )}
                    style={{ letterSpacing: "-0.03em" }}
                >
                    {headline}
                </div>
                <p className="text-sm text-muted-foreground leading-snug pt-1">
                    {body}
                </p>
                {/* v1025: on an ON-TRANSIT denial, the seeker can override —
                    the speed check is a heuristic (it can't tell walking from a
                    slow vehicle), so if they really are off transit they force
                    the claim (server still checks they're at the zone). */}
                {transitDenied && !isHider && (
                    <Button
                        onClick={() => {
                            seekerStartEndgame(
                                pendingEndgameZone.get(),
                                true,
                            );
                            dismiss();
                        }}
                        size="lg"
                        className={cn(
                            "w-full mt-2 gap-2 text-base h-14",
                            "font-display font-extrabold uppercase tracking-[0.02em]",
                        )}
                    >
                        <Target className="w-5 h-5" />
                        I&apos;m off transit — declare anyway
                    </Button>
                )}
                <Button
                    onClick={dismiss}
                    size="lg"
                    variant={success ? "default" : "outline"}
                    className={cn(
                        "w-full mt-2 gap-2 text-base h-14",
                        "font-display font-extrabold uppercase tracking-[0.02em]",
                    )}
                >
                    <Sparkles className="w-5 h-5" />
                    {success ? "Let's go" : "Keep searching"}
                </Button>
            </div>
        </div>
    );

    return createPortal(overlay, document.body);
}

export default EndgameOverlay;
