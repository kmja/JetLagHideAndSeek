import { useStore } from "@nanostores/react";
import {
    Hourglass,
    LogOut,
    PartyPopper,
    Settings2,
    Sparkles,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

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
    roundEndBaseMs,
    roundEndBonusPieces,
    roundEndHiderName,
    setupDialogOpen,
} from "@/lib/gameSetup";
import { timeBonusPieces } from "@/lib/hiderDeck";
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
import { play } from "@/lib/sound";
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
    // v851: the hider's authoritative round result, synced over the wire so
    // a REMOTE seeker device (which can't compute Move credit / late-answer
    // debit / the in-hand bonus) shows the same total + tally. Falls back to
    // the local computation on the hider's own device + all solo play.
    const $syncedBase = useStore(roundEndBaseMs);
    const $syncedPieces = useStore(roundEndBonusPieces);
    // v879: hider name snapshotted at round-end (fixes the leaderboard
    // name-shift after rotation).
    const $roundEndHiderName = useStore(roundEndHiderName);

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

    // This round's hidden time (same formula as the lobby recap / score),
    // split into the BASE clock and the hider's in-hand time-BONUS pieces
    // (rulebook p79 — bonuses add to the hiding time). Split so the bonus can
    // tally UP onto the base after the reveal, like the show. Prefer the
    // synced values (so a remote seeker matches the hider); fall back to the
    // local hand, still intact until the next round resets it.
    const localBaseMs =
        $foundAt != null && $endsAt != null
            ? Math.max(
                  0,
                  Math.max(0, $foundAt - $endsAt) +
                      $credit -
                      effectiveHiddenDebitMs($foundAt),
              )
            : 0;
    const baseMs = $syncedBase !== null ? $syncedBase : localBaseMs;
    // Individual bonus contributions, in minutes — one chip per piece.
    const bonusPieces =
        $syncedPieces !== null
            ? $syncedPieces
            : timeBonusPieces($hand, $gameSize);
    const bonusMs = bonusPieces.reduce((a, b) => a + b, 0) * 60_000;

    // Count the in-hand bonus UP onto the base clock a beat after the dialog
    // opens (the show's tally). `tallyMs` climbs 0 → bonusMs; the big readout
    // shows base + tally. No bonus → no animation.
    const [tallyMs, setTallyMs] = useState(0);
    const rafRef = useRef<number | null>(null);

    // v911: celebratory fanfare once per round-end reveal (found = round
    // over). Guarded so it fires on the visible→true edge only, and rearms
    // when the dialog closes.
    const soundPlayedRef = useRef(false);
    useEffect(() => {
        if (visible && !soundPlayedRef.current) {
            soundPlayedRef.current = true;
            play("roundEnd");
        } else if (!visible) {
            soundPlayedRef.current = false;
        }
    }, [visible]);
    useEffect(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        if (!visible || bonusMs <= 0) {
            setTallyMs(bonusMs > 0 ? 0 : 0);
            return;
        }
        setTallyMs(0);
        const DELAY = 550;
        const DUR = 1500;
        let start: number | null = null;
        const step = (t: number) => {
            if (start === null) start = t;
            const e = t - start - DELAY;
            if (e <= 0) {
                rafRef.current = requestAnimationFrame(step);
                return;
            }
            const p = Math.min(1, e / DUR);
            const eased = 1 - Math.pow(1 - p, 3);
            setTallyMs(bonusMs * eased);
            if (p < 1) rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [visible, bonusMs]);

    if (!visible) return null;

    // Final total (used for ranking); the big readout animates up to it.
    const currentHidingMs = baseMs + bonusMs;
    const displayedMs = baseMs + tallyMs;
    const bonusMinutes = Math.round(bonusMs / 60_000);
    // v879: prefer the name snapshotted at round-end so the just-finished
    // row stays correct even if a rotation has already reassigned roles.
    const currentHiderName =
        $roundEndHiderName?.trim() ||
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

                {/* This round's hidden time — the in-hand bonus tallies UP
                    onto the base clock a beat after the reveal (the show).
                    Each bonus PIECE also pops in as its own chip above the
                    clock, overshooting then floating up and fading. */}
                <div className="space-y-1.5">
                    <div className="text-sm uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground">
                        {currentHiderName} stayed hidden for
                    </div>
                    <div className="flex justify-center">
                        <div className="relative inline-block">
                            <div className="font-inter-tight italic font-black tabular-nums text-5xl leading-none text-foreground">
                                {formatDuration(displayedMs)}
                            </div>
                            {/* Each bonus piece pops in as its own pill — styled
                                like the TIME BONUS card (hourglass + minutes) —
                                stacked just to the RIGHT of the clock (v908). */}
                            {bonusPieces.length > 0 && (
                                <div
                                    className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 flex flex-col gap-1"
                                    aria-hidden="true"
                                >
                                    {bonusPieces.map((min, i) => (
                                        <span
                                            key={i}
                                            className={cn(
                                                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 shadow-lg whitespace-nowrap",
                                                "font-inter-tight font-black tabular-nums text-xs",
                                                "bg-[hsl(var(--accent-yellow))] text-[#1F2F3F]",
                                            )}
                                            style={{
                                                opacity: 0,
                                                animation: `jlBonusChip 1400ms cubic-bezier(0.22, 1, 0.36, 1) ${550 + i * Math.min(360, 1400 / Math.max(1, bonusPieces.length))}ms forwards`,
                                            }}
                                        >
                                            <Hourglass className="w-3 h-3" />+
                                            {min}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    {bonusMinutes > 0 && (
                        <div
                            className={cn(
                                "inline-flex items-center gap-1.5 rounded-full px-3 py-1",
                                "bg-[hsl(var(--accent-yellow))]/15 border border-[hsl(var(--accent-yellow))]/40",
                                "text-xs font-poppins font-bold text-[hsl(var(--accent-yellow))]",
                                "animate-in fade-in slide-in-from-bottom-1 duration-300",
                            )}
                            style={{ animationDelay: "550ms" }}
                        >
                            <Hourglass className="w-3.5 h-3.5" />+{bonusMinutes}{" "}
                            min hand bonus
                        </div>
                    )}
                </div>

                {/* Leaderboard recap (2+ rounds). Show-inspired: a solid
                    placement block (gold / silver / bronze) + the time + the
                    hider's name, ranked longest-first. */}
                {showLeaderboard && (
                    <div className="space-y-2 text-left">
                        <div className="text-sm uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground text-center">
                            Leaderboard
                        </div>
                        <div className="flex flex-col gap-1.5">
                            {board.map((row, idx) => {
                                const rank = idx + 1;
                                const place =
                                    idx === 0
                                        ? {
                                              bg: "hsl(var(--accent-yellow))",
                                              fg: "#1F2F3F",
                                          }
                                        : idx === 1
                                          ? { bg: "#C2C7D0", fg: "#1F2F3F" }
                                          : idx === 2
                                            ? { bg: "#CF8B4B", fg: "#FFFFFF" }
                                            : {
                                                  bg: "hsl(var(--muted))",
                                                  fg: "hsl(var(--muted-foreground))",
                                              };
                                const suffix =
                                    rank === 1
                                        ? "st"
                                        : rank === 2
                                          ? "nd"
                                          : rank === 3
                                            ? "rd"
                                            : "th";
                                return (
                                    <div
                                        key={`${row.roundNumber}-${idx}`}
                                        className={cn(
                                            "flex items-stretch overflow-hidden rounded-md border",
                                            row.current
                                                ? "border-primary"
                                                : "border-border",
                                        )}
                                    >
                                        <div
                                            className="flex items-center justify-center px-2.5 shrink-0"
                                            style={{
                                                background: place.bg,
                                                color: place.fg,
                                            }}
                                        >
                                            <span className="font-inter-tight font-black text-base leading-none">
                                                {rank}
                                                <span className="text-[9px] align-super">
                                                    {suffix}
                                                </span>
                                            </span>
                                        </div>
                                        <div
                                            className={cn(
                                                "flex-1 flex items-center gap-2 px-3 py-2 min-w-0",
                                                row.current
                                                    ? "bg-primary/10"
                                                    : "bg-secondary/40",
                                            )}
                                        >
                                            <span className="font-inter-tight font-black tabular-nums text-lg leading-none">
                                                {formatDuration(row.hidingMs)}
                                            </span>
                                            <span className="ml-auto min-w-0 truncate text-sm font-medium text-muted-foreground">
                                                {row.hiderName}
                                                {row.current && (
                                                    <span className="ml-1 text-[10px] font-poppins font-bold text-primary uppercase tracking-wider">
                                                        now
                                                    </span>
                                                )}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
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
