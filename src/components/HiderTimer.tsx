import { useStore } from "@nanostores/react";
import { Flag, Footprints, Timer } from "lucide-react";
import { useMemo, useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    effectiveHiddenDebitMs,
    endgameConfirmedAt,
    endgameStartedAt,
    endOfRoundDialogOpen,
    formatTimeRemaining,
    hiddenCreditMs,
    hidingPeriodEndsAt,
    setupCompleted,
} from "@/lib/gameSetup";
import { roundFoundAt, roundLog } from "@/lib/hiderRole";
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
    if (preview) {
        $endsAt = preview.endsAt;
        $setupCompleted = preview.setupCompleted ?? true;
        $endgameStartedAt = preview.endgameStartedAt ?? null;
        $endgameConfirmedAt = preview.endgameConfirmedAt ?? null;
        $foundAt = preview.foundAt ?? null;
        $roundLog = preview.roundLog ?? [];
    }

    const handleMarkFound = () => {
        const ts = Date.now();
        roundFoundAt.set(ts);
        // Fire the celebratory end-of-round dialog (v631).
        endOfRoundDialogOpen.set(true);
        // Mirror through multiplayer; no-op when offline.
        seekerMarkFound(ts);
        // v824: NO auto OS-share sheet here anymore. It was a pre-multiplayer
        // remnant (the hider used to tap a shared link to end their timer);
        // now `seekerMarkFound` syncs the found state over the wire and the
        // EndOfRoundDialog fires on both devices. A share sheet popping open
        // on "Mark found" reads as a bug. (Manual "Share again" still lives
        // in the post-game FoundSummary for anyone who wants a link.)
    };

    // Tick every second whenever the timer is meaningful, but
    // pause while the tab is hidden so the CPU isn't woken on
    // locked phones.
    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(
        () => setNow(Date.now()),
        1000,
        Boolean($endsAt && $setupCompleted),
    );

    // v318: best previous hiding time across logged rounds, surfaced
    // as a "Time to beat" reference once at least one round has been
    // completed in this game.
    const timeToBeatMs = useMemo(() => {
        if ($roundLog.length === 0) return null;
        return Math.max(...$roundLog.map((r) => r.hidingMs));
    }, [$roundLog]);

    if (!$setupCompleted || !$endsAt) return null;

    const inHidingPeriod = now < $endsAt;
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
    if (inHidingPeriod) {
        display = formatTimeRemaining($endsAt - now);
    } else {
        // Elapsed since hiding period ended, plus time banked by a Move
        // powerup, minus time paused for overdue answers (rulebook p61)
        // — so the live tally matches the final score.
        const elapsedMs = Math.max(
            0,
            now - $endsAt + hiddenCreditMs.get() - effectiveHiddenDebitMs(now),
        );
        const total = Math.floor(elapsedMs / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n: number) => String(n).padStart(2, "0");
        display = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

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
                    {/* Provisional until the hider responds. Once they
                        confirm, flip to a green "in the zone" badge so the
                        seekers know they've got the right place (the
                        positive signal the tabletop rules leave implicit). */}
                    <div
                        className={cn(
                            "flex items-center gap-1.5",
                            "px-2 py-1 rounded-md border-2",
                            "animate-in fade-in duration-200",
                            $endgameConfirmedAt != null
                                ? "bg-success/15 border-success/70 text-success"
                                : "bg-yellow-500/15 border-yellow-500/70 text-yellow-300",
                        )}
                        title={
                            $endgameConfirmedAt != null
                                ? "Hider confirmed — you're in the right zone. Find them!"
                                : "Waiting for the hider to confirm you've reached their zone."
                        }
                    >
                        <Flag className="w-3 h-3" strokeWidth={2.5} />
                        <span className="text-[9px] font-poppins font-bold uppercase tracking-[0.15em]">
                            {$endgameConfirmedAt != null
                                ? "In the zone"
                                : "Awaiting hider"}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={handleMarkFound}
                        title="Mark hider found — freeze the score and share the round-end link"
                        className={cn(
                            "flex items-center justify-center gap-1.5 w-full",
                            "px-2.5 py-1.5 rounded-md",
                            "bg-primary text-primary-foreground",
                            "hover:bg-primary/90 active:bg-primary/80",
                            "border-2 border-primary shadow-md",
                            "transition-colors",
                            "text-[10px] font-poppins font-bold uppercase tracking-wider",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            "animate-in fade-in slide-in-from-bottom-1 duration-200",
                        )}
                    >
                        <Footprints className="w-3 h-3" strokeWidth={2.5} />
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
            ) : (
                <>
                    {/* White round-timer box with a red accent down the
                        right edge — the show's running clock. */}
                    <div
                        role="status"
                        aria-live="polite"
                        aria-label={`${phaseLabel}: ${display}`}
                        title={`${phaseLabel}: ${display}`}
                        className="relative overflow-hidden rounded-xl shadow-lg bg-white pl-4 pr-7 py-2"
                    >
                        <span className="block text-[9px] font-poppins font-extrabold uppercase tracking-[0.14em] text-[#1F2F3F]/55 leading-none mb-0.5">
                            Hidden for
                        </span>
                        <span className="font-inter-tight font-black tabular-nums text-3xl leading-none text-jetlag">
                            {display}
                        </span>
                        <span
                            className="absolute inset-y-0 right-0 w-2.5 bg-primary"
                            aria-hidden
                        />
                    </div>

                    {/* Gold "1st / time to beat" leaderboard row — the
                        show's best-time strip under the clock. */}
                    {timeToBeatMs !== null && (
                        <div
                            className="flex items-stretch rounded-xl overflow-hidden shadow-lg"
                            title={`Time to beat: ${formatTtb(timeToBeatMs)}`}
                        >
                            <div className="flex items-center px-2.5 bg-[#D6A92B]">
                                <span className="font-inter-tight font-black text-sm leading-none text-[#1F2F3F]">
                                    1
                                    <span className="text-[9px] align-super">
                                        st
                                    </span>
                                </span>
                            </div>
                            <div className="flex items-center px-3 py-1.5 bg-[#F2C63C]">
                                <span className="font-inter-tight font-black tabular-nums text-xl leading-none text-[#1F2F3F]">
                                    {formatTtb(timeToBeatMs)}
                                </span>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export default HiderTimer;
