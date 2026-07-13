import { useStore } from "@nanostores/react";
import {
    Check,
    ChevronLeft,
    Footprints,
    MapPin,
    Pencil,
    Star,
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
    mapContext,
    mapGeoJSON,
    mapGeoLocation,
    permanentOverlay,
    polyGeoJSON,
    questions,
} from "@/lib/context";
import {
    allowedTransit,
    type GameSize,
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    pendingHidingDurationMin,
    playArea,
    resetMapOverlays,
    setupCompleted,
    setupDialogOpen,
    SIZE_DESCRIPTIONS,
    TRANSIT_ICONS,
    TRANSIT_LABELS,
    type TransitMode,
} from "@/lib/gameSetup";
import { resetHiderRoundState } from "@/lib/hiderRole";
import {
    currentGameCode,
    displayName as displayNameAtom,
    multiplayerEnabled,
    pickRandomCastName,
} from "@/lib/multiplayer/session";
import { hostPushSetup } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";
import {
    determineName,
    geocode,
    type OpenStreetMap,
    reverseGeocodeCity,
} from "@/maps/api";
import {
    estimateTotalAreaKm2,
    exactTotalAreaKm2,
    formatAreaLabel,
    inferGameSize,
    inferTransitModes,
    sameModes,
    sizeForAreaKm2,
} from "@/lib/playAreaSize";
import { triggerPolygonsOsmFrBuild } from "@/maps/api/polygonsOsmFr";
import {
    ensureWarmCitiesLoaded,
    isWarmCity,
    warmCityIds,
} from "@/maps/api/warmCities";
import { ensureSeedCitiesLoaded } from "@/maps/api/seedCities";

import { SectionPill, SizeBadge } from "./JetLagLogo";
import { MapLoader } from "./MapLoader";
import { PlayAreaExtensions } from "./PlayAreaExtensions";
import { PlayAreaPreviewMap } from "./PlayAreaPreviewMap";
import { PreloadChoicesPanel } from "./PreloadChoicesPanel";

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
 * Human-readable place-type label for a Photon result, used in the
 * search list to disambiguate same-named results (e.g. Barcelona
 * the city vs. Barcelona the province vs. Catalonia the region).
 *
 * Photon's `properties.type` is the closest thing to a user-facing
 * label (`city`, `town`, `state`, `country`, `district`, ...). For
 * administrative boundaries it falls back to `osm_value` which is
 * usually `administrative` — not very informative on its own, but
 * combined with the area estimate it's still enough to tell apart.
 */
