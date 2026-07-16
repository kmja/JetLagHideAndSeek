import { useStore } from "@nanostores/react";
import { Rocket } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    formatTimeRemaining,
    gameSize,
    gameStartCelebrationAt,
    gameStartOverLobby,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * "GAME READY — we gotta GO, GO, GO!" — a celebration banner that
 * fires the moment the hiding-period clock starts ticking. Shown on
 * every device in the room (seeker AND hider) — kickoff happens in
 * the lobby's Start button (on the host) or via the host's
 * `setupChanged` push (on guests).
 *
 * v813 flourish: the overlay first plays a big 3-2-1 COUNTDOWN, then
 * the GO-GO-GO card EXPLODES into view with a ring of cartoon dust
 * poofs bursting outward behind it. Both beats are driven by the same
 * single trigger (`gameStartCelebrationAt`), so host and guests get the
 * full flourish. The hiding-period clock is already running underneath
 * — the countdown is purely visual (a ~2s head-start on a 30-180 min
 * clock is nothing).
 *
 * Behavior:
 *  - Auto-opened by `GameStartWatcher` when `hidingPeriodEndsAt`
 *    transitions from null → non-null.
 *  - Shows a live MM:SS countdown so the player can see the hider's
 *    head-start ticking while the message is up.
 *  - Single button "Got it — show me the map" clears the celebration.
 *
 * Controlled by `gameStartCelebrationAt` (non-null = visible).
 */
/** Override the celebration atoms to preview the overlay in the
 *  /debug/overlays gallery without touching global state. */
export interface GoGoGoPreview {
    at: number | null;
    endsAt?: number | null;
    gameSize?: ReturnType<typeof gameSize.get>;
}

/** How long each of the 3 / 2 / 1 numbers holds before the next. */
const COUNTDOWN_STEP_MS = 750;

/** v822: how long the overlay's opaque backdrop takes to fade out on
 *  dismiss, uncovering the (already-mounted, loading/loaded) game view
 *  beneath. Keep in sync with the backdrop's transition duration. */
const REVEAL_MS = 520;

