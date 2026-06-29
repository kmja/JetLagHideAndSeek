import { useStore } from "@nanostores/react";

import { Checkbox } from "@/components/ui/checkbox";
import {
    alternateQuestionTypes,
    askOncePerQuestion,
    zoneRadiusBuffer,
} from "@/lib/houseRules";
import { cn } from "@/lib/utils";

/**
 * "House rules" — opt-in deviations from the printed Hide + Seek
 * rulebook, surfaced in the Settings drawer. Defaults match the
 * rulebook; turning a toggle on locks the table to a stricter house
 * variant for the rest of the game.
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
export function HouseRulesSection() {
    const $alternate = useStore(alternateQuestionTypes);
    const $askOnce = useStore(askOncePerQuestion);
    const $zoneBuffer = useStore(zoneRadiusBuffer);

    return (
        <div className="pt-3 mt-3 border-t border-border">
            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground mb-2">
                House rules
            </div>
            <p className="text-xs text-muted-foreground mb-3 leading-snug">
                Deviations from the printed rulebook. Defaults follow the
                rulebook.
            </p>
            <div className="space-y-3">
                <Row
                    label="Alternate question categories"
                    description="You can't ask two questions of the same category in a row."
                    rulebookDefault="No alternation (rulebook)"
                    checked={$alternate}
                    onChange={(v) => alternateQuestionTypes.set(v)}
                />
                <Row
                    label="Ask once per question"
                    description="Each subtype / preset can only be asked once per game. Hard block instead of paying the rulebook's repeat cost."
                    rulebookDefault="Repeats allowed at N× cost (p65)"
                    checked={$askOnce}
                    onChange={(v) => askOncePerQuestion.set(v)}
                />
                <Row
                    label="Buffer eliminations by zone radius"
                    description="Radar, thermometer and measuring eliminate at the zone level, widened by your hiding-zone radius — so a moving hider can never get their true zone carved away by unlucky question timing."
                    rulebookDefault="Exact-point cuts (rulebook p234)"
                    checked={$zoneBuffer}
                    onChange={(v) => zoneRadiusBuffer.set(v)}
                />
            </div>
        </div>
    );
}

function Row({
    label,
    description,
    rulebookDefault,
    checked,
    onChange,
}: {
    label: string;
    description: string;
    rulebookDefault: string;
    checked: boolean;
    onChange: (next: boolean) => void;
}) {
    return (
        <label
            className={cn(
                "flex items-start gap-3 cursor-pointer select-none",
                "rounded-md border border-border px-3 py-2.5",
                "hover:bg-accent/40 transition-colors",
            )}
        >
            <Checkbox
                checked={checked}
                onCheckedChange={(v) => onChange(v === true)}
                className="mt-0.5 shrink-0"
            />
            <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold leading-tight">
                    {label}
                </span>
                <span className="block text-xs text-muted-foreground leading-snug mt-0.5">
                    {description}
                </span>
                {!checked && (
                    <span className="block text-[10px] uppercase tracking-[0.12em] font-poppins font-bold text-muted-foreground/80 mt-1">
                        Currently: {rulebookDefault}
                    </span>
                )}
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
