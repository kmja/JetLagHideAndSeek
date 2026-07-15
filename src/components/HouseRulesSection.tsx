import { useStore } from "@nanostores/react";
import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import type { WritableAtom } from "nanostores";

import { Checkbox } from "@/components/ui/checkbox";
import {
    alternateQuestionTypes,
    askOncePerQuestion,
    zoneRadiusBuffer,
} from "@/lib/houseRules";
import { cn } from "@/lib/utils";

/**
 * "House rules" — opt-in deviations from the printed Hide + Seek
 * rulebook, surfaced in the lobby (host-authoritative, synced to the
 * room). Defaults match the rulebook; turning a toggle on locks the
 * table to a stricter house variant for the rest of the game.
 *
 * Only ACTIVE (enabled) rules show by default; the inactive ones are
 * collapsed behind an "Add a house rule" expander so the section stays
 * compact when the table plays vanilla. A read-only viewer (a non-host
 * guest) never sees the expander — just the active rules, and nothing
 * at all (the whole section unmounts) when none are on.
 *
 * Persistent atoms live in `src/lib/houseRules.ts`.
 *
 * Today's toggles:
 *   • Alternate question types — re-enables the old v395 alternation
 *     gate (no two same-category questions back-to-back). Off by
 *     default because the rulebook places no such constraint.
 *   • Ask once per question — hard-blocks repeat asks. Off by default
 *     because the rulebook explicitly allows repeats at N× cost
 *     (p65). Some tables prefer the variety-forcing block.
 *   • Buffer eliminations by zone radius — widens radar/thermometer/
 *     measuring cuts by the hiding-zone radius so a roaming hider's true
 *     zone can't be eliminated by unlucky answer timing. Off by default
 *     because the rulebook scopes these to the hider's exact point (p234).
 */
export function HouseRulesSection({
    readOnly = false,
    onAfterChange,
}: {
    /** Render the toggles disabled (e.g. a non-host in the lobby — only
     *  the host edits the table's rules). */
    readOnly?: boolean;
    /** Called after a toggle flips, so the lobby can push the change to
     *  peers via `hostPushSetup`. Omitted in solo / settings contexts. */
    onAfterChange?: () => void;
} = {}) {
    const $alternate = useStore(alternateQuestionTypes);
    const $askOnce = useStore(askOncePerQuestion);
    const $zoneBuffer = useStore(zoneRadiusBuffer);
    const [showInactive, setShowInactive] = useState(false);

    const set = (atom: WritableAtom<boolean>, v: boolean) => {
        atom.set(v);
        onAfterChange?.();
    };

    const rules: {
        atom: WritableAtom<boolean>;
        checked: boolean;
        label: string;
        description: string;
    }[] = [
        {
            atom: alternateQuestionTypes,
            checked: $alternate,
            label: "Alternate question categories",
            description:
                "You can't ask two questions of the same category in a row.",
        },
        {
            atom: askOncePerQuestion,
            checked: $askOnce,
            label: "Ask once per question",
            description: "Each question can only be asked once per game.",
        },
        {
            atom: zoneRadiusBuffer,
            checked: $zoneBuffer,
            label: "Buffer eliminations by zone radius",
            description:
                "Add a little extra margin when eliminating areas of the map. This will ensure a hiding zone is never falsely eliminated.",
        },
    ];

    const active = rules.filter((r) => r.checked);
    const inactive = rules.filter((r) => !r.checked);
    // Active rules always show. Inactive ones stay collapsed; only an
    // editor can expand to enable more (a read-only guest can't toggle
    // anything, so the rulebook defaults are noise for them).
    const expandable = !readOnly && inactive.length > 0;
    const visible = showInactive ? rules : active;

    // Nothing to say when no rules are active: a read-only viewer sees
    // nothing at all, and an editor just gets the "add a rule" expander
    // (no "playing by the rulebook" note — that's the implicit default).
    if (readOnly && active.length === 0) return null;

    return (
        <div>
            {/* Section subheader — matches the lobby's Game settings / Players
                headers (v857). */}
            <h3 className="text-sm uppercase tracking-[0.12em] font-display font-extrabold text-muted-foreground mb-2">
                House rules
            </h3>

            {visible.length > 0 && (
                <p className="text-sm text-muted-foreground mb-3 leading-snug">
                    Deviations from the printed rulebook.
                    {readOnly && " The host sets these for the whole table."}
                </p>
            )}

            {visible.length > 0 && (
                <div className="space-y-3">
                    {visible.map((r) => (
                        <Row
                            key={r.label}
                            label={r.label}
                            description={r.description}
                            checked={r.checked}
                            readOnly={readOnly}
                            onChange={(v) => set(r.atom, v)}
                        />
                    ))}
                </div>
            )}

            {expandable && (
                <button
                    type="button"
                    onClick={() => setShowInactive((s) => !s)}
                    className={cn(
                        "mt-3 inline-flex items-center gap-1.5 text-sm font-poppins font-semibold",
                        "text-muted-foreground hover:text-foreground transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
                    )}
                >
                    {showInactive ? (
                        <>
                            <ChevronDown className="w-4 h-4 rotate-180 transition-transform" />
                            Hide rulebook defaults
                        </>
                    ) : (
                        <>
                            <Plus className="w-4 h-4" />
                            {active.length > 0
                                ? `Add another house rule (${inactive.length})`
                                : "Add a house rule"}
                        </>
                    )}
                </button>
            )}
        </div>
    );
}

function Row({
    label,
    description,
    checked,
    onChange,
    readOnly = false,
}: {
    label: string;
    description: string;
    checked: boolean;
    onChange: (next: boolean) => void;
    readOnly?: boolean;
}) {
    return (
        <label
            className={cn(
                "flex items-start gap-3 select-none",
                "rounded-md border border-border px-3 py-2.5",
                readOnly
                    ? "cursor-default opacity-90"
                    : "cursor-pointer hover:bg-accent/40 transition-colors",
            )}
        >
            <Checkbox
                checked={checked}
                disabled={readOnly}
                onCheckedChange={(v) => !readOnly && onChange(v === true)}
                className="mt-0.5 shrink-0"
            />
            <span className="flex-1 min-w-0">
                <span className="block text-base font-semibold leading-tight">
                    {label}
                </span>
                <span className="block text-sm text-muted-foreground leading-snug mt-0.5">
                    {description}
                </span>
                {checked && (
                    <span className="block text-[10px] uppercase tracking-[0.12em] font-poppins font-bold text-yellow-500 mt-1">
                        House rule active
                    </span>
                )}
            </span>
        </label>
    );
}

export default HouseRulesSection;
