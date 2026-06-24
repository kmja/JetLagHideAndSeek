import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Wizard step indicator, styled to match the app's segmented control
 * (see `EditTabs` in GameSetupDialog — same rounded container, same coral
 * active segment). It reads as a non-interactive progress bar: the
 * current step is the solid coral segment, completed steps are a lighter
 * coral tint, upcoming steps are muted. Navigation stays on the wizard's
 * Back/Next buttons.
 */
export interface WizardStep {
    label: string;
    icon?: LucideIcon;
}

export function WizardStepper({
    steps,
    current,
    className,
}: {
    steps: WizardStep[];
    /** 1-based index of the active step. */
    current: number;
    className?: string;
}) {
    return (
        <div
            role="list"
            aria-label="Setup progress"
            className={cn(
                "flex gap-1 p-1 rounded-md",
                "bg-secondary/40 border border-border",
                className,
            )}
        >
            {steps.map((s, i) => {
                const n = i + 1;
                const state =
                    n < current ? "done" : n === current ? "active" : "todo";
                const Icon = s.icon;
                return (
                    <div
                        key={s.label}
                        role="listitem"
                        aria-current={state === "active" ? "step" : undefined}
                        className={cn(
                            "flex-1 min-w-0 flex items-center justify-center gap-1.5",
                            "px-2 py-1.5 rounded-sm transition-colors",
                            "text-[11px] font-poppins font-bold uppercase tracking-[0.10em]",
                            state === "active"
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : state === "done"
                                  ? "bg-primary/15 text-primary"
                                  : "text-muted-foreground",
                        )}
                    >
                        {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
                        <span className="truncate">{s.label}</span>
                    </div>
                );
            })}
        </div>
    );
}

export default WizardStepper;
