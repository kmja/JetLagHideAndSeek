import { useStore } from "@nanostores/react";
import { Crown, LogOut, PartyPopper, Settings2, Sparkles } from "lucide-react";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { appConfirm } from "@/lib/confirm";
import {
    effectiveHiddenDebitMs,
    endOfRoundDialogOpen,
    gamePausedForLocationAt,
    gameSize,
    hiddenCreditMs,
    hiddenDebitMs,
    hidingPeriodEndsAt,
    setupDialogOpen,
} from "@/lib/gameSetup";
import { tallyTimeBonusMinutes } from "@/lib/hiderDeck";
import { hiderHand, roundFoundAt, roundLog } from "@/lib/hiderRole";
import {
    currentGameCode,
    displayName as displayNameAtom,
    multiplayerEnabled,
    participants,
} from "@/lib/multiplayer/session";
import { seekerRotateHider } from "@/lib/multiplayer/store";
import {
    returnToLandingPage,
    startNewRound,
} from "@/lib/roundActions";
import { cn } from "@/lib/utils";

import { RotateHiderDialog } from "./multiplayer/RotateHiderDialog";

/**
 * Celebratory end-of-round moment (v631). Auto-opens on BOTH the seeker
 * and the hider the instant `roundFoundAt` flips null→number (each side
 * watches the same atom — the seeker sets it on "mark found", the hider
 * receives it via the `ended` broadcast). Shows a confetti burst, the
 * round's hidden time, a leaderboard recap once more than one round has
 * been played, and the three round-lifecycle actions: New round (with
 * hider rotation in multiplayer), Tweak settings, or Leave.
 *
 * The older lobby recap (`RoundEndSection`) + hider `FinalScoreBanner`
 * stay as the persistent, re-openable surfaces; this is the front-and-
 * centre beat.
 */

const CONFETTI_COLORS = [
    "#DC3D38", // brand red
    "#F5C842", // yellow
    "#F19748", // orange
    "#3B82F6", // blue
    "#22C55E", // green
    "#A855F7", // purple
    "#FFFFFF",
];

