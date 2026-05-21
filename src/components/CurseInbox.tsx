import { useStore } from "@nanostores/react";
import { Check, X, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { receivedCurses } from "@/lib/seekerInbound";
import { cn } from "@/lib/utils";

import { SectionPill } from "./JetLagLogo";

/**
 * Persistent banner over the bottom of the seeker's screen showing any
 * unacknowledged curses. Each curse stays visible (with name + rules
 * text + casting cost) until the seeker taps "I understand" — that
 * marks it `acknowledged: true` so it doesn't reappear after reloads
 * but is still retrievable from history later.
 *
 * Rulebook (p48): seekers must abide by the curse's effect. We can't
 * enforce it programmatically (yet), so the banner just makes sure the
 * seeker can't miss what they were hit with.
 */
export function CurseInbox() {
    const $curses = useStore(receivedCurses);
    const unack = $curses.filter((c) => !c.acknowledged);
    if (unack.length === 0) return null;

    const acknowledge = (receivedAt: number) => {
        receivedCurses.set(
            receivedCurses
                .get()
                .map((c) =>
                    c.receivedAt === receivedAt
                        ? { ...c, acknowledged: true }
                        : c,
                ),
        );
    };

    return (
        <div
            className={cn(
                "fixed inset-x-2 z-[1042]",
                // Sit above the mobile bottom nav (z-1040). Use safe-area
                // padding so we don't get under the home indicator.
                "bottom-[calc(80px+env(safe-area-inset-bottom))] md:bottom-4",
                "max-w-md mx-auto",
            )}
            role="alert"
            aria-live="assertive"
        >
            {unack.map((curse, idx) => (
                <div
                    key={curse.receivedAt}
                    className={cn(
                        "rounded-md border-2 border-purple-500/60 bg-background/95 backdrop-blur-md shadow-xl",
                        "p-3 mb-2",
                        // Stack effect: cards behind are nudged down/right
                        idx > 0 && "scale-[0.98] -mt-1",
                    )}
                >
                    <div className="flex items-start gap-2.5">
                        <span
                            className="inline-flex items-center justify-center w-8 h-8 rounded-sm shrink-0"
                            style={{ background: "rgb(126 34 206)" /* purple-700 */ }}
                            aria-hidden="true"
                        >
                            <Zap
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
                                {curse.description}
                            </p>
                            {curse.castingCost && (
                                <p className="text-[11px] text-muted-foreground mt-1 leading-snug italic">
                                    Casting cost: {curse.castingCost}
                                </p>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => acknowledge(curse.receivedAt)}
                            aria-label="Dismiss"
                            className={cn(
                                "shrink-0 w-6 h-6 flex items-center justify-center",
                                "rounded-md text-muted-foreground",
                                "hover:bg-accent hover:text-foreground transition-colors",
                            )}
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    <div className="flex justify-end mt-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="default"
                            className="gap-1.5 h-7 px-2.5 text-[11px]"
                            onClick={() => acknowledge(curse.receivedAt)}
                        >
                            <Check className="w-3 h-3" />
                            I understand
                        </Button>
                    </div>
                </div>
            ))}
        </div>
    );
}

export default CurseInbox;
