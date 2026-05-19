import { useStore } from "@nanostores/react";
import {
    Bus,
    Check,
    ChevronLeft,
    Footprints,
    MapPin,
    Ship,
    Train,
    TramFront,
    TrainTrack,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { leafletMapContext, mapGeoLocation } from "@/lib/context";
import {
    allowedTransit,
    gameSize,
    hidingPeriodEndsAt,
    HIDING_PERIOD_MINUTES,
    playArea,
    SIZE_DESCRIPTIONS,
    setupCompleted,
    setupDialogOpen,
    TRANSIT_LABELS,
    type GameSize,
    type TransitMode,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import { forwardGeocodeOne } from "@/maps/api";

/**
 * Three-step game setup. Auto-opens on first load (setupCompleted=false)
 * and via the "New game" action in the bottom nav.
 *
 * On finish, the dialog writes:
 *   - playArea + centers the Leaflet map
 *   - allowedTransit
 *   - gameSize
 *   - hidingPeriodEndsAt (timestamp = now + HIDING_PERIOD_MINUTES[size])
 *   - setupCompleted = true
 *
 * The hiding period kicks off immediately on "Start" — the countdown
 * lives in the BottomNav's Game button + a banner overlay.
 */
export function GameSetupDialog() {
    const $open = useStore(setupDialogOpen);
    const $playArea = useStore(playArea);
    const $allowedTransit = useStore(allowedTransit);
    const $gameSize = useStore(gameSize);

    useEffect(() => {
        if (!setupCompleted.get()) setupDialogOpen.set(true);
    }, []);

    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [draftArea, setDraftArea] = useState(
        $playArea ?? { displayName: "", lat: 0, lng: 0 },
    );
    const [draftTransit, setDraftTransit] =
        useState<TransitMode[]>($allowedTransit);
    const [draftSize, setDraftSize] = useState<GameSize>($gameSize);

    useEffect(() => {
        if ($open) {
            setStep(1);
            setDraftArea(
                playArea.get() ?? { displayName: "", lat: 0, lng: 0 },
            );
            setDraftTransit(allowedTransit.get());
            setDraftSize(gameSize.get());
        }
    }, [$open]);

    const handleFinish = () => {
        playArea.set(draftArea.displayName ? draftArea : null);
        allowedTransit.set(draftTransit);
        gameSize.set(draftSize);

        // Kick off the hiding period. End time = now + duration for this size.
        const minutes = HIDING_PERIOD_MINUTES[draftSize];
        hidingPeriodEndsAt.set(Date.now() + minutes * 60_000);

        // Center map on the chosen play area.
        if (draftArea.displayName && draftArea.lat && draftArea.lng) {
            const map = leafletMapContext.get();
            map?.flyTo([draftArea.lat, draftArea.lng], 11, { duration: 0.6 });
            mapGeoLocation.set({
                geometry: {
                    type: "Point",
                    coordinates: [draftArea.lat, draftArea.lng],
                },
                properties: {
                    name: draftArea.displayName,
                    osm_id: 0,
                    osm_type: "R",
                    extent: undefined,
                },
                type: "Feature",
            } as any);
        }

        setupCompleted.set(true);
        setupDialogOpen.set(false);
        toast.success(
            `Hiding period started — ${minutes} minutes. Good luck!`,
            { autoClose: 3000 },
        );
    };

    const canContinue =
        step === 1
            ? Boolean(draftArea.displayName)
            : step === 2
              ? draftTransit.length > 0
              : true;

    return (
        <Dialog
            open={$open}
            onOpenChange={(o) => {
                if (!o && !setupCompleted.get()) return;
                setupDialogOpen.set(o);
            }}
        >
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0",
                )}
            >
                <div className="px-6 pt-6 pb-3 shrink-0 border-b border-border">
                    <DialogTitle>
                        {step === 1 && "Where are you playing?"}
                        {step === 2 && "What transit is allowed?"}
                        {step === 3 && "How big is the game?"}
                    </DialogTitle>
                    <DialogDescription>Step {step} of 3</DialogDescription>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
                    {step === 1 && (
                        <PlayAreaStep
                            value={draftArea}
                            onChange={setDraftArea}
                        />
                    )}
                    {step === 2 && (
                        <TransitStep
                            value={draftTransit}
                            onChange={setDraftTransit}
                        />
                    )}
                    {step === 3 && (
                        <SizeStep value={draftSize} onChange={setDraftSize} />
                    )}
                </div>

                <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-between">
                    <Button
                        variant="outline"
                        onClick={() =>
                            setStep((s) =>
                                s > 1 ? ((s - 1) as 1 | 2 | 3) : s,
                            )
                        }
                        disabled={step === 1}
                        className="gap-1"
                    >
                        <ChevronLeft className="w-4 h-4" />
                        Back
                    </Button>
                    {step < 3 ? (
                        <Button
                            disabled={!canContinue}
                            onClick={() =>
                                setStep((s) => ((s + 1) as 1 | 2 | 3))
                            }
                        >
                            Continue
                        </Button>
                    ) : (
                        <Button onClick={handleFinish} className="gap-1">
                            <Check className="w-4 h-4" />
                            Start {HIDING_PERIOD_MINUTES[draftSize]}-min hiding
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ─── Step 1 — Play area ─── */

function PlayAreaStep({
    value,
    onChange,
}: {
    value: { displayName: string; lat: number; lng: number };
    onChange: (v: { displayName: string; lat: number; lng: number }) => void;
}) {
    const [query, setQuery] = useState(value.displayName);
    const [busy, setBusy] = useState(false);

    const doSearch = async () => {
        if (!query.trim()) return;
        setBusy(true);
        const result = await forwardGeocodeOne(query);
        setBusy(false);
        if (!result) {
            toast.error("Couldn't find that place. Try a city or region.");
            return;
        }
        onChange({
            displayName: result.displayName,
            lat: result.lat,
            lng: result.lng,
        });
    };

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Pick the city or region you'll be playing in. The map will
                center here.
            </p>
            <div className="flex gap-2">
                <Input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g. Stockholm, Tokyo, London"
                    className="text-base"
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            doSearch();
                        }
                    }}
                />
                <Button onClick={doSearch} disabled={busy || !query.trim()}>
                    {busy ? "…" : "Search"}
                </Button>
            </div>
            {value.displayName && value.lat !== 0 && (
                <div className="p-3 rounded-md bg-secondary/30 border border-border">
                    <div className="flex items-start gap-2">
                        <MapPin className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                        <div className="min-w-0">
                            <div className="text-sm font-medium truncate">
                                {value.displayName.split(",")[0]}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                                {value.displayName}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/* ─── Step 2 — Transit ─── */

const TRANSIT_ICONS: Record<TransitMode, typeof Bus> = {
    bus: Bus,
    tram: TramFront,
    train: Train,
    subway: TrainTrack,
    ferry: Ship,
};

function TransitStep({
    value,
    onChange,
}: {
    value: TransitMode[];
    onChange: (v: TransitMode[]) => void;
}) {
    const ALL: TransitMode[] = ["bus", "tram", "train", "subway", "ferry"];
    const toggle = (mode: TransitMode) => {
        const has = value.includes(mode);
        onChange(has ? value.filter((m) => m !== mode) : [...value, mode]);
    };
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Pick public-transit modes the hider can use. Walking is
                always allowed.{" "}
                <span className="text-foreground/70">
                    Bus is off by default — adding it dramatically expands
                    the search space.
                </span>
            </p>
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-secondary/40 border border-border">
                <Footprints className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">Walking</span>
                <span className="text-xs text-muted-foreground ml-auto">
                    always on
                </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ALL.map((mode) => {
                    const Icon = TRANSIT_ICONS[mode];
                    const active = value.includes(mode);
                    return (
                        <button
                            key={mode}
                            type="button"
                            onClick={() => toggle(mode)}
                            className={cn(
                                "flex flex-col items-center gap-1.5 p-3 rounded-md",
                                "border-2 transition-all",
                                active
                                    ? "bg-primary/10 border-primary text-foreground"
                                    : "bg-secondary border-border text-muted-foreground hover:bg-accent",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <Icon
                                size={22}
                                strokeWidth={2}
                                className={active ? "text-primary" : ""}
                            />
                            <span className="font-poppins text-xs font-semibold">
                                {TRANSIT_LABELS[mode]}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/* ─── Step 3 — Game size ─── */

function SizeStep({
    value,
    onChange,
}: {
    value: GameSize;
    onChange: (v: GameSize) => void;
}) {
    const SIZES: GameSize[] = ["small", "medium", "large"];
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Larger games span more ground and start with a longer
                hiding period.
            </p>
            <div className="space-y-2">
                {SIZES.map((size) => {
                    const meta = SIZE_DESCRIPTIONS[size];
                    const active = size === value;
                    return (
                        <button
                            key={size}
                            type="button"
                            onClick={() => onChange(size)}
                            className={cn(
                                "w-full text-left p-4 rounded-md",
                                "border-2 transition-all",
                                active
                                    ? "bg-primary/10 border-primary"
                                    : "bg-secondary border-border hover:bg-accent",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="font-poppins font-semibold text-lg capitalize">
                                    {size}
                                </span>
                                <span className="text-sm text-muted-foreground tabular-nums">
                                    {HIDING_PERIOD_MINUTES[size]} min hiding
                                </span>
                            </div>
                            <p className="text-sm text-foreground/80 mt-1">
                                {meta.spans}; lasts {meta.lasts}.
                            </p>
                            <p className="text-xs text-muted-foreground mt-1 italic">
                                Examples: {meta.examples}
                            </p>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
