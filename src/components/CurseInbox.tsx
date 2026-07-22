import { useStore } from "@nanostores/react";
import {
    Ban,
    BookOpen,
    Camera,
    Check,
    Hourglass,
    Loader2,
    Train,
    X,
} from "lucide-react";

import { SkullCrossbones } from "@/components/icons/gameIcons";
import { useEffect, useRef, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { pendingOverlayActive, questions, topOverlayTall } from "@/lib/context";
import {
    CURSE_DRAINED_BRAIN,
    CURSE_JAMMED_DOOR,
    CURSE_SPOTTY_MEMORY,
    CURSE_URBAN_EXPLORER,
    activeBlockingCurse,
    activeBlockingCurseCastAt,
    seekerOnTransit,
    spottyCategoryForRoll,
    spottyMemoryCategory,
} from "@/lib/curseEnforcement";
import {
    curseDiceCount,
    curseDurationMs,
    curseRequiresDice,
    formatCurseCountdown,
    jammedDoorCooldownMs,
} from "@/lib/curseMeta";
import { gameSize } from "@/lib/gameSetup";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { curseNeedsSeekerProof } from "@/lib/castingCost";
import { curseBonusFor, curseBonusResolved } from "@/lib/curseBonus";
import { playerRole } from "@/lib/hiderRole";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import { preparePhotoForSend } from "@/lib/photo";
import { openRulebookAt, RULEBOOK_ANCHORS } from "@/lib/rulebook";
import {
    reportCurseFail,
    sendCurseCleared,
    sendCurseProof,
    sendHangmanBegin,
    sendHangmanContinue,
    sendHangmanGuess,
    sendHangmanReveal,
    sendHangmanWord,
    startCurseCooldown,
} from "@/lib/multiplayer/store";
import { CURSE_HIDDEN_HANGMAN } from "@/lib/castingConstraint";
import {
    curseCooldownUntil,
    type HangmanState,
    hangmanGames,
    type ReceivedCurse,
    receivedCurses,
} from "@/lib/seekerInbound";
import { cn } from "@/lib/utils";
import type { WritableAtom } from "nanostores";
import { toast } from "react-toastify";

import { renderBodyText } from "./CardTile";
import { DiceRoller } from "./DiceRoller";
import { FilmViewfinder } from "./FilmViewfinder";
import { SectionPill } from "./JetLagLogo";
import { ZonePreviewMap } from "./ZonePreviewMap";

/**
 * App-enforced curses that last "for the rest of your run" — the seeker
 * can't manually clear them (that would just drop the enforcement); they
 * lift at round end when `receivedCurses` is wiped.
 */
const ENFORCED_REST_OF_RUN = new Set<string>([
    CURSE_DRAINED_BRAIN,
    CURSE_SPOTTY_MEMORY,
    CURSE_URBAN_EXPLORER,
]);

/** mm:ss (or h:mm:ss) from a whole-second film-duration target. */
function formatFilmTarget(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Two-part curse UI for the seeker:
 *
 * 1. Notification banners (unacknowledged) — full card with curse text.
 *    Tapping the card opens the dice dialog; "I understand" acknowledges.
 *
 * 2. Compact active-curse pill (acknowledged, not dismissed) — stays on
 *    the map so the seeker can roll dice at any time while under the curse.
 *    "Curse expired" removes it.
 *
 * The dice dialog is shared between both entry points.
 */
/**
 * @param source - which curse atom to render. Defaults to the seeker's
 *   `receivedCurses`; the HIDER passes `castCurses` (v946) to see the active
 *   curses they've cast rendered EXACTLY like the seeker's inbox — same pills,
 *   cards, dice, and countdowns (the "reuse the whole code" ask). Both atoms
 *   share the `ReceivedCurse[]` shape, so the whole component works unchanged.
 */
export function CurseInbox({
    source = receivedCurses,
}: {
    source?: WritableAtom<ReceivedCurse[]>;
} = {}) {
    const $curses = useStore(source);
    const $gameSize = useStore(gameSize);
    const $bonusResolved = useStore(curseBonusResolved);
    const $onTransit = useStore(seekerOnTransit);
    const $spottyCategory = useStore(spottyMemoryCategory);
    const $questions = useStore(questions);
    // When the top-center question overlay (pending / answered card, or the
    // thermometer tracker) is showing, push the top-right curse pills down
    // so the two don't overlap.
    const $pendingOverlay = useStore(pendingOverlayActive);
    const $tallOverlay = useStore(topOverlayTall);
    const [dialogCurse, setDialogCurse] = useState<ReceivedCurse | null>(null);
    // v1032: Jammed Door doorway cooldown — Unix ms until the seekers may
    // re-roll a failed doorway (5 min S / 10 min M / 15 min L, rulebook p396).
    // v1093: SERVER-SHARED + persisted (keyed by the curse's castId), so the
    // wait is shared across the seek team and can't be reset by restarting the
    // app.
    const $cooldowns = useStore(curseCooldownUntil);
    // v1096: server-adjudicated Hidden Hangman game states, keyed by castId.
    const $hangman = useStore(hangmanGames);
    // v1041: Curse of the Bird Guide — the seekers must film a bird for at least
    // the hider's time before clearing. Holds the seconds they've filmed in the
    // in-dialog viewfinder; the Clear button is gated on it meeting the target.
    const [birdFilmedSecs, setBirdFilmedSecs] = useState<number | null>(null);
    // v1079: the seekers' verification-photo capture for Curse of the Unguided
    // Tourist ("send a picture to the hider"). `proofSentAt` = the receivedAt of
    // the curse we've sent proof for this session (the synced `seekerProofUrl`
    // is the durable signal once the hider echo lands).
    const proofInputRef = useRef<HTMLInputElement | null>(null);
    const [proofBusy, setProofBusy] = useState(false);
    const [proofSentAt, setProofSentAt] = useState<number | null>(null);

    const unack = $curses.filter((c) => !c.acknowledged);
    const active = $curses.filter((c) => c.acknowledged && !c.dismissed);

    // Spotty Memory re-rolls each question: the disabled category holds
    // until the seekers ask their next question, then they must roll
    // again. Detect a new question by watching the seeker question count
    // and clear the rolled category so the curse card forces a fresh roll.
    const spottyActive = $curses.some(
        (c) => !c.dismissed && c.name === CURSE_SPOTTY_MEMORY,
    );
    const prevQCountRef = useRef($questions.length);
    useEffect(() => {
        const grew = $questions.length > prevQCountRef.current;
        prevQCountRef.current = $questions.length;
        if (grew && spottyActive && spottyMemoryCategory.get() != null) {
            spottyMemoryCategory.set(null);
        }
    }, [$questions.length, spottyActive]);

    // When Spotty Memory clears entirely, drop any lingering rolled
    // category so it doesn't leak into a later curse.
    useEffect(() => {
        if (!spottyActive && spottyMemoryCategory.get() != null) {
            spottyMemoryCategory.set(null);
        }
    }, [spottyActive]);

    // Reset the Bird Guide filmed-time whenever the open dialog changes.
    useEffect(() => {
        setBirdFilmedSecs(null);
    }, [dialogCurse?.receivedAt]);

    // Per-curse derived metadata (memo-free; cheap string ops).
    const meta = (c: ReceivedCurse) => {
        const durationMs = curseDurationMs(c, $gameSize);
        return {
            requiresDice: curseRequiresDice(c),
            durationMs,
            expiresAt: durationMs != null ? c.receivedAt + durationMs : null,
        };
    };

    // 1 Hz tick to drive the countdowns + auto-clear. Only ticks while
    // there's a live timed curse to watch (visibility-aware).
    const anyTimed = $curses.some(
        (c) => !c.dismissed && meta(c).expiresAt != null,
    );
    // Also tick while any Jammed Door doorway cooldown OR a Hidden Hangman loss
    // cooldown is counting down.
    const nowMs = Date.now();
    const jammedCoolingDown = Object.values($cooldowns).some(
        (until) => until > nowMs,
    );
    const hangmanCoolingDown = Object.values($hangman).some(
        (h) =>
            h.status === "lost" &&
            h.cooldownUntil != null &&
            h.cooldownUntil > nowMs,
    );
    const now = useNow(anyTimed || jammedCoolingDown || hangmanCoolingDown);

    // Auto-clear time-limited curses the moment their timer runs out — a
    // duration curse ("for the next N minutes") shouldn't linger needing a
    // manual dismiss. Marks them dismissed (same as the manual clear).
    useEffect(() => {
        const expired = $curses.filter((c) => {
            if (c.dismissed) return false;
            const e = meta(c).expiresAt;
            return e != null && now >= e;
        });
        if (expired.length === 0) return;
        const ids = new Set(expired.map((c) => c.receivedAt));
        source.set(
            source
                .get()
                .map((c) =>
                    ids.has(c.receivedAt)
                        ? { ...c, acknowledged: true, dismissed: true }
                        : c,
                ),
        );
        // v1022: propagate the clear so the hide team + other seekers drop it
        // (seeker-side only — the hider's mirror is informational).
        if (playerRole.get() === "seeker") {
            for (const c of expired) sendCurseCleared(c.castId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [now, $curses, $gameSize]);

    if (unack.length === 0 && active.length === 0) return null;

    const acknowledge = (receivedAt: number) => {
        source.set(
            source
                .get()
                .map((c) =>
                    c.receivedAt === receivedAt
                        ? { ...c, acknowledged: true }
                        : c,
                ),
        );
    };

    const dismiss = (receivedAt: number) => {
        const target = source.get().find((c) => c.receivedAt === receivedAt);
        source.set(
            source
                .get()
                .map((c) =>
                    c.receivedAt === receivedAt
                        ? { ...c, dismissed: true }
                        : c,
                ),
        );
        // v1022: propagate the clear to the hide team + other seekers.
        if (playerRole.get() === "seeker") sendCurseCleared(target?.castId);
        // v1100: if the HIDER clears the active one-at-a-time blocker from their
        // own active-curse card, lift the blocker so they can cast the next one.
        if (target?.name && activeBlockingCurse.get() === target.name) {
            activeBlockingCurse.set(null);
            activeBlockingCurseCastAt.set(null);
        }
        setDialogCurse(null);
    };

    // Keep dialog in sync with the live atom (e.g. acknowledged state may
    // change while the dialog is open).
    const resolvedDialog = dialogCurse
        ? ($curses.find((c) => c.receivedAt === dialogCurse.receivedAt) ?? null)
        : null;
    const dlgMeta = resolvedDialog ? meta(resolvedDialog) : null;

    // The Bird Guide's film requirement (target seconds) for the open curse.
    const birdTarget = resolvedDialog?.filmSeconds ?? null;
    const birdBlocksClear =
        birdTarget != null &&
        (birdFilmedSecs == null || birdFilmedSecs < birdTarget);

    // v1079: Curse of the Unguided Tourist — the SEEKERS must send the hider a
    // verification photo before clearing. Only in multiplayer (a real hider to
    // send to) + on the seeker side.
    const isSeekerView = playerRole.get() === "seeker";
    const needsProof =
        resolvedDialog != null &&
        isSeekerView &&
        multiplayerEnabled.get() &&
        curseNeedsSeekerProof(resolvedDialog);
    const proofSent =
        resolvedDialog?.seekerProofUrl != null ||
        (resolvedDialog != null && proofSentAt === resolvedDialog.receivedAt);
    const proofBlocksClear = needsProof && !proofSent;

    const handleProofFile = async (file: File) => {
        if (!resolvedDialog) return;
        setProofBusy(true);
        try {
            const prepared = await preparePhotoForSend(
                file,
                multiplayerEnabled.get(),
            );
            if (prepared.photoUrl) {
                sendCurseProof(resolvedDialog.castId, prepared.photoUrl);
                setProofSentAt(resolvedDialog.receivedAt);
                toast.success("Verification photo sent to the hider.");
            } else {
                toast.error("Couldn't upload the photo — try again.");
            }
        } catch {
            toast.error("Couldn't send the photo.");
        } finally {
            setProofBusy(false);
        }
    };

    return (
        <>
            {/* ── Active curses — top-right stack of purple pills, like
                the Jet Lag show. Each pill is its own curse (no longer
                collapsed into a count); tapping opens the dice dialog.
                Shown independently of any pending notification banner. */}
            {active.length > 0 && (
                <div
                    className={cn(
                        "fixed right-2 md:right-4 z-[1042]",
                        // v622: the top-right cluster (map-options chip +
                        // trip launcher) is gone, so the pills only need to
                        // clear the mobile top bar now — snug under it,
                        // near the top edge on desktop (no header there).
                        // v623: when the top-center question overlay is up,
                        // drop the pills below it so they don't overlap.
                        "transition-[top] duration-300 ease-out",
                        // v946: the thermometer tracker is much taller than the
                        // pending-answer card, so clear it with a bigger dodge.
                        $tallOverlay
                            ? "top-[calc(env(safe-area-inset-top)_+_310px)] md:top-[300px]"
                            : $pendingOverlay
                              ? "top-[calc(env(safe-area-inset-top)_+_150px)] md:top-[104px]"
                              : "top-[calc(env(safe-area-inset-top)_+_62px)] md:top-3",
                        "flex flex-col items-end gap-2",
                    )}
                    role="status"
                    aria-live="polite"
                >
                    {active.map((curse) => {
                        const m = meta(curse);
                        const remaining =
                            m.expiresAt != null
                                ? formatCurseCountdown(m.expiresAt - now)
                                : null;
                        return (
                            <button
                                key={curse.receivedAt}
                                type="button"
                                onClick={() => setDialogCurse(curse)}
                                aria-label={`Active curse: ${curse.name}. Tap for details.`}
                                title={`${curse.name} — tap for details`}
                                className={cn(
                                    "flex items-center gap-2.5 max-w-[220px]",
                                    "rounded-lg pl-3 pr-2.5 py-2 shadow-lg",
                                    "bg-[#5b4f96] hover:bg-[#6a5dab] transition-colors",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                                )}
                            >
                                <span className="min-w-0 flex flex-col text-left">
                                    <span className="min-w-0 font-inter-tight font-black uppercase tracking-tight text-xs leading-tight text-white truncate">
                                        {curse.name}
                                    </span>
                                    {remaining && (
                                        <span className="text-[10px] tabular-nums text-white/75 leading-none mt-0.5">
                                            {remaining} left
                                        </span>
                                    )}
                                </span>
                                <SkullCrossbones
                                    className="w-5 h-5 text-white shrink-0"
                                    strokeWidth={2.25}
                                />
                            </button>
                        );
                    })}
                </div>
            )}

            <div
                className={cn(
                    "fixed inset-x-2 z-[1042]",
                    "bottom-[calc(80px+env(safe-area-inset-bottom))] md:bottom-4",
                    "max-w-md mx-auto",
                )}
                role="alert"
                aria-live="assertive"
            >
                {/* ── Unacknowledged notification banners ── */}
                {unack.map((curse, idx) => (
                    <button
                        key={curse.receivedAt}
                        type="button"
                        onClick={() => setDialogCurse(curse)}
                        className={cn(
                            "w-full text-left",
                            "rounded-md border-2 border-purple-500/60 bg-background/95 backdrop-blur-md shadow-xl",
                            "p-3 mb-2",
                            "hover:border-purple-400 transition-colors",
                            idx > 0 && "scale-[0.98] -mt-1",
                        )}
                    >
                        <div className="flex items-start gap-2.5">
                            <span
                                className="inline-flex items-center justify-center w-8 h-8 rounded-sm shrink-0"
                                style={{ background: "rgb(126 34 206)" }}
                                aria-hidden="true"
                            >
                                <SkullCrossbones
                                    className="w-4 h-4 text-white"
                                    strokeWidth={2.5}
                                />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    <SectionPill className="bg-purple-500/15 text-purple-300">
                                        Curse received
                                    </SectionPill>
                                </div>
                                <div className="font-inter-tight font-black uppercase tracking-tight text-sm leading-tight">
                                    {curse.name}
                                </div>
                                <p className="text-xs text-foreground/80 mt-1 leading-snug">
                                    {renderBodyText(curse.description, $gameSize)}
                                </p>
                                {curse.photoUrl && (
                                    <img
                                        src={curse.photoUrl}
                                        alt={`${curse.name} proof photo`}
                                        className="mt-2 w-full max-h-40 rounded-md object-contain bg-black/20 border border-purple-500/30"
                                    />
                                )}
                                {curse.filmSeconds != null && (
                                    <p className="text-[11px] text-purple-300 mt-1 leading-snug font-semibold tabular-nums">
                                        Film a bird for at least{" "}
                                        {formatFilmTarget(curse.filmSeconds)}.
                                    </p>
                                )}
                                {curse.rockCount != null && (
                                    <p className="text-[11px] text-purple-300 mt-1 leading-snug font-semibold tabular-nums">
                                        Build a rock tower {curse.rockCount}{" "}
                                        rock{curse.rockCount === 1 ? "" : "s"}{" "}
                                        high.
                                    </p>
                                )}
                                {curse.travelDestination && (
                                    <p className="text-[11px] text-purple-300 mt-1 leading-snug font-semibold">
                                        Destination: {curse.travelDestination}
                                    </p>
                                )}
                                {/* Casting cost is the hider's concern, not
                                    the seeker's — omitted. Timed curses show
                                    a live "clears in" countdown instead. */}
                                {(() => {
                                    const e = meta(curse).expiresAt;
                                    if (e == null) return null;
                                    return (
                                        <p className="text-[11px] text-purple-300 mt-1 leading-snug inline-flex items-center gap-1 tabular-nums">
                                            <Hourglass className="w-3 h-3" />
                                            Clears in{" "}
                                            {formatCurseCountdown(e - now)}
                                        </p>
                                    );
                                })()}
                            </div>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    acknowledge(curse.receivedAt);
                                }}
                                aria-label="Dismiss notification"
                                className={cn(
                                    "shrink-0 w-6 h-6 flex items-center justify-center",
                                    "rounded-md text-muted-foreground",
                                    "hover:bg-accent hover:text-foreground transition-colors",
                                )}
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        <div className="flex items-center justify-between mt-2 gap-2">
                            <span className="text-[11px] text-purple-400/70 italic">
                                {meta(curse).requiresDice
                                    ? "Tap card to roll dice"
                                    : "Tap card for details"}
                            </span>
                            <Button
                                type="button"
                                size="sm"
                                variant="default"
                                className="gap-1.5 h-7 px-2.5 text-[11px]"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    acknowledge(curse.receivedAt);
                                }}
                            >
                                <Check className="w-3 h-3" />
                                I understand
                            </Button>
                        </div>
                    </button>
                ))}
            </div>

            {/* ── Dice dialog (shared between banners and compact pill) ── */}
            <Dialog
                open={resolvedDialog !== null}
                onOpenChange={(open) => {
                    if (!open) setDialogCurse(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <div className="flex items-center justify-between gap-2 pr-6">
                            <DialogTitle className="flex items-center gap-2 min-w-0">
                                <SkullCrossbones className="w-4 h-4 text-purple-400 shrink-0" />
                                <span className="truncate">
                                    {resolvedDialog?.name}
                                </span>
                            </DialogTitle>
                            <button
                                type="button"
                                onClick={() =>
                                    openRulebookAt(RULEBOOK_ANCHORS.curses)
                                }
                                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground shrink-0"
                                title="Read the rulebook on curses"
                            >
                                <BookOpen className="w-3.5 h-3.5" />
                                Rules
                            </button>
                        </div>
                    </DialogHeader>

                    {/* Curse description (no casting cost — that's the
                        hider's concern). Timed curses show a live "clears
                        in" countdown. Hidden Hangman hides it (v1099): the
                        board is self-explanatory + the "Rules" link covers it,
                        and the long text crowded the game out. */}
                    <div className="space-y-1.5">
                        {resolvedDialog &&
                        resolvedDialog.name !== CURSE_HIDDEN_HANGMAN ? (
                            <p className="text-sm text-foreground/80 leading-snug">
                                {renderBodyText(
                                    resolvedDialog.description,
                                    $gameSize,
                                )}
                            </p>
                        ) : null}
                        {resolvedDialog?.photoUrl && (
                            <img
                                src={resolvedDialog.photoUrl}
                                alt={`${resolvedDialog.name} proof photo`}
                                className="w-full max-h-60 rounded-md object-contain bg-black/20 border border-purple-500/30"
                            />
                        )}
                        {resolvedDialog?.filmSeconds != null && (
                            <div className="space-y-2">
                                <p className="text-sm text-purple-300 font-semibold tabular-nums">
                                    Film a bird for at least{" "}
                                    {formatFilmTarget(resolvedDialog.filmSeconds)}{" "}
                                    before asking your next question.
                                </p>
                                {/* v1041: the seekers film with the SAME
                                    viewfinder + timer the hider used to cast —
                                    the Clear button unlocks once they've filmed
                                    long enough. */}
                                <FilmViewfinder
                                    active={resolvedDialog !== null}
                                    targetSeconds={resolvedDialog.filmSeconds}
                                    onElapsed={setBirdFilmedSecs}
                                    onReachTarget={() => {
                                        // v1086: the running film reached the
                                        // bar — celebrate + clear immediately,
                                        // no need to stop the timer or tap Clear.
                                        setBirdFilmedSecs(
                                            resolvedDialog.filmSeconds ?? 0,
                                        );
                                        toast.success(
                                            "Bird filmed long enough — curse cleared!",
                                        );
                                        dismiss(resolvedDialog.receivedAt);
                                    }}
                                />
                            </div>
                        )}
                        {resolvedDialog?.rockCount != null && (
                            <p className="text-sm text-purple-300 font-semibold tabular-nums">
                                Build a rock tower {resolvedDialog.rockCount}{" "}
                                rock{resolvedDialog.rockCount === 1 ? "" : "s"}{" "}
                                high before asking your next question.
                            </p>
                        )}
                        {/* v1087: seeker self-reports failing a bonus curse's
                            keep-task (lost souvenir/water/lemon, cracked egg,
                            hit someone) — the hider is awarded the bonus. */}
                        {isSeekerView &&
                            (() => {
                                const bonus = curseBonusFor(
                                    resolvedDialog?.name,
                                );
                                if (!bonus) return null;
                                const cid = resolvedDialog?.castId;
                                const reported =
                                    cid != null &&
                                    $bonusResolved[String(cid)] === "lost";
                                const mins = bonus.minutes[$gameSize];
                                return (
                                    <div className="space-y-1.5 rounded-md border border-purple-500/30 bg-purple-500/5 p-2.5">
                                        {reported ? (
                                            <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-400">
                                                <Check className="h-4 w-4" />
                                                Reported — the hider was awarded
                                                +{mins} min.
                                            </p>
                                        ) : (
                                            <>
                                                <p className="text-xs text-muted-foreground leading-snug">
                                                    If this happens, tell the
                                                    hider — they&apos;re awarded
                                                    +{mins} min.
                                                </p>
                                                <Button
                                                    type="button"
                                                    variant="destructive"
                                                    size="sm"
                                                    onClick={() =>
                                                        reportCurseFail(
                                                            cid,
                                                            resolvedDialog!.name,
                                                        )
                                                    }
                                                >
                                                    {bonus.reportLabel}
                                                </Button>
                                            </>
                                        )}
                                    </div>
                                );
                            })()}
                        {/* v1079: Curse of the Unguided Tourist — the SEEKERS
                            find the sent spot in real life and send the hider a
                            verification photo. The Clear button unlocks once
                            they've sent it. */}
                        {needsProof && (
                            <div className="space-y-2">
                                <p className="text-sm text-purple-300 font-semibold">
                                    Complete the task, then send the hider a
                                    photo to verify — that clears the curse.
                                </p>
                                {proofSent ? (
                                    <div className="flex items-center gap-1.5 text-sm font-semibold text-green-400">
                                        <Check className="h-4 w-4" />
                                        Verification photo sent
                                    </div>
                                ) : (
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        disabled={proofBusy}
                                        onClick={() =>
                                            proofInputRef.current?.click()
                                        }
                                    >
                                        {proofBusy ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Camera className="h-4 w-4" />
                                        )}
                                        Send verification photo
                                    </Button>
                                )}
                                <input
                                    ref={proofInputRef}
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    className="hidden"
                                    onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        if (f) void handleProofFile(f);
                                        e.target.value = "";
                                    }}
                                />
                            </div>
                        )}
                        {/* Hider side: the seekers' received verification photo. */}
                        {resolvedDialog?.seekerProofUrl && !isSeekerView && (
                            <div className="space-y-1">
                                <p className="text-sm text-purple-300 font-semibold">
                                    Seekers&apos; verification photo:
                                </p>
                                <img
                                    src={resolvedDialog.seekerProofUrl}
                                    alt="Seekers' verification photo"
                                    className="w-full max-h-60 rounded-md object-contain bg-black/20 border border-purple-500/30"
                                />
                            </div>
                        )}
                        {resolvedDialog?.travelDestination && (
                            <p className="text-sm text-purple-300 font-semibold">
                                Destination: {resolvedDialog.travelDestination}
                            </p>
                        )}
                        {/* v1029: the Mediocre Travel Agent destination is now a
                            real map pin — show the spot so the seekers know
                            exactly where to go. */}
                        {resolvedDialog?.travelDestLat != null &&
                            resolvedDialog?.travelDestLng != null && (
                                <ZonePreviewMap
                                    lat={resolvedDialog.travelDestLat}
                                    lng={resolvedDialog.travelDestLng}
                                    radiusMeters={120}
                                    padding={40}
                                    className="w-full h-40 mt-1"
                                />
                            )}
                        {/* v1052: the "clears in" countdown lives in the footer
                            only — no need to repeat it here in the description. */}
                    </div>

                    {/* If multiple active curses exist, show the others too */}
                    {active.length > 1 && (
                        <div className="space-y-1">
                            {active
                                .filter(
                                    (c) =>
                                        c.receivedAt !==
                                        resolvedDialog?.receivedAt,
                                )
                                .map((c) => (
                                    <button
                                        key={c.receivedAt}
                                        type="button"
                                        onClick={() => setDialogCurse(c)}
                                        className={cn(
                                            "w-full text-left px-2.5 py-1.5 rounded-md border border-purple-500/30",
                                            "text-xs text-purple-300 hover:bg-purple-500/10 transition-colors",
                                        )}
                                    >
                                        <span className="font-semibold">
                                            {c.name}
                                        </span>
                                        <span className="text-muted-foreground ml-1.5">
                                            — tap to switch
                                        </span>
                                    </button>
                                ))}
                        </div>
                    )}

                    {/* ── Enforced-curse controls ──
                        Hidden Hangman is a server-adjudicated letter game;
                        Spotty Memory rolls a d6 → disabled category;
                        Urban Explorer toggles the on-transit block;
                        Drained Brain shows its locked-out categories.
                        Other dice curses get the plain roller. */}
                    {resolvedDialog?.name === CURSE_HIDDEN_HANGMAN ? (
                        <HangmanBoard
                            castId={resolvedDialog.castId}
                            game={
                                resolvedDialog.castId != null
                                    ? $hangman[String(resolvedDialog.castId)]
                                    : undefined
                            }
                            now={now}
                            isHider={!isSeekerView}
                        />
                    ) : resolvedDialog?.name === CURSE_SPOTTY_MEMORY ? (
                        <div className="space-y-2">
                            <DiceRoller
                                size="lg"
                                onSettle={(v) => {
                                    // v969 (rulebook audit A7): Small games
                                    // have five categories — a 6 is a reroll
                                    // (rulebook p397), never "tentacles".
                                    const cat = spottyCategoryForRoll(
                                        v,
                                        $gameSize,
                                    );
                                    if (cat === null) {
                                        toast.info(
                                            "Rolled a 6 — small games have five categories. Reroll!",
                                            { autoClose: 3500 },
                                        );
                                        return;
                                    }
                                    spottyMemoryCategory.set(cat);
                                }}
                            />
                            <div className="rounded-sm border border-purple-500/40 bg-purple-500/5 px-2.5 py-2 text-xs leading-snug">
                                {$spottyCategory ? (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Ban className="w-3.5 h-3.5 text-purple-300 shrink-0" />
                                        <span>
                                            Disabled now:{" "}
                                            <span className="font-bold">
                                                {
                                                    CATEGORIES[$spottyCategory]
                                                        .label
                                                }
                                            </span>
                                            . You&apos;ll re-roll after your
                                            next question.
                                        </span>
                                    </span>
                                ) : (
                                    "Roll the die to see which category is disabled for your next question. You can't ask until you roll."
                                )}
                            </div>
                        </div>
                    ) : resolvedDialog?.name === CURSE_URBAN_EXPLORER ? (
                        <button
                            type="button"
                            onClick={() => seekerOnTransit.set(!$onTransit)}
                            aria-pressed={$onTransit}
                            className={cn(
                                "w-full rounded-sm border-2 px-3 py-2.5 flex items-center gap-2.5 text-left transition-colors",
                                $onTransit
                                    ? "border-purple-400 bg-purple-500/20"
                                    : "border-border bg-background/40 hover:border-purple-500/50",
                            )}
                        >
                            <Train
                                className={cn(
                                    "w-4 h-4 shrink-0",
                                    $onTransit
                                        ? "text-purple-200"
                                        : "text-muted-foreground",
                                )}
                            />
                            <span className="flex-1 min-w-0">
                                <span className="block text-xs font-semibold">
                                    {$onTransit
                                        ? "On transit — questions blocked"
                                        : "I'm on transit / in a station"}
                                </span>
                                <span className="block text-[11px] text-muted-foreground leading-snug">
                                    Turn this on while you&apos;re on transit
                                    or in a station — asking is blocked until
                                    you turn it off.
                                </span>
                            </span>
                            <span
                                className={cn(
                                    "shrink-0 w-9 h-5 rounded-full transition-colors relative",
                                    $onTransit
                                        ? "bg-purple-400"
                                        : "bg-muted-foreground/40",
                                )}
                            >
                                <span
                                    className={cn(
                                        "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all",
                                        $onTransit ? "left-[18px]" : "left-0.5",
                                    )}
                                />
                            </span>
                        </button>
                    ) : resolvedDialog?.name === CURSE_DRAINED_BRAIN &&
                      resolvedDialog.disabledCategories &&
                      resolvedDialog.disabledCategories.length > 0 ? (
                        <div className="rounded-sm border border-purple-500/40 bg-purple-500/5 px-2.5 py-2">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-purple-300 mb-1.5">
                                Disabled for the rest of the run
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {resolvedDialog.disabledCategories.map((id) => {
                                    const meta =
                                        CATEGORIES[id as CategoryId];
                                    if (!meta) return null;
                                    const Icon = meta.icon;
                                    return (
                                        <span
                                            key={id}
                                            className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/40 px-2.5 py-1 text-[11px] font-semibold"
                                        >
                                            <span
                                                className="inline-flex items-center justify-center w-4 h-4 rounded-sm shrink-0"
                                                style={{
                                                    backgroundColor:
                                                        meta.color,
                                                }}
                                                aria-hidden="true"
                                            >
                                                <Icon
                                                    size={10}
                                                    strokeWidth={2.5}
                                                    className="text-white"
                                                />
                                            </span>
                                            {meta.label}
                                        </span>
                                    );
                                })}
                            </div>
                        </div>
                    ) : dlgMeta?.requiresDice && resolvedDialog ? (
                        // v970: Jammed Door rolls TWO d6 per doorway
                        // (rulebook p396); other dice curses roll one. v1032:
                        // Jammed Door is a PASS/FAIL check (7+ to enter) with a
                        // per-doorway cooldown after a fail.
                        (() => {
                            const isJammed =
                                resolvedDialog.name === CURSE_JAMMED_DOOR;
                            const cid = resolvedDialog.castId;
                            const until =
                                isJammed && cid != null
                                    ? $cooldowns[String(cid)]
                                    : undefined;
                            const coolingMs = until != null ? until - now : 0;
                            const onCooldown = coolingMs > 0;
                            return (
                                <div className="space-y-2">
                                    <DiceRoller
                                        size="lg"
                                        count={curseDiceCount(resolvedDialog)}
                                        successFrom={isJammed ? 7 : undefined}
                                        disabled={onCooldown}
                                        onSettle={
                                            isJammed
                                                ? (total) => {
                                                      // A failed doorway roll
                                                      // (<7) starts the SHARED,
                                                      // restart-proof cooldown
                                                      // (server-stamped in MP).
                                                      if (total < 7)
                                                          startCurseCooldown(
                                                              cid,
                                                              jammedDoorCooldownMs(
                                                                  $gameSize,
                                                              ),
                                                          );
                                                  }
                                                : undefined
                                        }
                                    />
                                    {isJammed && onCooldown && (
                                        <p className="text-xs text-destructive font-semibold inline-flex items-center gap-1 tabular-nums">
                                            <Hourglass className="w-3 h-3" />
                                            Doorway blocked — try again in{" "}
                                            {formatCurseCountdown(coolingMs)}
                                        </p>
                                    )}
                                </div>
                            );
                        })()
                    ) : null}

                    <div className="flex gap-2">
                        {resolvedDialog && !resolvedDialog.acknowledged ? (
                            <Button
                                variant="outline"
                                className="flex-1 gap-1.5"
                                onClick={() => {
                                    acknowledge(resolvedDialog.receivedAt);
                                    setDialogCurse(null);
                                }}
                            >
                                <Check className="w-4 h-4" />
                                I understand
                            </Button>
                        ) : dlgMeta?.expiresAt != null ? (
                            // Timed curse: clears itself, no manual action
                            // needed — show the countdown instead of a
                            // clear button.
                            <div className="flex-1 flex items-center justify-center gap-1.5 text-sm text-purple-300 tabular-nums">
                                <Hourglass className="w-4 h-4" />
                                Clears in{" "}
                                {formatCurseCountdown(dlgMeta.expiresAt - now)}
                            </div>
                        ) : resolvedDialog &&
                          ENFORCED_REST_OF_RUN.has(resolvedDialog.name) ? (
                            // App-enforced "rest of your run" curses (Drained
                            // Brain / Spotty Memory / Urban Explorer): NOT
                            // manually clearable — clearing would just remove
                            // the enforcement. They lift automatically at
                            // round end (receivedCurses is wiped).
                            <div className="flex-1 flex items-center justify-center gap-1.5 text-xs text-muted-foreground leading-snug text-center">
                                Active for the rest of the run — lifts when the
                                round ends.
                            </div>
                        ) : (
                            // Open-ended curse: cleared by doing the task in
                            // the real world — trust the seekers' word. For the
                            // Bird Guide the Clear button unlocks only once the
                            // seekers have filmed for at least the target time
                            // in the viewfinder above (v1041).
                            <Button
                                variant="outline"
                                className="flex-1 gap-1.5"
                                disabled={birdBlocksClear || proofBlocksClear}
                                title={
                                    birdBlocksClear
                                        ? "Film a bird for at least the target time above first."
                                        : proofBlocksClear
                                          ? "Send the hider a verification photo first."
                                          : undefined
                                }
                                onClick={() =>
                                    dismiss(resolvedDialog!.receivedAt)
                                }
                            >
                                <Check className="w-4 h-4" />
                                Clear curse
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            onClick={() => setDialogCurse(null)}
                        >
                            Close
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

/**
 * v1096 — the Hidden Hangman board (HIDER-run, server-relayed). The HIDER picks
 * the word each round and reveals the answer to each seeker guess; the SEEKERS
 * play on the A–Z grid. Shows word blanks, a gallows drawn from the wrong count,
 * and per-role controls for every game phase.
 */
function HangmanBoard({
    castId,
    game,
    now,
    isHider = false,
}: {
    castId?: number;
    game?: HangmanState;
    now: number;
    isHider?: boolean;
}) {
    const [wordDraft, setWordDraft] = useState("");

    if (castId == null || !game) {
        return (
            <p className="text-xs text-muted-foreground text-center py-2">
                Starting the hangman game…
            </p>
        );
    }

    // ── Awaiting the hider's next-round word (rounds 2+; round 1's word is
    //    picked while casting). The input is STACKED above a full-width button
    //    so it never overflows the dialog (the v1097 inline row did). ──
    if (game.status === "awaiting-word") {
        if (!isHider) {
            return (
                <p className="text-xs text-muted-foreground text-center py-3">
                    Waiting for the hider to choose a 5-letter word…
                </p>
            );
        }
        return (
            <div className="space-y-2">
                <p className="text-xs text-muted-foreground text-center">
                    Choose a secret 5-letter word for the seekers to guess.
                </p>
                <input
                    value={wordDraft}
                    onChange={(e) =>
                        setWordDraft(
                            e.target.value
                                .toUpperCase()
                                .replace(/[^A-Z]/g, "")
                                .slice(0, 5),
                        )
                    }
                    placeholder="WORD"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full rounded-md border-2 border-border bg-background px-3 py-2 text-center text-lg font-black tracking-[0.3em] uppercase focus:outline-none focus:border-primary"
                />
                <Button
                    size="sm"
                    className="w-full"
                    disabled={wordDraft.length !== 5}
                    onClick={() => {
                        sendHangmanWord(castId, wordDraft);
                        setWordDraft("");
                    }}
                >
                    Set word
                </Button>
            </div>
        );
    }

    // ── Ready — a word is set; the seekers start the round when they need to
    //    ask/board (rulebook: they must beat the hider before doing so). ──
    if (game.status === "ready") {
        if (isHider) {
            return (
                <p className="text-xs text-muted-foreground text-center py-3">
                    Word set — waiting for the seekers to start the game.
                </p>
            );
        }
        return (
            <div className="space-y-2 py-1">
                <p className="text-xs text-muted-foreground text-center">
                    Beat the hider at hangman before asking a question or
                    boarding transit.
                </p>
                <Button
                    className="w-full"
                    onClick={() => sendHangmanBegin(castId)}
                >
                    Start game
                </Button>
            </div>
        );
    }

    // ── Lost — cooldown, then play-again / clear ──
    if (game.status === "lost") {
        const coolingMs =
            game.cooldownUntil != null ? game.cooldownUntil - now : 0;
        return (
            <div className="space-y-3">
                <HangmanFigure wrong={game.wrong} maxWrong={game.maxWrong} />
                {coolingMs > 0 ? (
                    <p className="text-xs text-destructive font-semibold text-center tabular-nums">
                        {isHider ? "The seekers lost" : "You lost"} this round (
                        {game.losses}/{game.maxLosses}).{" "}
                        {game.final
                            ? "The curse clears in"
                            : isHider
                              ? "They can try again in"
                              : "You can try again in"}{" "}
                        {formatCurseCountdown(coolingMs)}.
                    </p>
                ) : isHider ? (
                    <p className="text-xs text-muted-foreground text-center">
                        Waiting for the seekers to play again…
                    </p>
                ) : (
                    <Button
                        size="sm"
                        className="w-full"
                        onClick={() => sendHangmanContinue(castId)}
                    >
                        {game.final
                            ? "Clear the curse"
                            : "Play again (new word)"}
                    </Button>
                )}
            </div>
        );
    }

    // ── Playing ──
    const pending = game.pending;
    const left = Math.max(0, game.maxWrong - game.wrong);
    return (
        <div className="space-y-3">
            {/* Word blanks — revealed letters in position. */}
            <div className="flex justify-center gap-1.5">
                {game.pattern.map((ch, i) => (
                    <span
                        key={i}
                        className="w-7 h-9 flex items-center justify-center rounded-sm border-b-2 border-foreground/60 text-xl font-black font-inter-tight uppercase"
                    >
                        {ch}
                    </span>
                ))}
            </div>
            <HangmanFigure wrong={game.wrong} maxWrong={game.maxWrong} />

            {isHider ? (
                // The hider reveals each guess.
                pending ? (
                    <div className="space-y-2 text-center">
                        <p className="text-sm">
                            The seekers guessed{" "}
                            <span className="font-black text-lg">
                                {pending}
                            </span>
                            .
                        </p>
                        <Button
                            size="sm"
                            className="w-full"
                            onClick={() => sendHangmanReveal(castId)}
                        >
                            Reveal the answer
                        </Button>
                    </div>
                ) : (
                    <p className="text-[11px] text-muted-foreground text-center">
                        The seekers are playing — waiting for their next guess…
                        {game.losses > 0 &&
                            ` Losses ${game.losses}/${game.maxLosses}.`}
                    </p>
                )
            ) : (
                // The seekers guess on the grid.
                <>
                    <div className="grid grid-cols-7 gap-1">
                        {"ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((L) => {
                            const guessed = game.guessed.includes(L);
                            const correct = guessed && game.pattern.includes(L);
                            const disabled = guessed || pending != null;
                            return (
                                <button
                                    key={L}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() =>
                                        !disabled && sendHangmanGuess(castId, L)
                                    }
                                    className={cn(
                                        "h-8 rounded-sm text-sm font-bold transition-colors",
                                        !guessed &&
                                            "bg-secondary hover:bg-accent text-foreground",
                                        guessed &&
                                            correct &&
                                            "bg-emerald-500/25 text-emerald-300",
                                        guessed &&
                                            !correct &&
                                            "bg-destructive/20 text-destructive/70 line-through",
                                    )}
                                >
                                    {L}
                                </button>
                            );
                        })}
                    </div>
                    <p className="text-[11px] text-muted-foreground text-center">
                        {pending
                            ? `Waiting for the hider to reveal "${pending}"…`
                            : `Guess the hider's word — ${left} wrong ${
                                  left === 1 ? "guess" : "guesses"
                              } left.`}
                        {game.losses > 0 &&
                            ` Losses ${game.losses}/${game.maxLosses}.`}
                    </p>
                </>
            )}
        </div>
    );
}

/** Compact SVG gallows — reveals head, body, two arms, two legs, hat as the
 *  wrong count climbs (7 parts total). */
function HangmanFigure({ wrong, maxWrong }: { wrong: number; maxWrong: number }) {
    const p = (n: number) => wrong >= n; // part n revealed?
    const stroke = "currentColor";
    return (
        <svg
            viewBox="0 0 80 90"
            className={cn(
                "mx-auto h-24 w-auto",
                wrong >= maxWrong ? "text-destructive" : "text-foreground/80",
            )}
            fill="none"
            stroke={stroke}
            strokeWidth={2.5}
            strokeLinecap="round"
        >
            {/* gallows */}
            <line x1="6" y1="86" x2="46" y2="86" />
            <line x1="16" y1="86" x2="16" y2="6" />
            <line x1="16" y1="6" x2="52" y2="6" />
            <line x1="52" y1="6" x2="52" y2="16" />
            {/* head (1) */}
            {p(1) && <circle cx="52" cy="24" r="8" />}
            {/* body (2) */}
            {p(2) && <line x1="52" y1="32" x2="52" y2="56" />}
            {/* left arm (3) / right arm (4) */}
            {p(3) && <line x1="52" y1="38" x2="42" y2="48" />}
            {p(4) && <line x1="52" y1="38" x2="62" y2="48" />}
            {/* left leg (5) / right leg (6) */}
            {p(5) && <line x1="52" y1="56" x2="44" y2="70" />}
            {p(6) && <line x1="52" y1="56" x2="60" y2="70" />}
            {/* hat (7) */}
            {p(7) && (
                <>
                    <line x1="44" y1="17" x2="60" y2="17" />
                    <rect x="47" y="9" width="10" height="8" rx="1" />
                </>
            )}
        </svg>
    );
}

export default CurseInbox;
