import { Dice5 } from "lucide-react";
import { useState } from "react";

import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

/**
 * Small d6 widget the seekers can roll for curse cards that require it.
 * Tap to roll — the result animates briefly then settles. Re-tap to
 * roll again. Stays compact so it can live alongside the hand panel
 * during the seeking phase without competing for attention.
 *
 * v970 (rulebook audit B): `count` rolls that many dice at once — the
 * Curse of the Jammed Door requires TWO d6 per doorway (rulebook p396),
 * so its card renders `count={2}` and the widget shows both dice plus
 * the total.
 */
export function DiceRoller({
    count = 1,
    onSettle,
    successFrom,
    disabled = false,
}: {
    /** How many d6 to roll together (default 1). */
    count?: number;
    /** Called with the final value once a roll settles — the single
     *  die's value for count=1, the SUM for count>1. Used by curses that
     *  map the roll to an effect (e.g. Spotty Memory → category). */
    onSettle?: (value: number) => void;
    /** v1032: when set, the roll is a PASS/FAIL check — a settled total ≥
     *  `successFrom` succeeds (green + pop), below fails (red + shake),
     *  reusing the cast-dice fizzle look. Used by Curse of the Jammed Door
     *  (roll 2d6, 7+ to enter). */
    successFrom?: number;
    /** Disable rolling (e.g. Jammed Door doorway on cooldown after a fail). */
    disabled?: boolean;
} = {}) {
    const dice = Math.max(1, Math.floor(count));
    const [values, setValues] = useState<number[] | null>(null);
    const [rolling, setRolling] = useState(false);

    const roll = () => {
        if (rolling || disabled) return;
        // v911: a short rattle-and-settle as the dice tumble.
        play("dice");
        setRolling(true);
        // Quick "tumble" — cycle through random values for ~400 ms
        // before settling, so the result feels earned.
        const start = Date.now();
        const tick = () => {
            const elapsed = Date.now() - start;
            const next = Array.from(
                { length: dice },
                () => 1 + Math.floor(Math.random() * 6),
            );
            setValues(next);
            if (elapsed < 400) {
                window.setTimeout(tick, 60);
            } else {
                setRolling(false);
                onSettle?.(next.reduce((a, b) => a + b, 0));
            }
        };
        tick();
    };

    const total = values?.reduce((a, b) => a + b, 0) ?? null;
    // Pass/fail outcome once settled (only when `successFrom` is set).
    const success =
        successFrom != null && total != null && !rolling
            ? total >= successFrom
            : null;
    const settledText =
        values === null
            ? dice > 1
                ? `Tap to roll ${dice} d6 when a curse card asks for it.`
                : "Tap to roll a d6 when a curse card asks for it."
            : rolling
              ? "Rolling…"
              : success === true
                ? `Rolled ${total} — you may enter!`
                : success === false
                  ? `Rolled ${total} — blocked.`
                  : dice > 1
                    ? `Rolled ${values.join(" + ")} = ${total}. Tap to roll again.`
                    : `Rolled ${total}. Tap to roll again.`;

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
                disabled={rolling || disabled}
                aria-label={dice > 1 ? `Roll ${dice} d6` : "Roll d6"}
                className={cn(
                    "shrink-0 flex items-center gap-1.5",
                    "disabled:cursor-not-allowed",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md",
                    // v1032: on a settled pass/fail, pop (success) or shake
                    // (fail) — the same cast-dice outcome animations.
                    success === true &&
                        "animate-[jlGoExplode_480ms_cubic-bezier(0.22,1.2,0.36,1)_both]",
                    success === false &&
                        "animate-[jlFizzleShake_520ms_ease-in-out_both]",
                )}
            >
                {(values ?? Array.from({ length: dice }, () => null)).map(
                    (v, i) => (
                        <span
                            key={i}
                            className={cn(
                                "w-12 h-12 rounded-md",
                                "bg-background border-2 flex items-center justify-center",
                                "font-inter-tight italic font-black text-2xl tabular-nums",
                                "transition-transform",
                                // Border + text follow the pass/fail outcome
                                // (green / red), else the neutral primary.
                                success === true
                                    ? "border-[hsl(150_55%_45%)] text-[hsl(150_55%_45%)]"
                                    : success === false
                                      ? "border-destructive text-destructive"
                                      : "border-primary text-primary",
                                rolling &&
                                    "animate-[jlDiceTumble_400ms_ease-out]",
                                !rolling &&
                                    !disabled &&
                                    "hover:scale-[1.05] active:scale-95",
                            )}
                        >
                            {v ?? <Dice5 className="w-6 h-6" />}
                        </span>
                    ),
                )}
            </button>
            <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                    {dice > 1 ? `Dice ×${dice}` : "Dice"}
                </div>
                <div className="text-xs text-foreground leading-snug mt-0.5">
                    {settledText}
                </div>
            </div>
        </div>
    );
}

export default DiceRoller;
