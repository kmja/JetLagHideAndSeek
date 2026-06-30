import { Dice5 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Small d6 widget the hider can roll for cards that require it.
 * Tap to roll — the result animates briefly then settles. Re-tap to
 * roll again. Stays compact so it can live alongside the hand panel
 * during the seeking phase without competing for attention.
 */
export function DiceRoller({
    onSettle,
}: {
    /** Called with the final value once a roll settles. Used by curses
     *  that map the roll to an effect (e.g. Spotty Memory → category). */
    onSettle?: (value: number) => void;
} = {}) {
    const [value, setValue] = useState<number | null>(null);
    const [rolling, setRolling] = useState(false);

    const roll = () => {
        if (rolling) return;
        setRolling(true);
        // Quick "tumble" — cycle through random values for ~400 ms
        // before settling, so the result feels earned.
        const start = Date.now();
        const tick = () => {
            const elapsed = Date.now() - start;
            const next = 1 + Math.floor(Math.random() * 6);
            setValue(next);
            if (elapsed < 400) {
                window.setTimeout(tick, 60);
            } else {
                setRolling(false);
                onSettle?.(next);
            }
        };
        tick();
    };

    return (
        <div
            className={cn(
                "rounded-sm border border-border bg-secondary/40 p-3",
                "flex items-center gap-3",
            )}
            data-testid="dice-roller"
        >
            <button
                type="button"
                onClick={roll}
                disabled={rolling}
                aria-label="Roll d6"
                className={cn(
                    "shrink-0 w-12 h-12 rounded-md",
                    "bg-background border-2 border-primary",
                    "flex items-center justify-center",
                    "font-inter-tight italic font-black text-2xl tabular-nums text-primary",
                    "transition-transform",
                    rolling && "animate-[jlDiceTumble_400ms_ease-out]",
                    !rolling && "hover:scale-[1.05] active:scale-95",
                    "disabled:cursor-not-allowed",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
            >
                {value ?? <Dice5 className="w-6 h-6" />}
            </button>
            <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                    Dice
                </div>
                <div className="text-xs text-foreground leading-snug mt-0.5">
                    {value === null
                        ? "Tap to roll a d6 when a curse card asks for it."
                        : rolling
                          ? "Rolling…"
                          : `Rolled ${value}. Tap to roll again.`}
                </div>
            </div>
        </div>
    );
}

export default DiceRoller;
