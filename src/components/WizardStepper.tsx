import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Wizard step indicator, styled as a header-scale segmented control: it
 * borrows `EditTabs`' rounded container + coral active segment, but sized
 * up to read as a proper section header (display font, header-weight type,
 * taller band) rather than a thin progress pill. The current step is the
 * solid coral segment, completed steps a lighter coral tint, upcoming
 * steps muted. Non-interactive — navigation stays on the wizard's
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
                "flex gap-1.5 p-1.5 rounded-lg",
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
                            "flex-1 min-w-0 flex items-center justify-center gap-2",
                            "px-2.5 py-3 rounded-md transition-colors",
                            "font-display font-black uppercase tracking-[0.04em]",
                            "text-[13px] sm:text-sm leading-none",
                            state === "active"
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : state === "done"
                                  ? "bg-primary/15 text-primary"
                                  : "text-muted-foreground",
                        )}
                    >
                        {Icon && (
                            <Icon className="w-[18px] h-[18px] shrink-0" />
                        )}
                        <span className="truncate">{s.label}</span>
                    </div>
                );
            })}
        </div>
    );
}

export default WizardStepper;