function placeTypeLabel(feature: OpenStreetMap): string {
    const props = feature.properties as {
        type?: string;
        osm_value?: string;
        osm_key?: string;
    };
    const raw = (props.type || props.osm_value || "").trim();
    if (!raw) return "Region";
    // Photon sometimes returns "house" or "street" for non-admin
    // POIs that slipped past the relation filter — display them
    // as-is rather than pretending they're "Region".
    const lower = raw.toLowerCase();
    if (lower === "administrative") return "Administrative area";
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * Recommended game size for a Photon search result, used in the
 * result list. Returns the raw enum so the row can render the
 * canonical `SizeBadge` (yellow/orange/red) and inherit the size
 * colour code used everywhere else in the app.
 */
function recommendedGameSize(feature: OpenStreetMap): GameSize | null {
    return inferGameSize(feature);
}

export function GameSetupDialog() {
    const $open = useStore(setupDialogOpen);
    const $allowedTransit = useStore(allowedTransit);
    const $gameSize = useStore(gameSize);
    const $setupCompleted = useStore(setupCompleted);
    // Added adjacent areas — folded into the auto game-size / transit
    // inference so the suggestion reflects the WHOLE play area, not just
    // the primary municipality.
    const $additionalAreas = useStore(additionalMapGeoLocations);

    // v252: the first-time wizard now lives at the /setup route, so
    // the dialog only opens via "Edit settings" mid-game. The route-
    // level redirect in SeekerPage / HiderPage covers the case where
    // setupCompleted goes false (new game) — the user lands on /setup
    // automatically.

    const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
    // Direction of the most recent step change, for the slide
    // animation on the step body: "fwd" (Next) slides the new step in
    // from the right (movement left→right through the wizard), "back"
    // slides it in from the left. Tracked via a ref of the previous
    // step so we don't need to thread direction through every setStep
    // call site.
    const prevStepRef = useRef(step);
    const stepDir: "fwd" | "back" =
        step >= prevStepRef.current ? "fwd" : "back";
    useEffect(() => {
        prevStepRef.current = step;
    }, [step]);
    // Edit-mode current tab. Mirrors the three setup-wizard steps so
    // the player navigates the same three concepts (play area, transit,
    // size) in the same order, but laterally instead of sequentially.
    // Opens on Play area, the most-edited surface.
    const [editTab, setEditTab] = useState<"area" | "transit" | "size">(
        "area",
    );
    const [draftFeature, setDraftFeature] = useState<OpenStreetMap | null>(
        null,
    );
    // The play-area osm_id we opened with (edit mode). Used so saving
    // edits only re-commits / clears questions when the area actually
    // changed, not when the user merely re-opened settings.
    const initialPlayAreaIdRef = useRef<number | null>(null);
    const [draftTransit, setDraftTransit] =
        useState<TransitMode[]>($allowedTransit);
    const [draftSize, setDraftSize] = useState<GameSize>($gameSize);
    // Track whether the user has overridden the size manually. As soon
    // as they tap a size tile, we stop auto-inferring from the play area.
    const [sizeManuallySet, setSizeManuallySet] = useState(false);
    // Same for transit: once the user toggles any mode chip we stop
    // auto-defaulting the allowed-transit set from the play-area size.
    const [transitManuallySet, setTransitManuallySet] = useState(false);
    // Snapshot of the values the dialog opened with. Used in edit
    // mode to gate the "Save changes" button — when the draft still
    // matches the snapshot, there's nothing to save.
    const [editSnapshot, setEditSnapshot] = useState<{
        playAreaId: number | null;
        transit: string;
        size: GameSize;
        displayName: string;
    }>({
        playAreaId: null,
        transit: "",
        size: "medium",
        displayName: "",
    });

    // Adjacent areas now live as an inline Dialog inside the play-
    // area step, so the wizard doesn't need a dedicated step or an
    // opt-in flag. The PlayAreaStep manages the modal locally; the
    // parent just owns the primary feature.

    // Display name for the auto-hosted online room. Pre-fills from the
    // persisted atom so returning players don't retype.
    const [draftDisplayName, setDraftDisplayName] = useState(
        displayNameAtom.get() || "",
    );
    // Resolved once per mount so the cast-name hint stays stable while
    // the user is mid-edit.
    const [castPlaceholder] = useState(() => pickRandomCastName());

    // Auto game-size from the play-area size (primary + added adjacents),
    // per the rulebook's S/M/L bands, unless the user picked a size by
    // hand. Seed synchronously from the bbox estimate so the size reacts
    // immediately, then REFINE with the EXACT boundary area (already warmed
    // by the play-area preview map) once it resolves. Deliberately does NOT
    // depend on `draftSize` — it only WRITES it — so the async refine can't
    // fight the sync seed in a loop.
    // `$open`-gated: this dialog stays MOUNTED (closed) in the pre-game
    // lobby, retaining a stale `draftFeature`. Without the gate the
    // closed dialog re-ran `exactTotalAreaKm2` → a raw-boundary
    // `osmtogeojson` parse on the main thread at the role-pick step
    // whenever `$additionalAreas` echoed from multiplayer — pointless work
    // on a huge play area (v762 fix; the inference is only needed while the
    // wizard/settings is actually open).
    useEffect(() => {
        if (!$open || sizeManuallySet || !draftFeature) return;
        let cancelled = false;
        const bbox = sizeForAreaKm2(
            estimateTotalAreaKm2(draftFeature, $additionalAreas),
        );
        if (bbox) setDraftSize(bbox);
        exactTotalAreaKm2(draftFeature, $additionalAreas).then((km2) => {
            if (cancelled) return;
            const exact = sizeForAreaKm2(km2);
            if (exact) setDraftSize(exact);
        });
        return () => {
            cancelled = true;
        };
    }, [$open, draftFeature, $additionalAreas, sizeManuallySet]);

    // Auto allowed-transit from the EFFECTIVE game size (`inferTransitModes`)
    // unless the user toggled a mode by hand. Keyed on `draftSize`, so it
    // re-derives whether the size changed via the auto-infer above OR a
    // manual size pick (bumping to Large pulls in ferry). Guarded setter
    // avoids a redundant write. `$open`-gated for the same reason as above.
    useEffect(() => {
        if (!$open || transitManuallySet) return;
        const modes = inferTransitModes(draftSize);
        setDraftTransit((prev) => (sameModes(prev, modes) ? prev : modes));
    }, [$open, draftSize, transitManuallySet]);

    // Clear picked neighbours only when the primary play area genuinely
    // CHANGES to a DIFFERENT area than the one the saved neighbours
    // belong to (the committed `mapGeoLocation`). The previous version
    // fired on every null→area transition, so opening this dialog in
    // edit mode — which seeds `draftFeature` with the current area —
    // wiped the already-saved adjacents on open (they "weren't saved").
    // Gating on the committed primary makes the seed/reopen a no-op and
    // only a real area change resets the list.
    useEffect(() => {
        const id = draftFeature?.properties?.osm_id ?? null;
        if (id === null) return;
        const committedId =
            (mapGeoLocation.get()?.properties as { osm_id?: number } | undefined)
                ?.osm_id ?? null;
        if (id === committedId) return;
        additionalMapGeoLocations.set([]);
    }, [draftFeature?.properties.osm_id]);

    // Wrap setDraftSize so any tile tap also flips the override flag.
    const setDraftSizeManual = (s: GameSize) => {
        setSizeManuallySet(true);
        setDraftSize(s);
    };

    // Wrap setDraftTransit so any mode-chip toggle flips the override
    // flag — from then on we stop auto-defaulting transit from the size.
    const setDraftTransitManual = (v: TransitMode[]) => {
        setTransitManuallySet(true);
        setDraftTransit(v);
    };

    // Wizard mode = first-time setup or "New game" (setupCompleted=false).
    // Edit mode  = user opened this from "Edit settings" with an active game.
    // In edit mode we show all three sections in a single scroll and skip
    // the hiding-period restart on save.
    const isEditMode = $setupCompleted;

    useEffect(() => {
        if ($open) {
            setStep(1);
            // Edit mode: seed the draft with the area already in play so
            // the picker shows the current selection instead of falling
            // back to a GPS auto-search. Wizard mode starts blank.
            const editing = setupCompleted.get();
            let current = editing ? mapGeoLocation.get() : null;
            const pa = playArea.get();
            // Stale-snapshot guard: on the hide-team device the
            // persisted mapGeoLocation can be a leftover (e.g. the
            // Japan default) while playArea has been pushed from
            // the host. If the seed doesn't match the current play
            // area's name, drop it so the dialog opens in search
            // mode rather than misrepresenting the area as Japan.
            if (current && pa) {
                const seedName =
                    current.properties?.name?.split(",")[0]?.trim() ?? "";
                const paName =
                    pa.displayName.split(",")[0]?.trim() ?? "";
                if (
                    seedName.length > 0 &&
                    paName.length > 0 &&
                    seedName.toLowerCase() !== paName.toLowerCase()
                ) {
                    current = null;
                }
            }
            setDraftFeature(current);
            initialPlayAreaIdRef.current =
                current?.properties?.osm_id ?? null;
            const transit = allowedTransit.get();
            setDraftTransit(transit);
            const size = gameSize.get();
            setDraftSize(size);
            const name = displayNameAtom.get() || "";
            setDraftDisplayName(name);
            setEditSnapshot({
                playAreaId: current?.properties?.osm_id ?? null,
                transit: [...transit].sort().join(","),
                size,
                displayName: name,
            });
            // Reset auto-infer flags for the new session. In edit mode we
            // assume the existing size + transit set are intentional and
            // don't override them from the area.
            setSizeManuallySet(setupCompleted.get());
            setTransitManuallySet(setupCompleted.get());
        }
    }, [$open]);

    // Edit-mode dirty check. Save changes only enables once the
    // draft genuinely differs from what the dialog opened with.
    const isDirty =
        editSnapshot.transit !== [...draftTransit].sort().join(",") ||
        editSnapshot.size !== draftSize ||
        editSnapshot.displayName !== draftDisplayName ||
        editSnapshot.playAreaId !==
            (draftFeature?.properties?.osm_id ?? null);

    const handleSaveEdits = () => {
        // Apply transit + size live, no hiding-period restart.
        allowedTransit.set(draftTransit);
        gameSize.set(draftSize);
        // Changing settings reverts map overlays to their default OFF state.
        resetMapOverlays();

        // Play area: only commit if the user actually picked a DIFFERENT
        // area. In edit mode the draft is seeded with the current area,
        // so a plain transit/size tweak must not re-commit it (that would
        // needlessly wipe questions). Compare against the osm_id we opened
        // with. When it genuinely changed, wipe questions/zone caches the
        // same way handleFinish does — the old questions are no longer
        // geographically valid.
        const playAreaChanged =
            draftFeature != null &&
            draftFeature.properties.osm_id !== initialPlayAreaIdRef.current;
        if (playAreaChanged) {
            const coords = draftFeature.geometry.coordinates as number[];
            const [lat, lng] = coords;
            playArea.set({
                displayName: determineName(draftFeature),
                lat,
                lng,
            });
            mapGeoLocation.set(draftFeature);
            // Pre-build the polygons.osm.fr polygon for this relation
            // so that by the time the seeker hits the lobby and the
            // boundary fetch kicks in, the fast-path racer already
            // has a built polygon ready instead of returning "None"
            // and falling back to the public Overpass mirrors. The
            // call is fire-and-forget and idempotent per relation,
            // so re-picks are free.
            if (draftFeature.properties.osm_type === "R") {
                triggerPolygonsOsmFrBuild(draftFeature.properties.osm_id);
            }
            questions.set([]);
            // NOTE: don't clear `additionalMapGeoLocations` here —
            // `PlayAreaExtensions` already manages it (it clears
            // stale entries when the primary changes and sets the
            // user's tick selections). Wiping it post-finish was
            // the bug where adjacent areas (e.g. Lund alongside
            // Malmö) silently dropped off the play-area boundary.
            mapGeoJSON.set(null);
            polyGeoJSON.set(null);
            disabledStations.set([]);
            permanentOverlay.set(null);
            const map = mapContext.get();
            map?.flyTo([lat, lng], 11, { duration: 0.6 });
            toast.info("Play area updated — questions cleared.", {
                autoClose: 3000,
            });
        } else {
            toast.success("Settings saved.", { autoClose: 2000 });
        }
        // Push the updated setup to peers if we're in an online room.
        hostPushSetup();
        setupDialogOpen.set(false);
    };

    const handleFinish = () => {
        allowedTransit.set(draftTransit);
        gameSize.set(draftSize);
        // Fresh game starts with all map overlays off.
        resetMapOverlays();

        // Defer the hiding-period clock until the play-area boundary
        // is actually rendered — otherwise a country-sized load
        // (Sweden, France…) eats the first chunk of the hider's
        // window while the map is still painting. `GameStartWatcher`
        // converts pendingHidingDurationMin → hidingPeriodEndsAt
        // once mapGeoJSON/polyGeoJSON is set.
        const minutes = HIDING_PERIOD_MINUTES[draftSize];
        pendingHidingDurationMin.set(minutes);
        hidingPeriodEndsAt.set(null);

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
            // See the matching call above (finish-wizard path): kick
            // off the polygons.osm.fr build immediately on selection
            // so the boundary is ready by the time the lobby loads.
            if (draftFeature.properties.osm_type === "R") {
                triggerPolygonsOsmFrBuild(draftFeature.properties.osm_id);
            }

            // Fresh game: wipe everything tied to a previous session so the
            // seeker starts from a blank slate inside the new region. Settings
            // (tile layer, units, API keys, etc.) are intentionally preserved.
            //
            // NOT cleared: `additionalMapGeoLocations`. That's managed by
            // `PlayAreaExtensions` — it already resets the list when the
            // primary play area changes during step 1, and populates it
            // with the user's tick selections. Wiping it here was the bug
            // where adjacent municipalities (e.g. Lund picked alongside
            // Malmö) silently dropped off the rendered play area.
            questions.set([]);
            mapGeoJSON.set(null);
            polyGeoJSON.set(null);
            disabledStations.set([]);
            permanentOverlay.set(null);
            hiderMode.set(false);
            // Clear hider-side state too — inbox, hand, zone, spot,
            // round-found timestamp. Important on single-device test
            // flows where the seeker and hider share a browser; in a
            // multi-device game the hider device runs its own reset
            // via the stale-session prompt or a manual "New game".
            resetHiderRoundState();
            // Default: hide the hiding-zones overlay on a fresh game. The
            // zones themselves still pre-load in the background (see
            // ZoneSidebar's initializeHidingZones), so toggling the overlay
            // on from the map controls is near-instant.
            displayHidingZones.set(false);

            const map = mapContext.get();
            map?.flyTo([lat, lng], 11, { duration: 0.6 });
        } else {
            playArea.set(null);
        }

        setupCompleted.set(true);
        setupDialogOpen.set(false);

        // Commit the host's display name so the lobby's self-heal
        // autohost picks it up when it kicks createGame(). The
        // wizard used to also create the room here in a fire-and-
        // forget createGame().then(...) block, but that raced the
        // lobby's autohost effect (added in v35 for crash-recovery
        // when the wizard's host attempt fails silently). Both would
        // fire, two rooms would get created, and the visible code
        // would land on whichever joinAsHost ran last while the
        // OTHER one's toast fired — the "toast says LA8Y76 but
        // dialog says 4YSUQK" symptom. Drop the wizard's autohost
        // entirely; the lobby is the single source of truth for
        // creating a room.
        // Persist exactly what they typed (empty if they left it blank);
        // the server assigns a unique Jet Lag cast name on host when it's
        // empty, so two un-named players never share a name.
        const trimmedName = draftDisplayName.trim();
        displayNameAtom.set(trimmedName);

        const alreadyOnline =
            multiplayerEnabled.get() && currentGameCode.get();
        if (alreadyOnline) {
            // Edit mode (mid-game settings change): push the new
            // setup to peers so their lobby / map reflects it.
            hostPushSetup();
        }
        // else: lobby's self-heal autohost effect will create a
        //       room once the dialog mounts. No race.

        // Hiding-period start toast moved into GameStartWatcher —
        // it fires together with the GO GO GO banner once the map is
        // actually loaded. Showing the toast here would lie about the
        // clock state when the boundary takes 30+ seconds to load.
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
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col p-0 gap-0",
                )}
            >
                {isEditMode ? (
                    <>
                        <div className="px-4 pt-3 pb-3 shrink-0 border-b border-border">
                            <div className="flex items-center gap-3 mb-1.5">
                                <DialogTitle
                                    className="font-display font-black uppercase text-xl leading-tight flex-1"
                                    style={{ letterSpacing: "-0.02em" }}
                                >
                                    Game settings
                                </DialogTitle>
                                <SectionPill>Edit</SectionPill>
                            </div>
                            <DialogDescription className="text-xs leading-snug">
                                Transit and size apply immediately. Changing
                                the play area clears all questions.
                            </DialogDescription>
                        </div>

                        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-5">
                            {/* Three tabs mirror the three setup-wizard
                                steps in the same order (Play area,
                                Transit, Size) so the same conceptual
                                map drives both the first-time wizard
                                and later edits. The Online-play block
                                stays below as a non-tabbed section —
                                it's not part of the wizard flow. */}
                            <EditTabs value={editTab} onChange={setEditTab} />
                            <div>
                                {editTab === "area" && (
                                    <PlayAreaStep
                                        value={draftFeature}
                                        onChange={setDraftFeature}
                                    />
                                )}
                                {editTab === "transit" && (
                                    <TransitStep
                                        value={draftTransit}
                                        onChange={setDraftTransitManual}
                                    />
                                )}
                                {editTab === "size" && (
                                    <SizeStep
                                        value={draftSize}
                                        onChange={setDraftSizeManual}
                                    />
                                )}
                            </div>
                            {/* Online play / lobby controls live in
                                the lobby dialog (top-right header
                                button) — not here. Keeps Game
                                Settings purely about the wizard-shaped
                                three concepts. */}
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
                                disabled={!isDirty}
                                className="gap-1"
                            >
                                <Check className="w-4 h-4" />
                                Save changes
                            </Button>
                        </DialogFooter>
                    </>
                ) : (
                    <>
                        <div className="px-4 pt-3 pb-3 shrink-0 border-b border-border">
                            <div className="flex items-center gap-3 mb-1.5">
                                <DialogTitle
                                    className="font-display font-black uppercase text-xl leading-tight flex-1"
                                    style={{ letterSpacing: "-0.02em" }}
                                >
                                    {step === 1 && "Where are you playing?"}
                                    {step === 2 && "What transit is allowed?"}
                                    {step === 3 && "How big is the game?"}
                                    {step === 4 && "What should we preload?"}
                                </DialogTitle>
                                <SectionPill>Step {step} / 4</SectionPill>
                            </div>
                            <DialogDescription className="text-xs leading-snug">
                                {step === 1 &&
                                    "Pick the city or region you'll be seeking in. Add neighbouring municipalities if they should count as one play area."}
                                {step === 2 &&
                                    "Which public transit modes the hider can use. Walking is always allowed."}
                                {step === 3 &&
                                    "Larger games span more ground and last longer."}
                                {step === 4 &&
                                    "We'll warm these caches at the start of the hiding period so seekers don't see loading spinners mid-game. You can flip any of these later in Settings."}
                            </DialogDescription>
                        </div>

                        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 overflow-x-hidden">
                            {/* Keyed on `step` so each advance/retreat
                                remounts and replays the slide. Forward
                                steps enter from the right, back steps
                                from the left — a small directional cue
                                that the wizard is a left→right flow. */}
                            <div
                                key={step}
                                className={cn(
                                    "animate-in fade-in duration-200",
                                    stepDir === "fwd"
                                        ? "slide-in-from-right-6"
                                        : "slide-in-from-left-6",
                                )}
                            >
                            {step === 1 && (
                                <PlayAreaStep
                                    value={draftFeature}
                                    onChange={setDraftFeature}
                                />
                            )}
                            {step === 2 && (
                                <TransitStep
                                    value={draftTransit}
                                    onChange={setDraftTransitManual}
                                />
                            )}
                            {step === 3 && (
                                <div className="space-y-5">
                                    <SizeStep
                                        value={draftSize}
                                        onChange={setDraftSizeManual}
                                    />
                                    {/* Display name → drives the
                                        auto-created online room. Field
                                        is optional: blank skips the
                                        host-on-start step entirely. */}
                                    <div className="space-y-1.5 border-t border-border pt-4">
                                        <label className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                            Your display name
                                        </label>
                                        <Input
                                            value={draftDisplayName}
                                            onChange={(e) =>
                                                setDraftDisplayName(
                                                    e.target.value,
                                                )
                                            }
                                            placeholder={`What others see (e.g. ${castPlaceholder})`}
                                            maxLength={24}
                                        />
                                        <p className="text-[10px] text-muted-foreground leading-snug">
                                            Starting the game also hosts
                                            an online room you can share
                                            with friends. Leave blank to
                                            play offline.
                                        </p>
                                    </div>
                                </div>
                            )}
                            {step === 4 && (
                                <PreloadChoicesPanel
                                    areaKm2={estimateTotalAreaKm2(
                                        draftFeature,
                                        $additionalAreas,
                                    )}
                                />
                            )}
                            </div>
                        </div>

                        <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-between">
                            <Button
                                variant="outline"
                                onClick={() =>
                                    setStep((s) =>
                                        s > 1
                                            ? ((s - 1) as 1 | 2 | 3 | 4)
                                            : s,
                                    )
                                }
                                disabled={step === 1}
                                className="gap-1"
                            >
                                <ChevronLeft className="w-4 h-4" />
                                Back
                            </Button>
                            {step < 4 ? (
                                <Button
                                    disabled={!canContinue}
                                    onClick={() =>
                                        setStep(
                                            (s) =>
                                                ((s + 1) as 1 | 2 | 3 | 4),
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
                                    Open lobby
                                </Button>
                            )}
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

/* ─── Edit-mode tabs ─── */

const EDIT_TABS: Array<{
    value: "area" | "transit" | "size";
    label: string;
}> = [
    { value: "area", label: "Play area" },
    { value: "transit", label: "Transit" },
    { value: "size", label: "Size" },
];

function EditTabs({
    value,
    onChange,
}: {
    value: "area" | "transit" | "size";
    onChange: (next: "area" | "transit" | "size") => void;
}) {
    return (
        <div
            role="tablist"
            aria-label="Game settings sections"
            className={cn(
                "grid grid-cols-3 gap-1 p-1 rounded-md",
                "bg-secondary/40 border border-border",
            )}
        >
            {EDIT_TABS.map(({ value: v, label }) => {
                const active = value === v;
                return (
                    <button
                        key={v}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onChange(v)}
                        className={cn(
                            "flex items-center justify-center gap-1.5",
                            "px-2 py-1.5 rounded-sm",
                            "text-[11px] font-poppins font-bold uppercase tracking-[0.10em]",
                            "transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                    >
                        <span className="truncate">{label}</span>
                    </button>
                );
            })}
        </div>
    );
}

/* ─── Step 1 — Play area ─── */

/**
 * v454: shared loading copy for the locate → preview-tiles handoff.
 * The GPS-pending placeholder and the preview map's tile veil now use
 * the SAME wording, so a fresh auto-suggest reads as one continuous
 * "finding your area" load instead of the label jumping to a second
 * "Loading map" phase the moment GPS resolves.
 */
const LOCATING_LABEL = "Finding a play area near you…";
const LOCATING_SUBLABEL =
    "Using your location to suggest a starting area you can tweak.";

export function PlayAreaStep({
    value,
    onChange,
    fillHeight = false,
}: {
    value: OpenStreetMap | null;
    onChange: (v: OpenStreetMap | null) => void;
    /** When true (the full-page wizard), the preview lays out as a flex
     *  column that fills the parent — the play-area card sits on top and the
     *  map grows to fill the space below. The modal editor leaves it false
     *  (fixed near-square map, more content below). */
    fillHeight?: boolean;
}) {
    // Preview vs. search. Default: preview when there's a committed
    // area (edit mode reopen, or a fresh wizard that's already
    // landed on a GPS-suggested match). The user toggles to search
    // via the "Change area" button, and an OnChange-from-results
    // bounces back to preview automatically.
    const [mode, setMode] = useState<"preview" | "search">(
        value ? "preview" : "search",
    );
    // v641: the set of prewarmed ("warm") city relation ids, so search
    // results for cities that load fast (no live Overpass) get a star.
    // Fetched once, cached; null while loading (nothing starred yet).
    const $warmCities = useStore(warmCityIds);
    useEffect(() => {
        void ensureWarmCitiesLoaded();
        // Seed ids drive the search's primary sort (major city > village).
        void ensureSeedCitiesLoaded();
    }, []);
    // Tracks whether we're in search mode because the user explicitly
    // tapped "Change area" (true) vs. because we started without a
    // value (false). When false, the GPS auto-suggest landing a match
    // should bounce to the preview by itself — that's the streamlined
    // flow. When true, we let the user finish picking before bouncing.
    const userInitiatedSearch = useRef(false);
    // v502: the play-area map now lives at the TOP of the step in BOTH
    // preview and search modes, keyed on the area's osm_id, so toggling
    // preview↔search doesn't remount/reload it (only a genuine area
    // change does). That made the old `previewMapReady` fade-gate
    // (and its onReady-vs-reset race) unnecessary — the preview card +
    // controls just render directly under the persistent map.
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [results, setResults] = useState<OpenStreetMap[]>([]);
    const [searched, setSearched] = useState(false);
    // v503: while the search box is focused the on-screen keyboard eats
    // ~half the viewport, so we shrink the map to keep the input +
    // results in view. Tracks focus as a keyboard-open proxy.
    const [inputFocused, setInputFocused] = useState(false);
    const debouncedQuery = useDebounce(query, 350);
    // Token tracks the latest search so a slow earlier response can't
    // clobber a newer result list.
    const searchToken = useRef(0);

    /**
     * GPS-suggestion state machine. On first mount with an empty
     * search and no committed play area, we request the device's
     * coordinates and reverse-geocode them to a city name. That name
     * is then dropped into the search box, which kicks the normal
     * geocode flow and produces a ranked list with the matching
     * city at the top.
     *
     *   "idle"        — haven't attempted yet
     *   "pending"     — getCurrentPosition is in flight
     *   "denied"      — user said no (or browser blocked it)
     *   "unavailable" — geolocation API not present / failed
     *   "no-match"    — got coordinates but reverse-geocode failed
     *   "done"        — successfully prefilled the search
     */
    // v289: initialize to "pending" when GPS will actually fire so
    // the very first render shows the MapLoader placeholder instead
    // of flashing the autoFocused search Input (which yanked the
    // mobile keyboard up just to slam it back down a moment later
    // when gpsState transitioned to "pending"). When there's already
    // a `value` (edit mode), we skip GPS entirely and stay at "idle".
    const [gpsState, setGpsState] = useState<
        "idle" | "pending" | "denied" | "unavailable" | "no-match" | "done"
    >(() => (value ? "idle" : "pending"));
    /** Whether we've already attempted GPS this mount — guards against
     *  the effect re-running if React Strict Mode or HMR refires it. */
    const gpsAttempted = useRef(false);
    /** osm_id of the area the GPS auto-suggest committed, if any. Only
     *  THAT exact area gets the "finding a play area near you" veil copy
     *  carried into its tile load — a manually-searched/picked area is a
     *  deliberate choice, not a location guess, so it must not show it.
     *  (The old `gpsState==="done" && !userInitiatedSearch` proxy leaked:
     *  handlePickResult reset the flag, so a picked area got the veil.) */
    const gpsSuggestedOsmId = useRef<number | null>(null);

    /** Ref to the search Input so we can focus it imperatively when
     *  the user explicitly opens search mode via "Change area".
     *  Replaces the prior `autoFocus` prop, which fired on every
     *  remount of the Input — including the brief mid-flow remount
     *  while GPS was resolving — and jerked the on-screen keyboard
     *  open and shut. */
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const pendingSearchFocus = useRef(false);
    useEffect(() => {
        if (!pendingSearchFocus.current) return;
        if (mode !== "search") return;
        if (!searchInputRef.current) return;
        searchInputRef.current.focus();
        pendingSearchFocus.current = false;
    }, [mode]);

    /** Stable handle on the latest `onChange` so the search-as-you-
     *  type effect doesn't have to list it as a dep. Avoids
     *  re-firing the geocode whenever the parent re-renders with a
     *  fresh callback identity (and quietly hammering Photon with
     *  duplicate requests for the same debounced query). */
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    const tryGpsSuggest = (manual = false) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            setGpsState("unavailable");
            return;
        }
        setGpsState("pending");
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                const { latitude, longitude } = pos.coords;
                try {
                    const candidates = await reverseGeocodeCity(
                        latitude,
                        longitude,
                    );
                    if (!candidates || candidates.length === 0) {
                        setGpsState("no-match");
                        return;
                    }
                    // Helper: read freshest query without committing
                    // a write. Lets us bail mid-iteration if the user
                    // starts typing.
                    const peekQuery = (): string => {
                        let curr = "";
                        setQuery((q) => {
                            curr = q;
                            return q;
                        });
                        return curr;
                    };
                    // Try each candidate (most-specific → least)
                    // until forward-geocode returns OSM relations.
                    // Handles the Falun case: "Falun, Sweden" → no
                    // matches → fall through to "Falu kommun,
                    // Sweden" → Dalarna → Sweden. The first that
                    // hits wins. v289: we capture the OSM match
                    // directly (not just the candidate string) so we
                    // can jump straight to preview mode without
                    // routing through the search-as-you-type
                    // pipeline — that pipeline rendered an
                    // intermediate "search + results" frame which
                    // briefly remounted the search Input (autofocus
                    // → keyboard) and the preview map (new MapLibre
                    // instance) before flipping into the real
                    // preview branch.
                    let winnerMatch: OpenStreetMap | null = null;
                    for (const candidate of candidates) {
                        // User started typing — abandon the
                        // suggestion entirely, don't apply any
                        // candidate.
                        if (peekQuery().length > 0) {
                            setGpsState("no-match");
                            return;
                        }
                        try {
                            const found = await geocode(candidate, "en");
                            if (found.length > 0) {
                                winnerMatch = found[0];
                                break;
                            }
                        } catch {
                            // Network blip on this candidate —
                            // try the next one rather than aborting.
                            continue;
                        }
                    }
                    if (!winnerMatch) {
                        setGpsState("no-match");
                        return;
                    }
                    // Last typing-race check before we commit.
                    if (peekQuery().length > 0) {
                        setGpsState("no-match");
                        return;
                    }
                    // Bypass the search-as-you-type debounce: write
                    // straight into `value` + flip the mode in one
                    // React batch. The next render lands in the
                    // preview branch without rendering the search
                    // Input or the search-mode preview map at all.
                    gpsSuggestedOsmId.current =
                        winnerMatch.properties.osm_id;
                    onChange(winnerMatch);
                    setMode("preview");
                    setGpsState("done");
                } catch {
                    setGpsState("no-match");
                }
            },
            (err) => {
                if (err.code === err.PERMISSION_DENIED) {
                    setGpsState("denied");
                } else {
                    setGpsState("unavailable");
                }
            },
            // Short-ish timeout — the user is sitting in the wizard
            // waiting for the result. If GPS is slow they can fall
            // through to manual search.
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 },
        );
        void manual; // reserved for future "user explicitly retried" UX hints
    };

    useEffect(() => {
        if (gpsAttempted.current) return;
        if (value !== null) return; // existing pick — don't auto-locate
        if (query.length > 0) return; // user already started typing
        gpsAttempted.current = true;
        tryGpsSuggest();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-bounce back to preview as soon as a result is picked from
    // the search list. The user came in to change the area; once
    // they've made a choice, they want to see the new selection on
    // the map, not stay in search mode.
    const handlePickResult = (r: OpenStreetMap) => {
        onChange(r);
        setQuery("");
        setResults([]);
        setSearched(false);
        setMode("preview");
        userInitiatedSearch.current = false;
    };

    // v289: dropped the auto-bounce useEffect. The GPS handler now
    // calls `onChange(winnerMatch) + setMode("preview")` directly,
    // so the flicker-prone "search lands → effect catches up →
    // setMode" sequence is gone. Manual picks from the search
    // results list still flip mode via handlePickResult.

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
                // NOTE: do NOT auto-commit found[0] to `value` here. Doing
                // so mutated the committed play area as the user typed, so
                // "Keep current area" kept the SEARCHED area, not the
                // original. The committed area now only changes when the
                // user actually picks a result (handlePickResult) or via
                // the Enter key / GPS suggest.
            })
            .catch(() => {
                if (myToken !== searchToken.current) return;
                setResults([]);
            })
            .finally(() => {
                if (myToken !== searchToken.current) return;
                setBusy(false);
            });
    }, [debouncedQuery]);

    // While GPS is still pending on a fresh first-time entry — no
    // committed value, no typed query, user didn't explicitly tap
    // "Change area" — show a map-themed loading placeholder instead of
    // the search field. Most users get their answer from the
    // auto-suggest, so leading with a "type here" field asks them to
    // decide before we've done our job. On any GPS failure the search
    // field returns as the fallback.
    const hideSearchWhileLocating =
        gpsState === "pending" &&
        !value &&
        query.length === 0 &&
        !userInitiatedSearch.current;

    if (hideSearchWhileLocating) {
        return (
            <div className="space-y-3 animate-in fade-in duration-200">
                <div
                    className="relative w-full aspect-square rounded-md overflow-hidden border border-border"
                    role="status"
                    aria-live="polite"
                    aria-label="Detecting your location"
                >
                    <MapLoader />
                    <div
                        className={cn(
                            "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
                            "flex flex-col items-center justify-center gap-1",
                            "px-4 py-2.5 rounded-md max-w-[80%]",
                            "bg-[hsl(var(--background))]/85 backdrop-blur-sm",
                            "border border-border/60 shadow-sm",
                        )}
                    >
                        <div className="text-sm font-medium text-foreground text-center">
                            {LOCATING_LABEL}
                        </div>
                        <div className="text-xs text-muted-foreground text-center leading-snug">
                            {LOCATING_SUBLABEL}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // ────────────── Unified layout ──────────────
    // One persistent map at the TOP (whenever an area is committed),
    // keyed on the area's osm_id so toggling preview↔search does NOT
    // remount/reload it — only a genuine area change does. The
    // mode-specific controls render BELOW it, so the map stays put and
    // the layout barely shifts when search opens/closes. (The reveal
    // gate is latched, so the persistent map never re-veils on a mode
    // toggle.)
    const inPreview = mode === "preview" && value !== null;
    // The GPS-suggest veil copy is for the located area ONLY — match the
    // committed value against the exact osm_id GPS produced, so a
    // subsequently searched/picked area never inherits "finding a play
    // area near you".
    const fromGpsSuggest =
        value !== null &&
        value.properties.osm_id === gpsSuggestedOsmId.current;
    const topResultId = results[0]?.properties.osm_id ?? null;
    const currentAreaLabel = value
        ? (value.properties.name ?? determineName(value).split(",")[0])
        : null;
    // Map height morphs with mode: a big near-square in preview, and a
    // shorter strip in search — shrinking further once the keyboard is up
    // (input focused) so the field + results stay visible above it. The
    // height transition (on the persistent, osm_id-keyed map) IS the
    // "area morphs into a search" animation. MapLibre's trackResize keeps
    // the canvas in step as the container animates.
    const mapHeightClass = cn(
        "transition-[height] duration-300 ease-out",
        inPreview
            ? "h-[min(78vw,340px)]"
            : inputFocused
              ? "h-[120px]"
              : "h-[200px]",
    );
    // While searching with the keyboard up, hide the map entirely so the
    // search results get the full remaining height (a 120px map strip left
    // room for barely one result — see the reported cramped state). The
    // map stays MOUNTED (display:none), not unmounted, so dismissing the
    // keyboard / returning to preview doesn't remount + reload + re-veil
    // it — same persistence intent as the osm_id key above.
    const hideMapForSearch = !inPreview && inputFocused;

    // Fill layout (full-page wizard, preview only): the card sits on top and
    // the map GROWS to fill the space below instead of leaving a fixed
    // near-square with dead space beneath it. Achieved with flex `order` so
    // the map block stays FIRST in the DOM (mount persistence across
    // preview↔search — it must never remount/reload), while the content
    // block visually sits above it in preview.
    const fillPreview = fillHeight && inPreview;

    return (
        <div className={cn("flex flex-col gap-3", fillPreview && "h-full")}>
            {value && (
                // Smoothly collapse the map (grid-rows 1fr→0fr) instead of
                // an instant `hidden` when the keyboard is up — the map
                // stays MOUNTED (no reload) and slides away/back as search
                // opens/closes. `overflow-hidden` clips it while collapsing.
                <div
                    className={cn(
                        "grid transition-[grid-template-rows] duration-300 ease-out",
                        hideMapForSearch ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
                        // Preview: map BELOW the card (order-2) and fills; search:
                        // map on top (order-1), fixed strip.
                        inPreview ? "order-2" : "order-1",
                        fillPreview && "flex-1 min-h-[12rem]",
                    )}
                >
                    <div className="overflow-hidden h-full">
                        <PlayAreaPreviewMap
                            key={value.properties.osm_id}
                            value={value}
                            height={fillPreview ? "h-full" : mapHeightClass}
                            veilLabel={
                                inPreview && fromGpsSuggest
                                    ? LOCATING_LABEL
                                    : undefined
                            }
                            veilSublabel={
                                inPreview && fromGpsSuggest
                                    ? LOCATING_SUBLABEL
                                    : undefined
                            }
                            awaitAdjacent={inPreview}
                        />
                    </div>
                </div>
            )}

            {/* Keyed so switching preview↔search fades the new content in
                (a smooth transition instead of an instant swap). The key
                only flips on the mode change, so in-search interactions
                (typing, focus) don't remount the input. */}
            <div
                key={inPreview ? "preview" : "search"}
                className={cn(
                    "space-y-3 animate-in fade-in duration-200",
                    inPreview ? "order-1" : "order-2",
                    fillPreview && "shrink-0",
                )}
            >
            {inPreview ? (
                (() => {
                    const label =
                        value.properties.name ??
                        determineName(value).split(",")[0];
                    const typeLabel = placeTypeLabel(value);
                    const areaLabel = formatAreaLabel(value);
                    const sizeHint = recommendedGameSize(value);
                    const warm = isWarmCity(
                        value.properties.osm_id,
                        $warmCities,
                    );
                    return (
                        <>
                            {/* Card row: the play-area card takes the width and
                                the edit button sits to its RIGHT (matching the
                                card height), instead of a full-width button
                                below — so the map can own the space beneath. */}
                            <div className="flex items-stretch gap-2">
                                <div className="rounded-md border-2 border-primary bg-primary/10 p-3 flex items-start gap-2 flex-1 min-w-0">
                                    <MapPin className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                                    <div className="min-w-0 flex-1">
                                        <div className="text-[10px] uppercase tracking-wider font-poppins font-bold text-muted-foreground">
                                            Play area
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-base font-bold truncate">
                                                {label}
                                            </span>
                                            {warm && (
                                                <Star
                                                    className="w-3.5 h-3.5 shrink-0 fill-warning text-warning"
                                                    aria-label="Fully cached, including adjacent areas — plays offline-fast"
                                                />
                                            )}
                                        </div>
                                        <div className="flex items-center flex-wrap gap-1.5 mt-1">
                                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wider font-poppins font-bold bg-background/60 border border-border/60 text-muted-foreground">
                                                {typeLabel}
                                            </span>
                                            {areaLabel && (
                                                <span className="text-[10px] tabular-nums text-muted-foreground">
                                                    {areaLabel}
                                                </span>
                                            )}
                                            {sizeHint && (
                                                <SizeBadge
                                                    size={sizeHint}
                                                    className="!text-[9px] !px-1.5 !py-0.5"
                                                />
                                            )}
                                        </div>
                                    </div>
                                    <Check className="w-4 h-4 text-primary shrink-0" />
                                </div>

                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        userInitiatedSearch.current = true;
                                        pendingSearchFocus.current = true;
                                        // Optimistically mark focused so the map
                                        // shrinks in ONE smooth step (not
                                        // preview→tall-search→short-search) — the
                                        // input auto-focuses right after.
                                        setInputFocused(true);
                                        setMode("search");
                                        setQuery("");
                                        setResults([]);
                                        setSearched(false);
                                    }}
                                    aria-label="Change play area"
                                    className="shrink-0 self-stretch h-auto flex-col gap-1 px-4 active:scale-[0.98] transition-transform"
                                >
                                    <Pencil className="w-4 h-4" />
                                    <span className="text-xs">Edit</span>
                                </Button>
                            </div>

                            <PlayAreaExtensions primary={value} />
                        </>
                    );
                })()
            ) : (
                <>
                    {/* "Keep <area>" sits ABOVE the search field so the
                        escape-back-to-current affordance reads as a header
                        for the edit, names the area you'd keep, and doesn't
                        get buried under the keyboard. */}
                    {value && currentAreaLabel && (
                        <Button
                            variant="ghost"
                            // Prevent the tap from blurring the focused search
                            // input: the blur fires `setInputFocused(false)`,
                            // which re-expands the map and shoves this button
                            // DOWN before the click resolves — so the tap
                            // missed and you had to press "Keep" twice (the
                            // reported "two states" bug). Suppressing the
                            // default focus-shift keeps the layout still so
                            // the very first tap lands.
                            onPointerDown={(e) => e.preventDefault()}
                            onClick={() => {
                                // Keep the ORIGINAL committed area. We no
                                // longer auto-commit search results, so
                                // `value` is still the original — just drop
                                // back to preview. The map is keyed on
                                // osm_id and unchanged, so it does NOT
                                // reload.
                                setQuery("");
                                setResults([]);
                                setSearched(false);
                                setInputFocused(false);
                                userInitiatedSearch.current = false;
                                setMode("preview");
                            }}
                            className="w-full justify-start gap-1.5 active:scale-[0.98] transition-transform"
                        >
                            <ChevronLeft className="w-4 h-4 shrink-0" />
                            <span className="truncate">
                                Keep {currentAreaLabel}
                            </span>
                        </Button>
                    )}
                    <div className="space-y-2">
                        <div className="relative">
                            <Input
                                ref={searchInputRef}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onFocus={() => setInputFocused(true)}
                                onBlur={() => setInputFocused(false)}
                                onKeyDown={(e) => {
                                    if (e.key !== "Enter") return;
                                    e.preventDefault();
                                    // Enter commits the top (suggested)
                                    // match and dismisses the keyboard.
                                    // No-op until results land.
                                    if (results.length > 0) {
                                        handlePickResult(results[0]);
                                    }
                                    searchInputRef.current?.blur();
                                }}
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
                        {(gpsState === "denied" ||
                            gpsState === "unavailable" ||
                            gpsState === "no-match") &&
                            query.length === 0 && (
                                <div className="rounded-md border border-dashed border-border/60 bg-secondary/30 px-2.5 py-2 flex items-center gap-2 text-xs">
                                    <span className="text-muted-foreground">
                                        {gpsState === "denied"
                                            ? "Couldn't access your location — search manually below."
                                            : gpsState === "no-match"
                                              ? "Couldn't recognise your location — search manually below."
                                              : "Location unavailable — search manually below."}
                                    </span>
                                    {gpsState !== "denied" && (
                                        <button
                                            type="button"
                                            onClick={() => tryGpsSuggest(true)}
                                            className={cn(
                                                "ml-auto px-2 py-0.5 rounded-sm",
                                                "text-[10px] uppercase tracking-wider font-poppins font-bold",
                                                "bg-primary/15 text-primary border border-primary/40",
                                                "hover:bg-primary/25 transition-colors",
                                            )}
                                        >
                                            Retry
                                        </button>
                                    )}
                                </div>
                            )}
                    </div>

                    {results.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-xs text-muted-foreground">
                                Tap a match to use it (Enter picks the top one):
                            </p>
                            <div
                                className={cn(
                                    "space-y-1.5 overflow-y-auto pr-1",
                                    // With the map hidden (keyboard up) the
                                    // results can use the freed height; keep
                                    // the tighter cap when the map is shown.
                                    hideMapForSearch
                                        ? "max-h-[52vh]"
                                        : "max-h-60",
                                )}
                            >
                                {results.map((r) => {
                                    const active =
                                        r.properties.osm_id === topResultId;
                                    const label = determineName(r);
                                    const typeLabel = placeTypeLabel(r);
                                    const areaLabel = formatAreaLabel(r);
                                    const sizeHint = recommendedGameSize(r);
                                    const warm = isWarmCity(
                                        r.properties.osm_id,
                                        $warmCities,
                                    );
                                    return (
                                        <button
                                            key={`${r.properties.osm_id}-${r.properties.osm_type}`}
                                            type="button"
                                            // Prevent the tap from blurring the
                                            // focused search input FIRST: the blur
                                            // fires setInputFocused(false), which
                                            // re-expands the map (still showing the
                                            // OLD area) and reflows the list before
                                            // the click resolves — so the first tap
                                            // only dismissed the keyboard and you
                                            // had to tap the result twice. Same fix
                                            // as the "Keep <area>" button above.
                                            onPointerDown={(e) =>
                                                e.preventDefault()
                                            }
                                            onClick={() => handlePickResult(r)}
                                            className={cn(
                                                "w-full text-left p-3 rounded-md border-2 transition-all active:scale-[0.99]",
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
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-sm font-medium truncate">
                                                            {r.properties
                                                                .name ??
                                                                label.split(
                                                                    ",",
                                                                )[0]}
                                                        </span>
                                                        {warm && (
                                                            <Star
                                                                className="w-3.5 h-3.5 shrink-0 fill-warning text-warning"
                                                                aria-label="Fully cached, including adjacent areas — plays offline-fast"
                                                            />
                                                        )}
                                                    </div>
                                                    <div className="flex items-center flex-wrap gap-1.5 mt-1">
                                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wider font-poppins font-bold bg-background/60 border border-border/60 text-muted-foreground">
                                                            {typeLabel}
                                                        </span>
                                                        {areaLabel && (
                                                            <span className="text-[10px] tabular-nums text-muted-foreground">
                                                                {areaLabel}
                                                            </span>
                                                        )}
                                                        {sizeHint && (
                                                            <SizeBadge
                                                                size={sizeHint}
                                                                className="!text-[9px] !px-1.5 !py-0.5"
                                                            />
                                                        )}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground truncate mt-1">
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
                </>
            )}
            </div>
        </div>
    );
}

/* ─── Step 2 — Transit ─── */


export function TransitStep({
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

export function SizeStep({
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
