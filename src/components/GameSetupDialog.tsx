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
import { useEffect, useRef, useState } from "react";
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
import { useDebounce } from "@/hooks/useDebounce";
import {
    additionalMapGeoLocations,
    disabledStations,
    displayHidingZones,
    hiderMode,
    leafletMapContext,
    mapGeoJSON,
    mapGeoLocation,
    permanentOverlay,
    polyGeoJSON,
    questions,
} from "@/lib/context";
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
import { determineName, geocode, type OpenStreetMap } from "@/maps/api";

import {
    HideSeekMark,
    HideSeekWordmark,
    SectionPill,
    SizeBadge,
} from "./JetLagLogo";

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

/**
 * Infer a recommended GameSize from an OSM relation's bounding-box area.
 *
 * Rulebook (p9) maps area to game size:
 *   - Small:  25 – 250 km²    (town / small city / portion of a metro)
 *   - Medium: 250 – 2,500 km² (major city / metro / region)
 *   - Large:  2,500+ km²      (large region / country / multiple countries)
 *
 * The extent on each OSM feature is stored as `[maxLat, minLng, minLat, maxLng]`
 * after `geocode.ts` swaps Photon's native ordering. We approximate area
 * with the flat-earth formula `Δlat * Δlng·cos(midLat) * 111²` — accurate
 * enough for bucketing across three orders of magnitude.
 */
function inferGameSize(feature: OpenStreetMap): GameSize | null {
    const extent = feature.properties.extent;
    if (!extent || extent.length < 4) return null;
    const [maxLat, minLng, minLat, maxLng] = extent;
    if (
        typeof maxLat !== "number" ||
        typeof minLat !== "number" ||
        typeof minLng !== "number" ||
        typeof maxLng !== "number"
    ) {
        return null;
    }
    const midLat = (maxLat + minLat) / 2;
    const latSpanKm = Math.abs(maxLat - minLat) * 111;
    const lngSpanKm =
        Math.abs(maxLng - minLng) * 111 * Math.cos((midLat * Math.PI) / 180);
    const areaKm2 = latSpanKm * lngSpanKm;
    if (!Number.isFinite(areaKm2) || areaKm2 <= 0) return null;
    if (areaKm2 < 250) return "small";
    if (areaKm2 < 2500) return "medium";
    return "large";
}

