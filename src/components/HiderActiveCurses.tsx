import { useStore } from "@nanostores/react";
import { Check, Zap } from "lucide-react";

import { castCurses } from "@/lib/seekerInbound";
import { cn } from "@/lib/utils";

const CURSE_COLOR = "#8b5cf6";

/**
 * The hider's mirror of the seeker's `CurseInbox` (v906): the curses the
 * hider has cast this round, so they can see what's active on the seekers.
 * The hider knows what they cast; clears are a real-world action (the
 * seekers tell them), so each entry has a manual "Mark cleared" — and the
 * whole list resets at round end. Hidden entirely when there's nothing
 * active, so it never sits on screen for no reason.
 *
 * Purely a hider-side record — no wire sync; it reflects THIS hider's casts.
 */
export function HiderActiveCurses({ className }: { className?: string }) {
    const $cast = useStore(castCurses);
    const active = $cast.filter((c) => !c.dismissed);
    if (active.length === 0) return null;

    const markCleared = (index: number) => {
        // Match by (name, receivedAt) so re-renders don't clear the wrong row.
        const target = active[index];
        castCurses.set(
            castCurses.get().map((c) =>
                c.name === target.name && c.receivedAt === target.receivedAt
                    ? { ...c, dismissed: true }
                    : c,
            ),
        );
    };

    return (
        <div className={cn("space-y-2", className)}>
            <div className="flex items-center gap-1.5 text-[11px] font-poppins font-bold uppercase tracking-[0.16em] text-muted-foreground">
                <Zap className="w-3.5 h-3.5" />
                Active curses ({active.length})
            </div>
            <div className="flex flex-col gap-2">
                {active.map((curse, i) => {
                    return (
                        <div
                            key={`${curse.name}:${curse.receivedAt}`}
                            className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-3"
                        >
                            <div className="flex items-start gap-2">
                                <span
                                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white"
                                    style={{ backgroundColor: CURSE_COLOR }}
                                    aria-hidden="true"
                                >
                                    <Zap className="h-4 w-4" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="font-poppins font-bold text-sm leading-tight text-foreground">
                                        {curse.name}
                                    </p>
                                    <p className="text-xs text-muted-foreground leading-snug mt-0.5">
                                        {curse.description}
                                    </p>
                                    {curse.filmSeconds != null && (
                                        <p className="text-[11px] text-purple-400 mt-1 font-semibold">
                                            Target: {curse.filmSeconds}s
                                        </p>
                                    )}
                                    {curse.rockCount != null && (
                                        <p className="text-[11px] text-purple-400 mt-1 font-semibold">
                                            Target: {curse.rockCount} rocks
                                        </p>
                                    )}
                                    {curse.travelDestination && (
                                        <p className="text-[11px] text-purple-400 mt-1 font-semibold">
                                            Destination: {curse.travelDestination}
                                        </p>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => markCleared(i)}
                                        className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                    >
                                        <Check className="w-3 h-3" />
                                        Mark cleared
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default HiderActiveCurses;
