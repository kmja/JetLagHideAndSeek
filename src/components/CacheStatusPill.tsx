import { useStore } from "@nanostores/react";
import { AlertCircle, CheckCircle2, Database, Loader2 } from "lucide-react";
import { useState } from "react";

import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { setupCompleted } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import { prefetchStatus } from "@/maps/api/playAreaPrefetch";

/**
 * Small floating chip that surfaces the play-area Overpass cache's
 * live state — the per-category prefetch warmed during the hiding
 * period and consulted on every matching / measuring question.
 *
 * Visible the moment setup is done. The face shows a compact
 * `warm / total` ratio with an icon that reflects the dominant
 * state:
 *
 *   - spinner ↻ : at least one prefetch is in flight
 *   - green ✓   : every standard family has at least one cache
 *                 entry (could be 0 features — "this play area has
 *                 no hospitals" still counts as resolved)
 *   - amber ⚠   : some families failed and won't auto-retry until
 *                 the player taps that question
 *   - grey  ◌  : nothing's been touched yet (pre-setup or pre-
 *                 first-prefetch)
 *
 * Tapping the chip expands a popover with per-family detail and a
 * "what does this mean" line, so the seeker can confirm "yes, the
 * museum query is warm — it won't hit the network."
 */
export function CacheStatusPill({ className }: { className?: string }) {
    const $setup = useStore(setupCompleted);
    const $status = useStore(prefetchStatus);
    const [open, setOpen] = useState(false);

    if (!$setup) return null;

    const { warmed, total, failed, inFlight, features } = $status;
    const ratio = total > 0 ? `${warmed}/${total}` : "—";
    const allWarm = total > 0 && warmed === total && failed === 0;
    const someFailed = failed > 0 && inFlight === 0;
    const idle = warmed === 0 && inFlight === 0 && failed === 0;

    let face: "spin" | "warm" | "fail" | "idle";
    if (inFlight > 0) face = "spin";
    else if (allWarm) face = "warm";
    else if (someFailed) face = "fail";
    else face = idle ? "idle" : "spin";

    const Icon =
        face === "spin"
            ? Loader2
            : face === "warm"
              ? CheckCircle2
              : face === "fail"
                ? AlertCircle
                : Database;
    const iconCls = cn(
        "w-3.5 h-3.5 shrink-0",
        face === "spin" && "animate-spin text-primary",
        face === "warm" && "text-green-400",
        face === "fail" && "text-yellow-400",
        face === "idle" && "text-muted-foreground",
    );

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "h-7 px-2.5 rounded-full inline-flex items-center gap-1.5",
                        "bg-background/85 backdrop-blur-sm border border-border",
                        "text-[11px] font-poppins font-semibold leading-none",
                        "shadow-sm hover:bg-background transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        className,
                    )}
                    title="Tap for per-category cache detail"
                    aria-label={`Cache status ${ratio}`}
                >
                    <Icon className={iconCls} />
                    <span className="text-foreground tabular-nums">{ratio}</span>
                    {features > 0 && (
                        <span className="text-muted-foreground tabular-nums">
                            · {features}
                        </span>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent
                side="bottom"
                align="end"
                className="w-72 p-3 z-[1060]"
            >
                <Header
                    inFlight={inFlight}
                    warmed={warmed}
                    failed={failed}
                    total={total}
                    features={features}
                />
                <FamilyList status={$status} />
                <p className="mt-3 text-[10px] text-muted-foreground leading-snug">
                    Cached categories resolve from memory — no Overpass
                    round trip. A failed row just means the lazy fetch
                    will retry next time you tap that subtype.
                </p>
            </PopoverContent>
        </Popover>
    );
}

function Header({
    inFlight,
    warmed,
    failed,
    total,
    features,
}: {
    inFlight: number;
    warmed: number;
    failed: number;
    total: number;
    features: number;
}) {
    return (
        <div className="space-y-1 mb-3">
            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                Play-area cache
            </div>
            <div className="text-sm font-semibold text-foreground">
                {warmed} of {total} categories warm
                {features > 0 && (
                    <span className="text-muted-foreground font-normal">
                        {" "}
                        · {features} places
                    </span>
                )}
            </div>
            {(inFlight > 0 || failed > 0) && (
                <div className="text-[11px] text-muted-foreground">
                    {inFlight > 0 && (
                        <span className="inline-flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            {inFlight} in flight
                        </span>
                    )}
                    {inFlight > 0 && failed > 0 && <span> · </span>}
                    {failed > 0 && (
                        <span className="text-yellow-400">
                            {failed} failed (will retry)
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

function FamilyList({
    status,
}: {
    status: ReturnType<typeof prefetchStatus.get>;
}) {
    const entries = Object.entries(status.perFamily).sort(([a], [b]) =>
        a.localeCompare(b),
    );
    if (entries.length === 0) {
        return (
            <div className="text-xs text-muted-foreground italic">
                Warm-up hasn&apos;t started yet — kicks off when the hiding
                period starts.
            </div>
        );
    }
    return (
        <div className="max-h-56 overflow-y-auto -mx-1 px-1">
            <ul className="space-y-0.5">
                {entries.map(([key, value]) => (
                    <li
                        key={key}
                        className={cn(
                            "flex items-center justify-between gap-2",
                            "py-1 text-xs font-mono",
                        )}
                    >
                        <span className="truncate text-foreground/90">
                            {prettifyFamilyKey(key)}
                        </span>
                        <span
                            className={cn(
                                "tabular-nums text-[11px]",
                                value.state === "warm" &&
                                    "text-green-400",
                                value.state === "in-flight" &&
                                    "text-primary",
                                value.state === "failed" &&
                                    "text-yellow-400",
                            )}
                        >
                            {value.state === "warm" && `${value.count}`}
                            {value.state === "in-flight" && "…"}
                            {value.state === "failed" && "fail"}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** "api:hospital" → "hospital", "brand:Q38076" → "brand Q38076". */
function prettifyFamilyKey(key: string): string {
    if (key.startsWith("api:")) return key.slice(4);
    if (key.startsWith("brand:")) return `brand ${key.slice(6)}`;
    return key;
}

export default CacheStatusPill;
