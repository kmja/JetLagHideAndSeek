import { useStore } from "@nanostores/react";
import { Monitor, Moon, Sun } from "lucide-react";

import { themePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Three-button segmented control for the theme preference:
 * System (default) / Light / Dark. The selected button gets a primary
 * fill; the others are muted. Compact enough to live inline next to a
 * settings label without claiming a row of its own.
 */
const OPTIONS = [
    { value: "system", label: "Auto", icon: Monitor },
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
] as const;

export function ThemeToggle() {
    const $pref = useStore(themePreference);
    return (
        <div
            role="radiogroup"
            aria-label="Theme"
            className="inline-flex items-center rounded-md border border-border bg-secondary/40 p-0.5 gap-0.5"
        >
            {OPTIONS.map(({ value, label, icon: Icon }) => {
                const active = $pref === value;
                return (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={label}
                        onClick={() => themePreference.set(value)}
                        className={cn(
                            "inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-sm",
                            "text-[11px] font-poppins font-semibold uppercase tracking-wider",
                            "transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                    >
                        <Icon className="w-4 h-4 shrink-0" />
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

export default ThemeToggle;
