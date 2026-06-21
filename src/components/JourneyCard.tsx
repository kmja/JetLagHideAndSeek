import type { LucideIcon } from "lucide-react";
import {
    ArrowRight,
    Bus,
    Clock,
    Footprints,
    Loader2,
    MapPin,
    RefreshCw,
    Repeat,
    Ship,
    Train,
    TrainFront,
    TrainTrack,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Journey, JourneyLeg } from "@/lib/journey/plan";
import { cn } from "@/lib/utils";

/**
 * Render a single planned door-to-door journey, normalised by the
 * trip-plan worker into legs (walking + transit). Reused by both
 * sides:
 *
 *   • Hider: shown beneath the picker once `hidingZone` is
 *     committed — "to get to your zone, walk 3 min, ride T14 11
 *     min, walk 2 min."
 *   • Seeker: shown in the trip-planner sheet after picking a
 *     destination.
 *
 * The renderer is presentation-only — fetching, refreshing and
 * caching are the caller's job.
 */
export interface JourneyCardProps {
    journey: Journey | null;
    /** `"trafiklab"` / `"walking"` / etc. Walking-sourced journeys
     *  are flagged as estimates because there's no live schedule
     *  behind them. */
    source?: string;
    /** Loading flag — shows a centred spinner instead of the journey. */
    loading?: boolean;
    /** When set, an error pane with this message renders instead. */
    error?: string | null;
    /** Optional title shown above the journey. */
    title?: string;
    /** Optional refresh handler — adds a refresh button to the header. */
    onRefresh?: () => void;
    /** Optional class merged into the outer container. */
    className?: string;
}

const MODE_ICONS: Record<string, LucideIcon> = {
    walk: Footprints,
    bus: Bus,
    tram: TrainTrack,
    train: TrainFront,
    subway: Train,
    ferry: Ship,
    transit: Train,
};

const MODE_LABELS: Record<string, string> = {
    walk: "Walk",
    bus: "Bus",
    tram: "Tram",
    train: "Train",
    subway: "Subway",
    ferry: "Ferry",
    transit: "Transit",
};

export function JourneyCard({
    journey,
    source,
    loading,
    error,
    title,
    onRefresh,
    className,
}: JourneyCardProps) {
    return (
        <div
            className={cn(
                "rounded-sm border border-border bg-secondary/40 p-3 space-y-2",
                className,
            )}
        >
            {(title || onRefresh) && (
                <div className="flex items-center justify-between gap-2">
                    {title && (
                        <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            {title}
                        </div>
                    )}
                    {onRefresh && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={onRefresh}
                            className="gap-1.5 h-7 text-xs"
                            disabled={loading}
                            aria-label="Refresh journey"
                        >
                            <RefreshCw
                                className={cn(
                                    "w-3 h-3",
                                    loading && "animate-spin",
                                )}
                            />
                            Refresh
                        </Button>
                    )}
                </div>
            )}

            {loading && !journey && (
                <Pane>
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    <span>Planning your route…</span>
                </Pane>
            )}

            {error && !loading && (
                <Pane>
                    <p className="text-xs text-muted-foreground leading-snug">
                        {error}
                    </p>
                </Pane>
            )}

            {journey && !error && (
                <>
                    <JourneySummary journey={journey} source={source} />
                    <ol className="space-y-1.5">
                        {journey.legs.map((leg, i) => (
                            <li key={i}>
                                <LegRow leg={leg} />
                            </li>
                        ))}
                    </ol>
                </>
            )}
        </div>
    );
}

function JourneySummary({
    journey,
    source,
}: {
    journey: Journey;
    source?: string;
}) {
    const transitLegs = journey.legs.filter((l) => l.mode !== "walk").length;
    const walking = source === "walking";
    return (
        <div
            className={cn(
                "rounded-sm border border-border bg-background/60 p-2",
                "flex items-center gap-3 flex-wrap",
            )}
        >
            <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-primary" />
                <span className="text-sm font-inter-tight font-bold tabular-nums">
                    {journey.durationMin} min
                </span>
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
                {formatHHMM(journey.departAt)} → {formatHHMM(journey.arriveAt)}
            </div>
            {transitLegs > 0 && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Repeat className="w-3 h-3" />
                    <span>
                        {journey.transfers === 0
                            ? "no transfers"
                            : `${journey.transfers} transfer${journey.transfers === 1 ? "" : "s"}`}
                    </span>
                </div>
            )}
            {walking && (
                <span
                    className={cn(
                        "ml-auto inline-flex items-center px-1.5 py-0.5 rounded-sm",
                        "border border-yellow-400/60 text-[10px] font-poppins font-bold",
                        "text-yellow-700 dark:text-yellow-100 bg-background/40",
                    )}
                    title="No live schedule in this area; walking estimate only."
                >
                    Walking estimate
                </span>
            )}
        </div>
    );
}

function LegRow({ leg }: { leg: JourneyLeg }) {
    const Icon = MODE_ICONS[leg.mode] ?? Train;
    const modeLabel = MODE_LABELS[leg.mode] ?? "Transit";
    const durationMin = Math.max(
        1,
        Math.round((leg.arriveAt - leg.departAt) / 60_000),
    );
    return (
        <div
            className={cn(
                "flex items-center gap-2 px-2.5 py-2 rounded-sm",
                "bg-background/60 border border-border",
            )}
        >
            <span
                className={cn(
                    "inline-flex items-center justify-center w-7 h-7 rounded shrink-0",
                    leg.mode === "walk" ? "bg-secondary" : "bg-primary/20",
                )}
            >
                <Icon
                    className={cn(
                        "w-3.5 h-3.5",
                        leg.mode === "walk"
                            ? "text-muted-foreground"
                            : "text-primary",
                    )}
                />
            </span>
            <div className="min-w-0 flex-1">
                <div className="text-xs font-inter-tight font-bold leading-tight truncate">
                    {leg.line ?? modeLabel}
                    {leg.direction && (
                        <span className="font-normal text-muted-foreground">
                            {" "}
                            · {leg.direction}
                        </span>
                    )}
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums truncate flex items-center gap-1">
                    <MapPin className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{leg.from.name ?? "Start"}</span>
                    <ArrowRight className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{leg.to.name ?? "End"}</span>
                </div>
            </div>
            <div className="text-[10px] text-right shrink-0 tabular-nums">
                <div className="font-bold">{durationMin} min</div>
                <div className="text-muted-foreground">
                    {formatHHMM(leg.departAt)}
                </div>
            </div>
        </div>
    );
}

function Pane({ children }: { children: React.ReactNode }) {
    return (
        <div
            className={cn(
                "rounded-sm border border-border bg-background/60 p-3",
                "flex items-center gap-2 text-xs text-muted-foreground",
            )}
        >
            {children}
        </div>
    );
}

function formatHHMM(unixMs: number): string {
    const d = new Date(unixMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default JourneyCard;