export function GoGoGoOverlay({ preview }: { preview?: GoGoGoPreview } = {}) {
    let $at = useStore(gameStartCelebrationAt);
    let $endsAt = useStore(hidingPeriodEndsAt);
    let $gameSize = useStore(gameSize);
    if (preview) {
        $at = preview.at;
        $endsAt = preview.endsAt ?? null;
        if (preview.gameSize) $gameSize = preview.gameSize;
    }

    const [now, setNow] = useState(() => Date.now());
    const running = $at !== null && $endsAt !== null && $endsAt > now;
    useVisibleInterval(() => setNow(Date.now()), 1000, running);

    // Two-phase flourish: countdown (3→2→1) then the GO card. The debug
    // preview jumps straight to the card so the gallery shows the payoff.
    const [phase, setPhase] = useState<"countdown" | "go">(
        preview ? "go" : "countdown",
    );
    const [count, setCount] = useState(3);
    // v822: once the user taps "show me the map", we DON'T unmount instantly.
    // We drop `gameStartOverLobby` (so the game shell mounts + loads beneath
    // this overlay) but keep the overlay up, fading its opaque backdrop out —
    // uncovering the now-loading/loaded map for a smooth reveal instead of a
    // hard cut. `dismissing` drives that fade; the celebration atom is cleared
    // only after the fade completes.
    const [dismissing, setDismissing] = useState(false);
    const dismissTimerRef = useRef<number | null>(null);
    // Guard so we only (re)start the countdown once per distinct trigger,
    // not on every unrelated re-render while the overlay is up.
    const startedForRef = useRef<number | null>(null);

    useEffect(() => {
        if ($at === null) {
            startedForRef.current = null;
            setDismissing(false);
            return;
        }
        if (startedForRef.current === $at) return;
        startedForRef.current = $at;
        setDismissing(false);
        if (preview) {
            setPhase("go");
            return;
        }
        setPhase("countdown");
        setCount(3);
    }, [$at, preview]);

    // Clean up the dismiss timer on unmount.
    useEffect(
        () => () => {
            if (dismissTimerRef.current)
                window.clearTimeout(dismissTimerRef.current);
        },
        [],
    );

    // Drive the countdown ticks; hand off to the GO card at zero.
    useEffect(() => {
        if (phase !== "countdown" || $at === null) return;
        if (count <= 0) {
            setPhase("go");
            return;
        }
        const t = window.setTimeout(
            () => setCount((c) => c - 1),
            COUNTDOWN_STEP_MS,
        );
        return () => window.clearTimeout(t);
    }, [phase, count, $at]);

    if ($at === null) return null;

    const date = new Date($at);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const totalMinutes = HIDING_PERIOD_MINUTES[$gameSize];
    const remainingMs = Math.max(0, ($endsAt ?? 0) - now);
    const inGo = phase === "go";

    const handleDismiss = () => {
        if (dismissing) return;
        // v822: drop `gameStartOverLobby` NOW so the in-game map shell mounts
        // and starts loading BENEATH this overlay (the self-healing gate makes
        // `gameStarted` flip true), but keep the celebration atom set so the
        // overlay stays up as an opaque cover. `dismissing` fades that cover
        // out over REVEAL_MS — uncovering the loaded map for a smooth reveal —
        // then we clear the celebration to unmount. (In `preview` mode there's
        // no real game beneath, so just clear immediately.)
        if (preview) {
            gameStartCelebrationAt.set(null);
            gameStartOverLobby.set(false);
            return;
        }
        gameStartOverLobby.set(false);
        setDismissing(true);
        dismissTimerRef.current = window.setTimeout(() => {
            gameStartCelebrationAt.set(null);
        }, REVEAL_MS);
    };

    // Portal to <body> (v820): pre-game the overlay is mounted INSIDE the
    // pre-game `<div className="fixed inset-0 …">`, which is a
    // position:fixed stacking context at z-index:auto. The lobby
    // (`GameLobbyDialog`, a vaul drawer) portals itself to document.body at
    // z-[1055], so an inline z-[1070] here is TRAPPED below the drawer — the
    // whole pre-game div paints behind it, hiding the countdown/GO card. That
    // was the "Start round does nothing" bug: the flourish rendered, but
    // BEHIND the opaque lobby. Portaling to body puts z-[1070] in the same
    // stacking context as the drawer so it wins.
    const overlay = (
        <div
            className="fixed inset-0 z-[1070] flex items-center justify-center px-6"
            role="dialog"
            aria-modal="true"
            aria-live="assertive"
        >
            {/* Backdrop as its own layer so it can TRANSITION smoothly: it
                starts nearly CLEAR (the lobby reads through, numbers on top)
                and PROGRESSIVELY dims + blurs the lobby as the 3-2-1 counts
                down (v889 — each count steps the target up and the CSS
                transition ramps between them), then deepens fully as the GO
                card explodes — the lobby slowly dissolving behind the flourish
                rather than snapping. On dismiss it fades fully out to reveal
                the game shell mounting beneath. */}
            <div
                className="absolute inset-0 bg-background"
                style={{
                    // v892: more SEVERE dim across the countdown (the lobby
                    // dissolves harder behind each step) then fully at GO.
                    opacity: dismissing
                        ? 0
                        : inGo
                          ? 0.97
                          : // countdown: 3 → already heavy, 2 → most, 1 → nearly opaque
                            count >= 3
                            ? 0.4
                            : count === 2
                              ? 0.66
                              : 0.85,
                    // backdrop-filter blurs the lobby behind this layer; ramp it
                    // up hard in step with the dim.
                    backdropFilter: dismissing
                        ? "blur(0px)"
                        : inGo
                          ? "blur(10px)"
                          : count >= 3
                            ? "blur(3px)"
                            : count === 2
                              ? "blur(6px)"
                              : "blur(9px)",
                    WebkitBackdropFilter: dismissing
                        ? "blur(0px)"
                        : inGo
                          ? "blur(10px)"
                          : count >= 3
                            ? "blur(3px)"
                            : count === 2
                              ? "blur(6px)"
                              : "blur(9px)",
                    transition:
                        "opacity 400ms ease-out, backdrop-filter 400ms ease-out, -webkit-backdrop-filter 400ms ease-out",
                }}
            />
            {dismissing ? null : !inGo ? (
                <div
                    // Keyed on the number so each digit re-runs the punch-in.
                    key={count}
                    className="relative font-display font-black text-primary leading-none select-none tabular-nums"
                    style={{
                        fontSize: "clamp(8rem, 42vw, 16rem)",
                        letterSpacing: "-0.04em",
                        animation: `jlCountPunch ${COUNTDOWN_STEP_MS}ms cubic-bezier(0.22,1,0.36,1) both`,
                    }}
                >
                    {count}
                </div>
            ) : (
            <div className="relative max-w-md w-full">
                {/* Dust-poof burst behind the card. */}
                <DustBurst />
                <div
                    className={cn(
                        "relative text-center",
                        "rounded-md border-2 border-primary bg-card shadow-xl",
                        "px-6 py-8 space-y-4",
                    )}
                    style={{
                        animation:
                            "jlGoExplode 520ms cubic-bezier(0.34,1.56,0.64,1) both",
                    }}
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
            )}
        </div>
    );

    if (typeof document === "undefined") return overlay;
    return createPortal(overlay, document.body);
}