function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return hh > 0
        ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
        : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function EndOfRoundDialog() {
    const $open = useStore(endOfRoundDialogOpen);
    const $foundAt = useStore(roundFoundAt);
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $log = useStore(roundLog);
    const $participants = useStore(participants);
    const $mp = useStore(multiplayerEnabled);
    const $code = useStore(currentGameCode);
    // Scoring inputs (subscribe so the time is correct once banked).
    const $credit = useStore(hiddenCreditMs);
    useStore(hiddenDebitMs);
    useStore(gamePausedForLocationAt);
    const $hand = useStore(hiderHand);
    const $gameSize = useStore(gameSize);

    const [rotateOpen, setRotateOpen] = useState(false);

    // Open state is set at the round-end source points (seeker's
    // "mark found" + the hider's inbound `ended` broadcast) and cleared by
    // the round-lifecycle actions — so this can stay lazy-loaded without a
    // watcher racing the transition.
    const visible = $open && $foundAt !== null && $endsAt !== null;

    // Confetti pieces — recomputed each time the dialog becomes visible.
    const confetti = useMemo(() => {
        if (!visible) return [];
        return Array.from({ length: 60 }, (_, i) => {
            const angle = Math.random() * Math.PI * 2;
            const dist = 160 + Math.random() * 260;
            return {
                dx: Math.cos(angle) * dist,
                dy: Math.sin(angle) * dist - 80,
                rot: (Math.random() - 0.5) * 1080,
                color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
                delay: Math.random() * 0.3,
            };
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    if (!visible) return null;

    const foundAt = $foundAt as number;
    const endsAt = $endsAt as number;

    // This round's hidden time (same formula as the lobby recap / score),
    // PLUS the hider's time-bonus cards (rulebook p79 — bonuses add to the
    // hiding time). Read from the local hand, still intact until the next
    // round resets it; on the hider's own device + solo this matches the
    // persisted roundLog entry startNewRound appends.
    const currentHidingMs =
        Math.max(
            0,
            Math.max(0, foundAt - endsAt) +
                $credit -
                effectiveHiddenDebitMs(foundAt),
        ) +
        tallyTimeBonusMinutes($hand, $gameSize) * 60_000;
    const currentHiderName =
        $participants.find((p) => p.role === "hider")?.displayName?.trim() ||
        displayNameAtom.get()?.trim() ||
        "Hider";
    const currentRoundNumber = $log.length + 1;

    // Combined leaderboard: past rounds (roundLog) + the just-finished
    // round (not yet appended — startNewRound does that), ranked by hidden
    // time (longest hide wins). Only shown once there's more than one round.
    const board = [
        ...$log.map((r) => ({
            roundNumber: r.roundNumber,
            hiderName: r.hiderName,
            hidingMs: r.hidingMs,
            current: false,
        })),
        {
            roundNumber: currentRoundNumber,
            hiderName: currentHiderName,
            hidingMs: currentHidingMs,
            current: true,
        },
    ].sort((a, b) => b.hidingMs - a.hidingMs);
    const showLeaderboard = board.length > 1;

    // "Hider found!" — or "Hiders found!" when the hide team has more than
    // one member. Solo / non-multiplayer has an empty participant list, so
    // default to a single hider.
    const hiderCount = Math.max(
        1,
        $participants.filter((p) => p.role === "hider").length,
    );
    const roleTitle = hiderCount > 1 ? "Hiders found!" : "Hider found!";

    const canRotateHider = $mp && $code !== null && $participants.length >= 2;

    const close = () => endOfRoundDialogOpen.set(false);

    const handleNewRound = async () => {
        if (canRotateHider) {
            setRotateOpen(true);
            return;
        }
        const ok = await appConfirm({
            title: "Start a new round?",
            description:
                "Question log, hider hand, hiding zone and spot all reset. Play area, transit, and size stay the same.",
            confirmLabel: "New round",
        });
        if (!ok) return;
        startNewRound();
        close();
    };

    const handleConfirmRotation = (
        primaryHiderId: string,
        coHiderIds: string[],
    ) => {
        seekerRotateHider(primaryHiderId, coHiderIds);
        startNewRound();
        setRotateOpen(false);
        close();
    };

    const handleSettings = () => {
        // Open the setup editor; leave the round result intact so the
        // player can adjust play area / transit / size before continuing.
        close();
        setupDialogOpen.set(true);
    };

    const handleLeave = async () => {
        const ok = await appConfirm({
            title: "Leave this game?",
            description:
                "Disconnects from the room and returns you to the start screen.",
            confirmLabel: "Leave",
            destructive: true,
        });
        if (!ok) return;
        returnToLandingPage();
    };

    return (
        <div
            className={cn(
                "fixed inset-0 z-[1072]",
                "flex items-center justify-center px-5 py-8",
                "bg-background/90 backdrop-blur-sm overflow-y-auto",
            )}
            role="dialog"
            aria-modal="true"
            aria-live="assertive"
        >
            {/* Confetti burst, anchored to viewport centre. */}
            <div
                className="pointer-events-none fixed inset-0 z-[1] flex items-center justify-center overflow-visible"
                aria-hidden="true"
            >
                {confetti.map((p, i) => (
                    <span
                        key={i}
                        className="absolute w-2 h-3 rounded-sm"
                        style={
                            {
                                background: p.color,
                                animation: `jlConfettiPop 1.7s cubic-bezier(0.16, 1, 0.3, 1) ${p.delay}s forwards`,
                                "--dx": `${p.dx}px`,
                                "--dy": `${p.dy}px`,
                                "--rot": `${p.rot}deg`,
                            } as CSSProperties
                        }
                    />
                ))}
            </div>

            <div
                className={cn(
                    "relative z-[2] w-full max-w-md my-auto",
                    "rounded-2xl border-2 border-primary bg-card shadow-2xl",
                    "px-6 py-7 space-y-5 text-center",
                    "animate-in fade-in zoom-in-95 duration-300",
                )}
            >
                <div className="flex flex-col items-center gap-2">
                    <span className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/15">
                        <PartyPopper className="w-7 h-7 text-primary" />
                    </span>
                    <div className="text-sm uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground">
                        Round {currentRoundNumber} · Complete
                    </div>
                    <h2
                        className="font-display font-black uppercase text-3xl sm:text-4xl leading-none"
                        style={{ letterSpacing: "-0.02em" }}
                    >
                        {roleTitle}
                    </h2>
                </div>

                {/* This round's hidden time. */}
                <div className="space-y-1">
                    <div className="text-sm uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground">
                        {currentHiderName} stayed hidden for
                    </div>
                    <div className="font-inter-tight italic font-black tabular-nums text-5xl leading-none text-foreground">
                        {formatDuration(currentHidingMs)}
                    </div>
                </div>

                {/* Leaderboard recap (2+ rounds). */}
                {showLeaderboard && (
                    <div className="space-y-1.5 text-left">
                        <div className="text-sm uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground text-center">
                            Leaderboard
                        </div>
                        <div className="rounded-lg border border-border overflow-hidden">
                            {board.map((row, idx) => (
                                <div
                                    key={`${row.roundNumber}-${idx}`}
                                    className={cn(
                                        "flex items-center gap-2 px-3 py-2 text-sm",
                                        idx > 0 && "border-t border-border",
                                        row.current
                                            ? "bg-primary/10"
                                            : "bg-background/40",
                                    )}
                                >
                                    <span className="w-5 shrink-0 text-center">
                                        {idx === 0 ? (
                                            <Crown className="w-4 h-4 text-[hsl(var(--accent-yellow))] inline" />
                                        ) : (
                                            <span className="text-xs font-mono text-muted-foreground">
                                                {idx + 1}
                                            </span>
                                        )}
                                    </span>
                                    <span className="flex-1 min-w-0 truncate font-inter-tight font-bold">
                                        {row.hiderName}
                                        {row.current && (
                                            <span className="ml-1.5 text-[10px] font-poppins font-semibold text-primary uppercase tracking-wider">
                                                this round
                                            </span>
                                        )}
                                    </span>
                                    <span className="shrink-0 tabular-nums font-inter-tight font-black text-muted-foreground">
                                        {formatDuration(row.hidingMs)}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <p className="text-xs text-muted-foreground text-center pt-0.5">
                            Ranked by time hidden — longest hide wins.
                        </p>
                    </div>
                )}

                {/* Actions. */}
                <div className="space-y-2 pt-1">
                    <Button
                        onClick={handleNewRound}
                        size="lg"
                        className="w-full gap-2 h-12 font-display font-extrabold uppercase tracking-[0.02em]"
                    >
                        <Sparkles className="w-5 h-5" />
                        New round
                    </Button>
                    <div className="grid grid-cols-2 gap-2">
                        <Button
                            variant="outline"
                            onClick={handleSettings}
                            className="gap-1.5"
                        >
                            <Settings2 className="w-4 h-4" />
                            Edit settings
                        </Button>
                        <Button
                            variant="outline"
                            onClick={handleLeave}
                            className="gap-1.5"
                        >
                            <LogOut className="w-4 h-4" />
                            Leave game
                        </Button>
                    </div>
                    <button
                        type="button"
                        onClick={close}
                        className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors pt-1"
                    >
                        Dismiss — stay on the map
                    </button>
                </div>
            </div>

            <RotateHiderDialog
                open={rotateOpen}
                onOpenChange={setRotateOpen}
                onConfirm={handleConfirmRotation}
            />
        </div>
    );
}

export default EndOfRoundDialog;