export function GameSetupDialog() {
    const $open = useStore(setupDialogOpen);
    const $allowedTransit = useStore(allowedTransit);
    const $gameSize = useStore(gameSize);
    const $setupCompleted = useStore(setupCompleted);

    useEffect(() => {
        if (!setupCompleted.get()) setupDialogOpen.set(true);
    }, []);

    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [draftFeature, setDraftFeature] = useState<OpenStreetMap | null>(
        null,
    );
    const [draftTransit, setDraftTransit] =
        useState<TransitMode[]>($allowedTransit);
    const [draftSize, setDraftSize] = useState<GameSize>($gameSize);
    // Track whether the user has overridden the size manually. As soon
    // as they tap a size tile, we stop auto-inferring from the play area.
    const [sizeManuallySet, setSizeManuallySet] = useState(false);

    // Whenever the selected play area changes (and the user hasn't yet
    // picked a size by hand), infer the recommended game size from the
    // OSM extent's approximate area, per the rulebook's S/M/L bands.
    useEffect(() => {
        if (sizeManuallySet || !draftFeature) return;
        const inferred = inferGameSize(draftFeature);
        if (inferred) setDraftSize(inferred);
    }, [draftFeature, sizeManuallySet]);

    // Wrap setDraftSize so any tile tap also flips the override flag.
    const setDraftSizeManual = (s: GameSize) => {
        setSizeManuallySet(true);
        setDraftSize(s);
    };

    // Wizard mode = first-time setup or "New game" (setupCompleted=false).
    // Edit mode  = user opened this from "Edit settings" with an active game.
    // In edit mode we show all three sections in a single scroll and skip
    // the hiding-period restart on save.
    const isEditMode = $setupCompleted;

    useEffect(() => {
        if ($open) {
            setStep(1);
            setDraftFeature(null);
            setDraftTransit(allowedTransit.get());
            setDraftSize(gameSize.get());
            // Reset auto-infer flag for the new session. In edit mode we
            // assume the existing size is intentional and don't override.
            setSizeManuallySet(setupCompleted.get());
        }
    }, [$open]);

    const handleSaveEdits = () => {
        // Apply transit + size live, no hiding-period restart.
        allowedTransit.set(draftTransit);
        gameSize.set(draftSize);

        // Play area: only commit if the user picked a new one; leave the
        // existing area alone otherwise so transit/size tweaks don't force
        // a re-pick. If the user did change it, also wipe questions/zone
        // caches the same way handleFinish does — because changing play
        // area mid-game means questions are no longer geographically valid.
        if (draftFeature) {
            const coords = draftFeature.geometry.coordinates as number[];
            const [lat, lng] = coords;
            playArea.set({
                displayName: determineName(draftFeature),
                lat,
                lng,
            });
            mapGeoLocation.set(draftFeature);
            questions.set([]);
            additionalMapGeoLocations.set([]);
            mapGeoJSON.set(null);
            polyGeoJSON.set(null);
            disabledStations.set([]);
            permanentOverlay.set(null);
            const map = leafletMapContext.get();
            map?.flyTo([lat, lng], 11, { duration: 0.6 });
            toast.info("Play area updated — questions cleared.", {
                autoClose: 3000,
            });
        } else {
            toast.success("Settings saved.", { autoClose: 2000 });
        }
        setupDialogOpen.set(false);
    };

    const handleFinish = () => {
        allowedTransit.set(draftTransit);
        gameSize.set(draftSize);

        // Kick off the hiding period. End time = now + duration for this size.
        const minutes = HIDING_PERIOD_MINUTES[draftSize];
        hidingPeriodEndsAt.set(Date.now() + minutes * 60_000);

        if (draftFeature) {
            const coords = draftFeature.geometry.coordinates as number[];
            const [lat, lng] = coords;
            const displayName = determineName(draftFeature);

            playArea.set({ displayName, lat, lng });

            // Write the real OSM relation so the map can resolve a boundary
            // polygon for it via Overpass (osm_id=0 was the bug — there's no
            // such relation, so no boundary was ever fetched and the entire
            // world stayed "in play").
            mapGeoLocation.set(draftFeature);

            // Fresh game: wipe everything tied to a previous session so the
            // seeker starts from a blank slate inside the new region. Settings
            // (tile layer, units, API keys, etc.) are intentionally preserved.
            questions.set([]);
            additionalMapGeoLocations.set([]);
            mapGeoJSON.set(null);
            polyGeoJSON.set(null);
            disabledStations.set([]);
            permanentOverlay.set(null);
            hiderMode.set(false);
            // Default: hide the hiding-zones overlay on a fresh game. The
            // zones themselves still pre-load in the background (see
            // ZoneSidebar's initializeHidingZones), so toggling the overlay
            // on from the map controls is near-instant.
            displayHidingZones.set(false);

            const map = leafletMapContext.get();
            map?.flyTo([lat, lng], 11, { duration: 0.6 });
        } else {
            playArea.set(null);
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
            ? draftFeature !== null
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
                    "flex flex-col p-0 gap-0 max-h-[90vh]",
                )}
            >
                {isEditMode ? (
                    <>
                        <div className="px-6 pt-5 pb-4 shrink-0 border-b border-border">
                            <div className="mb-3 flex items-center gap-3">
                                <HideSeekMark size={36} onDark />
                                <HideSeekWordmark />
                                <SectionPill className="ml-auto">
                                    Edit
                                </SectionPill>
                            </div>
                            <DialogTitle className="font-inter-tight font-black uppercase text-2xl tracking-tight leading-tight">
                                Game settings
                            </DialogTitle>
                            <DialogDescription className="mt-2 text-sm">
                                Transit and size apply immediately. Changing
                                the play area clears all questions.
                            </DialogDescription>
                        </div>

                        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-6">
                            <section className="space-y-3">
                                <SectionPill>Play area</SectionPill>
                                <PlayAreaStep
                                    value={draftFeature}
                                    onChange={setDraftFeature}
                                />
                            </section>
                            <section className="space-y-3">
                                <SectionPill>Transit</SectionPill>
                                <TransitStep
                                    value={draftTransit}
                                    onChange={setDraftTransit}
                                />
                            </section>
                            <section className="space-y-3">
                                <SectionPill>Size</SectionPill>
                                <SizeStep
                                    value={draftSize}
                                    onChange={setDraftSizeManual}
                                />
                            </section>
                        </div>

                        <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-end">
                            <Button
                                variant="outline"
                                onClick={() => setupDialogOpen.set(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={handleSaveEdits}
                                className="gap-1"
                            >
                                <Check className="w-4 h-4" />
                                Save changes
                            </Button>
                        </DialogFooter>
                    </>
                ) : (
                    <>
                        <div className="px-6 pt-5 pb-4 shrink-0 border-b border-border">
                            <div className="mb-3 flex items-center gap-3">
                                <HideSeekMark size={36} onDark />
                                <HideSeekWordmark />
                                <SectionPill className="ml-auto">
                                    Step {step} / 3
                                </SectionPill>
                            </div>
                            <DialogTitle className="font-inter-tight font-black uppercase text-2xl tracking-tight leading-tight">
                                {step === 1 && "Where are you playing?"}
                                {step === 2 && "What transit is allowed?"}
                                {step === 3 && "How big is the game?"}
                            </DialogTitle>
                            <DialogDescription className="mt-2 text-sm">
                                {step === 1 &&
                                    "Pick the city or region you'll be seeking in."}
                                {step === 2 &&
                                    "Which public transit modes the hider can use."}
                                {step === 3 &&
                                    "Larger games span more ground and last longer."}
                            </DialogDescription>
                        </div>

                        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
                            {step === 1 && (
                                <PlayAreaStep
                                    value={draftFeature}
                                    onChange={setDraftFeature}
                                />
                            )}
                            {step === 2 && (
                                <TransitStep
                                    value={draftTransit}
                                    onChange={setDraftTransit}
                                />
                            )}
                            {step === 3 && (
                                <SizeStep
                                    value={draftSize}
                                    onChange={setDraftSizeManual}
                                />
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
                                        setStep(
                                            (s) => ((s + 1) as 1 | 2 | 3),
                                        )
                                    }
                                >
                                    Continue
                                </Button>
                            ) : (
                                <Button
                                    onClick={handleFinish}
                                    className="gap-1"
                                >
                                    <Check className="w-4 h-4" />
                                    Start{" "}
                                    {HIDING_PERIOD_MINUTES[draftSize]}-min
                                    hiding
                                </Button>
                            )}
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

/* ─── Step 1 — Play area ─── */

function PlayAreaStep({
    value,
    onChange,
}: {
    value: OpenStreetMap | null;
    onChange: (v: OpenStreetMap | null) => void;
}) {
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [results, setResults] = useState<OpenStreetMap[]>([]);
    const [searched, setSearched] = useState(false);
    const debouncedQuery = useDebounce(query, 350);
    // Token tracks the latest search so a slow earlier response can't
    // clobber a newer result list.
    const searchToken = useRef(0);

    // Search-as-you-type. On every settled keystroke (350ms debounce) we
    // hit Photon and auto-select the first OSM relation — usually the
    // best match, e.g. typing "Stockholm" lands on Stockholm County. The
    // user can pick a different result from the list to override.
    useEffect(() => {
        const q = debouncedQuery.trim();
        if (!q) {
            setResults([]);
            setSearched(false);
            return;
        }
        const myToken = ++searchToken.current;
        setBusy(true);
        setSearched(true);
        geocode(q, "en")
            .then((found) => {
                if (myToken !== searchToken.current) return; // stale
                setResults(found);
                if (found.length > 0) onChange(found[0]);
            })
            .catch(() => {
                if (myToken !== searchToken.current) return;
                setResults([]);
            })
            .finally(() => {
                if (myToken !== searchToken.current) return;
                setBusy(false);
            });
    }, [debouncedQuery, onChange]);

    const selectedId = value?.properties.osm_id ?? null;

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <div className="relative">
                    <Input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="e.g. Stockholm, Tokyo, London"
                        className="text-base pr-10"
                    />
                    {busy && (
                        <span
                            aria-hidden
                            className="absolute right-3 top-1/2 -translate-y-1/2 inline-block w-4 h-4 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin"
                        />
                    )}
                </div>
                {busy && (
                    <p
                        className="text-xs text-muted-foreground flex items-center gap-1.5"
                        aria-live="polite"
                    >
                        <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
                        Searching for places matching &quot;{query}&quot;…
                    </p>
                )}
            </div>
            {results.length > 0 && (
                <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                        Top match selected — tap another to switch:
                    </p>
                    <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                        {results.map((r) => {
                            const active = r.properties.osm_id === selectedId;
                            const label = determineName(r);
                            return (
                                <button
                                    key={`${r.properties.osm_id}-${r.properties.osm_type}`}
                                    type="button"
                                    onClick={() => onChange(r)}
                                    className={cn(
                                        "w-full text-left p-3 rounded-md border-2 transition-all",
                                        active
                                            ? "bg-primary/10 border-primary"
                                            : "bg-secondary border-border hover:bg-accent",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    )}
                                >
                                    <div className="flex items-start gap-2">
                                        <MapPin
                                            className={cn(
                                                "w-4 h-4 mt-0.5 shrink-0",
                                                active
                                                    ? "text-primary"
                                                    : "text-muted-foreground",
                                            )}
                                        />
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium truncate">
                                                {r.properties.name ??
                                                    label.split(",")[0]}
                                            </div>
                                            <div className="text-xs text-muted-foreground truncate">
                                                {label}
                                            </div>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            {searched && !busy && results.length === 0 && (
                <p className="text-xs text-muted-foreground italic">
                    No regions match. Try a broader name (city, country).
                </p>
            )}
            {/* Rulebook p5: every seeker should turn on location sharing
                (Apple "Find My" or Google Maps live-share) so the hider can
                track them through the round. Surfaced here once during
                setup; no enforcement, just a reminder. */}
            {results.length === 0 && !searched && (
                <p className="text-[11px] leading-snug text-muted-foreground border border-dashed border-border/60 rounded-md p-2.5">
                    <span className="font-semibold text-foreground">
                        Tip:
                    </span>{" "}
                    every seeker should also turn on location sharing
                    (Apple <span className="italic">Find My</span> or Google
                    Maps live-share) so the hider can follow your movement
                    through the round.
                </p>
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
                Walking is always allowed.{" "}
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
                            <div className="flex items-center justify-between gap-2">
                                <SizeBadge size={size} />
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