/**
 * A one-shot ring of cartoon dust poofs that balloon outward from the
 * card centre and fade — the "explode out with particles" beat. Layout is
 * deterministic (memoised per mount) so it doesn't reshuffle on re-render;
 * two rings + size/scale variety keep it from looking mechanical.
 */
function DustBurst() {
    const particles = useMemo(() => {
        const N = 26;
        return Array.from({ length: N }, (_, i) => {
            const ring = i % 2; // alternate inner / outer ring
            const angle = (i / N) * Math.PI * 2 + (ring ? 0.16 : 0);
            // v822: bigger throw + bigger puffs so the burst clearly flies
            // OUT past the card edges (the old 140/210px stayed mostly under
            // the card and was easy to miss).
            const dist = ring ? 320 : 220; // px outward
            const size = ring ? 16 + (i % 3) * 8 : 26 + (i % 3) * 12;
            return {
                i,
                dx: Math.cos(angle) * dist,
                dy: Math.sin(angle) * dist,
                size,
                ds: 1.6 + (i % 3) * 0.5,
                // v822: burst AS the card lands (jlGoExplode peaks ~285ms),
                // not before it's even visible — so the poofs read as thrown
                // outward by the card's impact. Slight per-ring stagger.
                delay: 160 + (ring ? 60 : 0),
                // Every few puffs pick up the brand red; the rest are dust.
                brand: i % 4 === 0,
            };
        });
    }, []);

    return (
        <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-visible"
            aria-hidden
        >
            {particles.map((p) => (
                <span
                    key={p.i}
                    className={cn(
                        "absolute rounded-full",
                        p.brand ? "bg-primary/70" : "bg-foreground/25",
                    )}
                    style={
                        {
                            width: p.size,
                            height: p.size,
                            filter: "blur(0.5px)",
                            // Custom props consumed by the jlDustPoof keyframe.
                            "--dx": `${p.dx}px`,
                            "--dy": `${p.dy}px`,
                            "--ds": String(p.ds),
                            animation: `jlDustPoof 950ms cubic-bezier(0.22,1,0.36,1) ${p.delay}ms both`,
                        } as CSSProperties
                    }
                />
            ))}
        </div>
    );
}

export default GoGoGoOverlay;
