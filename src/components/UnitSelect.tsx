import type { Units } from "@/maps/schema";

import { cn } from "@/lib/utils";

/**
 * Three-segment unit picker. v272: replaced the upstream Select
 * dropdown — for three short labels the dropdown was overkill, and a
 * segmented control reads faster and saves one tap. Used everywhere
 * the seeker app exposes a units choice (Settings drawer, question
 * cards, wizard previews).
 */
const OPTIONS: { value: Units; label: string }[] = [
    { value: "miles", label: "Miles" },
    { value: "kilometers", label: "Kilometers" },
];

export const UnitSelect = ({
    unit,
    onChange,
    disabled,
}: {
    unit: Units;
    onChange: (unit: Units) => void;
    disabled?: boolean;
}) => {
    return (
        <div
            role="radiogroup"
            aria-label="Units"
            className={cn(
                "inline-flex items-center rounded-md border border-border bg-secondary/40 p-0.5 gap-0.5",
                disabled && "opacity-50 pointer-events-none",
            )}
        >
            {OPTIONS.map(({ value, label }) => {
                const active = unit === value;
                return (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => onChange(value)}
                        disabled={disabled}
                        className={cn(
                            "inline-flex items-center justify-center rounded-sm",
                            "h-8 px-2.5 text-[11px] font-poppins font-semibold uppercase tracking-wider",
                            "transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
};
