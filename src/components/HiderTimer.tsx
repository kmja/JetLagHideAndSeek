import { useStore } from "@nanostores/react";
import { Flag, Footprints, Timer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { appConfirm } from "@/lib/confirm";
import {
    effectiveHiddenDebitMs,
    endgameConfirmedAt,
    endgameStartedAt,
    endOfRoundDialogOpen,
    formatTimeRemaining,
    hiddenCreditMs,
    hidingPeriodEndsAt,
    roundEndHiderName,
    setupCompleted,
} from "@/lib/gameSetup";
import { roundFoundAt, roundLog } from "@/lib/hiderRole";
import {
    displayName,
    multiplayerEnabled,
    participants,
} from "@/lib/multiplayer/session";
import { seekerMarkFound } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

/**
 * Always-visible hider timer for seekers (top-left, above the map).
 *
 * Two phases derived from `hidingPeriodEndsAt`:
 *
 *   - **Hiding period** (now < hidingPeriodEndsAt): MM:SS countdown.
 *     The hider is en route to their hiding zone; seekers can't ask
 *     questions yet. Display-only — only the hider can end the
 *     hiding period early (from their own HiderHome; the debug panel
 *     keeps it for testing).
 *
 *   - **Hidden so far** (now >= hidingPeriodEndsAt): elapsed time the
 *     hider has been "seekable but uncaught" — this is the round's
 *     score in the making. Counts in primary red, with seconds.
 */
/** Override atom values to render a specific state — used by the
 *  /debug/overlays gallery so several states can show at once without
 *  touching global game state. */
export interface HiderTimerPreview {
    endsAt: number | null;
    setupCompleted?: boolean;
    endgameStartedAt?: number | null;
    endgameConfirmedAt?: number | null;
    foundAt?: number | null;
    roundLog?: ReturnType<typeof roundLog.get>;
}

export function HiderTimer({ preview }: { preview?: HiderTimerPreview } = {}) {
    let $endsAt = useStore(hidingPeriodEndsAt);
    let $setupCompleted = useStore(setupCompleted);
    let $endgameStartedAt = useStore(endgameStartedAt);
    let $endgameConfirmedAt = useStore(endgameConfirmedAt);
    let $foundAt = useStore(roundFoundAt);
    let $roundLog = useStore(roundLog);
    const $participants = useStore(participants);
    // v879: the name of the hider hiding THIS round, for the live
    // leaderboard row (past rows carry their own stored name).
    const currentHiderName =
        $participants.find((p) => p.role === "hider")?.displayName?.trim() ||
        displayName.get()?.trim() ||
        "Hider";
    if (preview) {
        $endsAt = preview.endsAt;
        $setupCompleted = preview.setupCompleted ?? true;
        $endgameStartedAt = preview.endgameStartedAt ?? null;
        $endgameConfirmedAt = preview.endgameConfirmedAt ?? null;
        $foundAt = preview.foundAt ?? null;
        $roundLog = preview.roundLog ?? [];
    }

    const handleMarkFound = async () => {
        // Ending the round is irreversible (freezes the score, fires the
        // end-of-round dialog on both devices). Confirm first, and reinforce
        // the rulebook requirement that the seeker is physically WITH the
        // hider — the app can't measure the seeker↔hider distance locally (the
        // hider's exact position is the game's secret and never reaches the
        // seeker's device), so this is a self-declared check.
        const ok = await appConfirm({
            title: "Mark the hider found?",
            description:
                "Only do this once you've physically reached the hider and are standing with them. This freezes the score and ends the round.",
            confirmLabel: "Mark found",
        });
        if (!ok) return;
        const ts = Date.now();
        if (multiplayerEnabled.get()) {
            // v853: DON'T end optimistically online. The server soft-validates
            // proximity and either broadcasts `ended` (→ our `ended` handler
            // sets roundFoundAt + opens the dialog, on this device too) or
            // replies `foundFar` for the "are you sure?" warning. Ending here
            // would skip the check.
            seekerMarkFound(ts);
        } else {
            roundFoundAt.set(ts);
            // v879: snapshot the just-finished hider's name for the
            // leaderboard (offline/solo — the online path snapshots in the
            // `ended` handler). Captured before any rotation.
            const hider = participants
                .get()
                .find((p) => p.role === "hider");
            const name =
                hider?.displayName?.trim() || displayName.get()?.trim();
            if (name) roundEndHiderName.set(name);
            // Fire the celebratory end-of-round dialog (v631).
            endOfRoundDialogOpen.set(true);
        }
        // v824: NO auto OS-share sheet here anymore. It was a pre-multiplayer
        // remnant (the hider used to tap a shared link to end their timer);
        // now `seekerMarkFound` syncs the found state over the wire and the
        // EndOfRoundDialog fires on both devices. A share sheet popping open
        // on "Mark found" reads as a bug. (Manual "Share again" still lives
        // in the post-game FoundSummary for anyone who wants a link.)
    };

    // Tick every second whenever the timer is meaningful, but
    // pause while the tab is hidden so the CPU isn't woken on
    // locked phones. v905: the shared `useNow` clock FREEZES while the
    // game is paused, so this countdown actually stops during a pause
    // (the old private Date.now() interval kept ticking — the reported
    // "pause doesn't pause the hiding timer" bug).
    // v1028: stop ticking once the round is over ($foundAt set) so the map
    // timer freezes at the final time instead of counting up forever.
    const now = useNow(Boolean($endsAt && $setupCompleted && !$foundAt));

    // v848: the live current-round rank on the seeking leaderboard, for the
    // climb flourish. Null while not seeking. Computed before the early
    // return so the climb-detection effect below runs unconditionally.
    const currentRankForAnim = useMemo(() => {
        if (!$setupCompleted || !$endsAt) return null;
        if (now < $endsAt) return null; // hiding period — no seeking board
        const cur = Math.max(
            0,
            now - $endsAt + hiddenCreditMs.get() - effectiveHiddenDebitMs(now),
        );
        const times = [cur, ...$roundLog.map((r) => r.hidingMs)].sort(
            (a, b) => b - a,
        );
        return times.indexOf(cur) + 1;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [now, $endsAt, $setupCompleted, $roundLog]);

    // Fire a one-shot flourish on the live row whenever it climbs a spot
    // (rank decreases). Ignores drops and the initial mount.
    const prevRankRef = useRef<number | null>(null);
    const [climbing, setClimbing] = useState(false);
    useEffect(() => {
        const prev = prevRankRef.current;
        prevRankRef.current = currentRankForAnim;
        if (
            currentRankForAnim != null &&
            prev != null &&
            currentRankForAnim < prev
        ) {
            setClimbing(true);
            const t = window.setTimeout(() => setClimbing(false), 700);
            return () => window.clearTimeout(t);
        }
    }, [currentRankForAnim]);

    if (!$setupCompleted || !$endsAt) return null;

    // v1028: once the hider is marked FOUND the round is over — freeze the
    // clock at the found timestamp so the map timer stops ticking (it kept
    // counting up before). `useNow` already freezes during a pause; this adds
    // the round-end freeze.
    const clockNow = $foundAt ?? now;

    const inHidingPeriod = clockNow < $endsAt;
    const phaseLabel = inHidingPeriod ? "Hiding period" : "Hidden for";

    const formatTtb = (ms: number) => {
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n: number) => String(n).padStart(2, "0");
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    };

    let display: string;
    // Raw current-round hidden time (ms) while seeking, else null. Exposed
    // so the seeking leaderboard can rank the LIVE time against past rounds.
    let currentElapsedMs: number | null = null;
    if (inHidingPeriod) {
        display = formatTimeRemaining($endsAt - clockNow);
    } else {
        // Elapsed since hiding period ended, plus time banked by a Move
        // powerup, minus time paused for overdue answers (rulebook p61)
        // — so the live tally matches the final score. `clockNow` is frozen at
        // the found timestamp once the round ends, so this stops climbing.
        currentElapsedMs = Math.max(
            0,
            clockNow -
                $endsAt +
                hiddenCreditMs.get() -
                effectiveHiddenDebitMs(clockNow),
        );
        display = formatTtb(currentElapsedMs);
    }

    // Seeking leaderboard: the LIVE current-round time ranked against the
    // past-round times, longest-first (v847). Shows the top 3 — but the
    // current entry is ALWAYS included with its TRUE rank even when it ranks
    // below 3rd (v848), so the live clock never disappears. The current entry
    // climbs as it grows and takes the "1st" spot once it passes the best
    // past hide. Only meaningful while seeking (currentElapsedMs set).
    const rankSuffix = (n: number) => (n === 1 ? "st" : n === 2 ? "nd" : "rd");
    const leaderboard =
        currentElapsedMs === null
            ? []
            : (() => {
                  const ranked = [
                      { current: true, ms: currentElapsedMs, name: currentHiderName },
                      ...$roundLog.map((r) => ({
                          current: false,
                          ms: r.hidingMs,
                          name: r.hiderName,
                      })),
                  ]
                      .sort((a, b) => b.ms - a.ms)
                      .map((e, i) => ({ ...e, rank: i + 1 }));
                  const top3 = ranked.slice(0, 3);
                  if (top3.some((e) => e.current)) return top3;
                  const cur = ranked.find((e) => e.current);
                  return cur ? [...top3, cur] : top3;
              })();

    return (
        // v457: Jet-Lag-show styling. The card positions ITSELF (the
        // SeekerPage wrapper no longer pins it) so it can sit bottom-LEFT
        // during the hiding period (yellow "hiding time remaining" box,
        // like the show) and bottom-RIGHT once seeking starts (white
        // round-timer box with a red accent + a gold "time to beat"
        // leaderboard row). The endgame action buttons stack ABOVE the
        // timer, right-aligned, in the seeking phase only.
        <div
            className={cn(
                "absolute z-[1030] group-[.fullscreen]:hidden",
                // v462: the bottom nav is now a flow row below the map
                // area (not an overlay), so the timer only needs to clear
                // the map edge. v622: dropped near the bottom edge — the
                // basemap attribution that used to sit bottom-right (and
                // forced the old bottom-7/8 raise) moved to top-left in
                // v616, so that vertical margin was dead space.
                "bottom-2 md:bottom-3",
                "flex flex-col gap-2",
                inHidingPeriod
                    ? "left-2 md:left-4 items-start"
                    : "right-2 md:right-4 items-end",
            )}
        >
            {/* Round-end action surface. The endgame is triggered from the
                map now (tap the hider's zone → StationTransitCard "Start
                endgame here"), so there's no "Trigger endgame" button here
                anymore (v623). Once armed we show:
                  • an "Awaiting hider" (→ green "In the zone" on confirm)
                    badge, and
                  • the "Mark hider found" button.
                Nothing renders before the endgame is armed or after the
                hider is found (the FoundSummary lives in the lobby). */}
            {!inHidingPeriod && !$foundAt && $endgameStartedAt !== null && (
                <div className="flex flex-col items-end gap-1.5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {/* v950: the server only arms the endgame for a CORRECT
                        claim (a wrong one is denied outright + never arms this),
                        so once it's armed the seekers ARE in the right zone —
                        always the green "in the zone" badge. */}
                    <div
                        className={cn(
                            "flex items-center gap-1.5",
                            "px-2.5 py-1.5 rounded-md border-2",
                            "animate-in fade-in duration-200",
                            "bg-success/15 border-success/70 text-success",
                        )}
                        title="You're in the hider's zone. Find them!"
                    >
                        <Flag className="w-3.5 h-3.5" strokeWidth={2.5} />
                        <span className="text-[10px] font-poppins font-bold uppercase tracking-[0.15em]">
                            In the zone
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={handleMarkFound}
                        title="Mark hider found — freeze the score and end the round"
                        className={cn(
                            "flex items-center justify-center gap-2 w-full",
                            "px-3 py-2 rounded-md",
                            "bg-primary text-primary-foreground",
                            "hover:bg-primary/90 active:bg-primary/80",
                            "border-2 border-primary shadow-md",
                            "transition-colors",
                            "text-xs font-poppins font-bold uppercase tracking-wider",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            "animate-in fade-in slide-in-from-bottom-1 duration-200",
                        )}
                    >
                        <Footprints className="w-4 h-4" strokeWidth={2.5} />
                        Mark hider found
                    </button>
                </div>
            )}

            {inHidingPeriod ? (
                // Yellow "HIDING TIME REMAINING" box — the show's
                // hiding-phase clock. Dark navy stopwatch + label over
                // big navy digits on a golden field.
                <div
                    role="status"
                    aria-live="polite"
                    aria-label={`${phaseLabel}: ${display}`}
                    title={`${phaseLabel}: ${display}`}
                    className="flex items-center gap-3 rounded-xl pl-3 pr-5 py-2 shadow-lg bg-[#F2C63C]"
                >
                    <Timer
                        className="w-8 h-8 shrink-0 text-[#1F2F3F]"
                        strokeWidth={2.5}
                    />
                    <div className="flex flex-col leading-none gap-1">
                        <span className="text-[10px] font-poppins font-extrabold uppercase tracking-[0.12em] text-[#1F2F3F]">
                            Hiding time remaining
                        </span>
                        <span className="font-inter-tight font-black tabular-nums text-3xl leading-none text-[#1F2F3F]">
                            {display}
                        </span>
                    </div>
                </div>
            ) : $roundLog.length === 0 ? (
                /* Round 1 — no past times to rank against, so just the live
                   clock: white round-timer box with a red accent down the
                   right edge (the show's running clock). */
                <div
                    role="status"
                    aria-live="polite"
                    aria-label={`${phaseLabel}: ${display}`}
                    title={`${phaseLabel}: ${display}`}
                    className="relative overflow-hidden rounded-xl shadow-lg bg-white pl-4 pr-7 py-2"
                >
                    <span className="block max-w-[9rem] truncate text-[9px] font-poppins font-extrabold uppercase tracking-[0.14em] text-[#1F2F3F]/55 leading-none mb-0.5">
                        {currentHiderName}
                    </span>
                    <span className="font-inter-tight font-black tabular-nums text-3xl leading-none text-jetlag">
                        {display}
                    </span>
                    <span
                        className="absolute inset-y-0 right-0 w-2.5 bg-primary"
                        aria-hidden
                    />
                </div>
            ) : (
                /* Top-3 leaderboard, longest-first: the LIVE current time
                   (white, red accent) ranked among the best past-round times
                   (gold). Re-sorts every tick, so the live time climbs and
                   takes 1st once it passes the best hide. */
                <div className="flex flex-col items-end gap-1.5">
                    {leaderboard.map((e) => (
                        <div
                            key={e.current ? "current" : `past-${e.rank}`}
                            className={cn(
                                "flex items-stretch rounded-xl overflow-hidden shadow-lg",
                                e.current &&
                                    climbing &&
                                    "animate-[jlRankClimb_700ms_cubic-bezier(0.16,1,0.3,1)] relative z-[1]",
                            )}
                            title={
                                e.current
                                    ? `${phaseLabel}: ${formatTtb(e.ms)}`
                                    : `Time to beat: ${formatTtb(e.ms)}`
                            }
                        >
                            <div
                                className="flex items-center px-2"
                                style={{
                                    background:
                                        e.rank === 1
                                            ? "#F2C63C" // gold (vivid)
                                            : e.rank === 2
                                              ? "#B8BDC7" // silver
                                              : e.rank === 3
                                                ? "#CF8B4B" // bronze
                                                : "#9AA1AD",
                                }}
                            >
                                <span
                                    className={cn(
                                        "font-inter-tight font-black text-sm leading-none",
                                        e.rank === 3
                                            ? "text-white"
                                            : "text-[#1F2F3F]",
                                    )}
                                >
                                    {e.rank}
                                    <span className="text-[9px] align-super">
                                        {rankSuffix(e.rank)}
                                    </span>
                                </span>
                            </div>
                            {e.current ? (
                                // The LIVE clock — kept at its full prominent
                                // size (text-3xl, red accent), always shown.
                                // v879: the eyebrow carries the hider's NAME.
                                <div className="relative flex flex-col justify-center bg-white pl-3 pr-7 py-2 leading-none">
                                    <span className="block max-w-[9rem] truncate text-[9px] font-poppins font-extrabold uppercase tracking-[0.14em] text-[#1F2F3F]/55 leading-none mb-0.5">
                                        {e.name}
                                    </span>
                                    <span className="font-inter-tight font-black tabular-nums text-3xl leading-none text-jetlag">
                                        {formatTtb(e.ms)}
                                    </span>
                                    <span
                                        className="absolute inset-y-0 right-0 w-2.5 bg-primary"
                                        aria-hidden
                                    />
                                </div>
                            ) : (
                                <div
                                    className="flex flex-col justify-center px-3 py-1.5 leading-none"
                                    // Match the box tint to the placement so a
                                    // 2nd-place time isn't gold (v871): gold 1st
                                    // / silver 2nd / bronze 3rd / neutral rest,
                                    // lightened so the navy digits stay legible.
                                    style={{
                                        background:
                                            e.rank === 1
                                                ? "#F2C63C"
                                                : e.rank === 2
                                                  ? "#D6DAE1"
                                                  : e.rank === 3
                                                    ? "#E4B98D"
                                                    : "#E6E8EC",
                                    }}
                                >
                                    {/* v879: hider name above the time. */}
                                    <span className="block max-w-[9rem] truncate text-[9px] font-poppins font-extrabold uppercase tracking-[0.12em] text-[#1F2F3F]/60 leading-none mb-0.5">
                                        {e.name}
                                    </span>
                                    <span className="font-inter-tight font-black tabular-nums text-xl leading-none text-[#1F2F3F]">
                                        {formatTtb(e.ms)}
                                    </span>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default HiderTimer;
