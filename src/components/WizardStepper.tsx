import { cn } from "@/lib/utils";

/**
 * Numbered wizard stepper — the connected-circles header for multi-step
 * flows (the setup wizard). Adapted to the app's style: coral primary for
 * reached steps, muted outline for upcoming ones, the current step's
 * label bold. Display-only (navigation is via the wizard's Back/Next).
 *
 *   (1)──(2)──(3)
 *  Area  Transit  Size
 */
export function WizardStepper({
    steps,
    current,
    className,
}: {
    /** Short labels, one per step. */
    steps: string[];
    /** 1-based index of the active step. */
    current: number;
    className?: string;
}) {
    return (
        <div className={cn("flex items-start", className)} aria-hidden>
            {steps.map((label, i) => {
                const n = i + 1;
                const state =
                    n < current ? "done" : n === current ? "active" : "todo";
                const isFirst = i === 0;
                const isLast = i === steps.length - 1;
                const reached = state !== "todo"; // done or active
                return (
                    <div
                        key={label}
                        className="flex-1 flex flex-col items-center min-w-0"
                    >
                        <div className="flex items-center w-full">
                            {/* connector into this circle */}
                            <div
                                className={cn(
                                    "h-0.5 flex-1",
                                    isFirst
                                        ? "opacity-0"
                                        : reached
                                          ? "bg-primary"
                                          : "bg-border",
                                )}
                            />
                            <div
                                className={cn(
                                    "flex items-center justify-center shrink-0",
                                    "w-7 h-7 rounded-full border-2 text-xs font-poppins font-bold",
                                    "transition-colors",
                                    reached
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border bg-transparent text-muted-foreground",
                                )}
                            >
                                {n}
                            </div>
                            {/* connector out of this circle */}
                            <div
                                className={cn(
                                    "h-0.5 flex-1",
                                    isLast
                                        ? "opacity-0"
                                        : n < current
                                          ? "bg-primary"
                                          : "bg-border",
                                )}
                            />
                        </div>
                        <span
                            className={cn(
                                "mt-1.5 px-1 text-center leading-tight truncate max-w-full",
                                "text-[11px] font-poppins uppercase tracking-wide",
                                state === "active"
                                    ? "font-bold text-foreground"
                                    : state === "done"
                                      ? "font-semibold text-foreground/70"
                                      : "text-muted-foreground",
                            )}
                        >
                            {label}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

export default WizardStepper;
