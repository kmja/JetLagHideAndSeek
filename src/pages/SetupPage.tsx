import { useStore } from "@nanostores/react";
import { Check, ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
    estimateAreaKm2,
    PlayAreaStep,
    SizeStep,
    TransitStep,
} from "@/components/GameSetupDialog";
import { SectionPill } from "@/components/JetLagLogo";
import { Button } from "@/components/ui/button";
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
    type TransitMode,
    welcomeSeen,
} from "@/lib/gameSetup";
import { resetHiderRoundState } from "@/lib/hiderRole";
import {
    currentGameCode,
    multiplayerEnabled,
} from "@/lib/multiplayer/session";
import { hostPushSetup } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";
import { determineName, type OpenStreetMap } from "@/maps/api";
import { triggerPolygonsOsmFrBuild } from "@/maps/api/polygonsOsmFr";

/**
 * First-time / new-game setup wizard, now its own route at `/setup`
 * (v252). Was a dialog overlaid on the seeker view; the wizard isn't
 * part of the game view, it's the flow you go through *before* the
 * game starts, so it earns a real URL.
 *
 * On finish: commits the chosen play area, transit, size, and host
 * display name to the same atoms `GameSetupDialog.handleFinish` did,
 * then navigates to `/` (the seeker route — wizard finishers are
 * always the host). The lobby's auto-host effect picks up from there.
 *
 * Edit-settings mid-game stays as the tabbed `GameSetupDialog` —
 * that's a settings editor, not a wizard.
 *
 * Route guards (SeekerPage / HiderPage) handle the inverse: when
 * `setupCompleted` flips false (new game) the user is redirected
 * here automatically.
 */
export function SetupPage() {
    const navigate = useNavigate();
    const $welcomeSeen = useStore(welcomeSeen);
    const $setupCompleted = useStore(setupCompleted);

    // Gate: must have seen Welcome first (we don't render a sub-route
    // landing screen). If setup is already done, fall back to the
    // seeker view — getting here in that state means stale history.
    useEffect(() => {
        if (!$welcomeSeen) {
            navigate("/", { replace: true });
            return;
        }
        if ($setupCompleted) {
            navigate("/", { replace: true });
        }
    }, [$welcomeSeen, $setupCompleted, navigate]);

    const [step, setStep] = useState<1 | 2 | 3>(1);
    // Track direction for the inter-step slide animation. fwd = right
    // → left motion (entering from right); back = left → right.
    const prevStepRef = useRef(step);
    const stepDir: "fwd" | "back" =
        step >= prevStepRef.current ? "fwd" : "back";
    useEffect(() => {
        prevStepRef.current = step;
    }, [step]);

    const [draftFeature, setDraftFeature] = useState<OpenStreetMap | null>(
        null,
    );
    const [draftTransit, setDraftTransit] = useState<TransitMode[]>(
        allowedTransit.get(),
    );
    const [draftSize, setDraftSize] = useState<GameSize>(gameSize.get());
    // Once the user taps a size tile we stop auto-inferring from the
    // chosen play area.
    const [sizeManuallySet, setSizeManuallySet] = useState(false);
    // Auto-infer size from the picked area unless the user has
    // overridden it. Mirrors GameSetupDialog's behaviour.
    useEffect(() => {
        if (sizeManuallySet || !draftFeature) return;
        const km2 = estimateAreaKm2(draftFeature);
        if (km2 === null) return;
        if (km2 < 250) setDraftSize("small");
        else if (km2 < 2500) setDraftSize("medium");
        else setDraftSize("large");
    }, [draftFeature, sizeManuallySet]);

    // Wipe any adjacent picks the moment the primary area changes —
    // stale neighbours from a different country would otherwise
    // bleed across.
    useEffect(() => {
        additionalMapGeoLocations.set([]);
    }, [draftFeature?.properties.osm_id]);

    const setDraftSizeManual = (s: GameSize) => {
        setSizeManuallySet(true);
        setDraftSize(s);
    };

    const handleFinish = () => {
        allowedTransit.set(draftTransit);
        gameSize.set(draftSize);
        // v444: the preload decision moved to the lobby (network-aware —
        // auto on wifi, a checkbox on cellular), so the wizard no longer
        // touches preloadChoices.
        resetMapOverlays();

        // Defer the hiding-period clock until the play-area boundary
        // is actually rendered — otherwise a country-sized load eats
        // the first chunk of the hider's window while the map is
        // still painting. GameStartWatcher converts
        // pendingHidingDurationMin → hidingPeriodEndsAt once
        // mapGeoJSON / polyGeoJSON is set.
        pendingHidingDurationMin.set(HIDING_PERIOD_MINUTES[draftSize]);
        hidingPeriodEndsAt.set(null);

        if (draftFeature) {
            const coords = draftFeature.geometry.coordinates as number[];
            const [lat, lng] = coords;
            const displayName = determineName(draftFeature);
            playArea.set({ displayName, lat, lng });
            mapGeoLocation.set(draftFeature);
            if (draftFeature.properties.osm_type === "R") {
                triggerPolygonsOsmFrBuild(draftFeature.properties.osm_id);
            }
            questions.set([]);
            mapGeoJSON.set(null);
            polyGeoJSON.set(null);
            disabledStations.set([]);
            permanentOverlay.set(null);
            hiderMode.set(false);
            resetHiderRoundState();
            displayHidingZones.set(false);
            const map = mapContext.get();
            map?.flyTo([lat, lng], 11, { duration: 0.6 });
        } else {
            playArea.set(null);
        }

        setupCompleted.set(true);
        // v279: display name now lives in the RolePicker. The wizard
        // doesn't touch displayNameAtom anymore.

        if (multiplayerEnabled.get() && currentGameCode.get()) {
            hostPushSetup();
        }

        navigate("/", { replace: true });
    };

    const canContinue =
        step === 1
            ? draftFeature !== null
            : step === 2
              ? draftTransit.length > 0
              : true;

    return (
        <div
            className={cn(
                "fixed inset-0 z-[1000] flex flex-col",
                "bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
                "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
            )}
        >
            <div className="px-4 pt-3 pb-3 shrink-0 border-b border-border">
                <div className="flex items-center gap-3 mb-1.5">
                    <h1
                        className="font-display font-black uppercase text-xl leading-tight flex-1"
                        style={{ letterSpacing: "-0.02em" }}
                    >
                        {step === 1 && "Play area"}
                        {step === 2 && "Transit modes"}
                        {step === 3 && "Game size"}
                    </h1>
                    <SectionPill>Step {step} / 3</SectionPill>
                </div>
                <p className="text-xs leading-snug text-muted-foreground">
                    {step === 1 &&
                        "Pick the city or region you'll be seeking in. Add neighbouring municipalities if they should count as one play area."}
                    {step === 2 &&
                        "Which public transit modes the hider can use."}
                    {step === 3 &&
                        "Larger games span more ground and last longer."}
                </p>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 overflow-x-hidden">
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
            </div>

            <div className="px-6 py-4 shrink-0 border-t border-border flex items-center justify-between gap-2">
                <Button
                    variant="outline"
                    onClick={() => {
                        if (step > 1) {
                            setStep((s) => ((s - 1) as 1 | 2 | 3));
                            return;
                        }
                        // Step 1 Back = leave the wizard back to the
                        // Welcome screen. Without this the user was
                        // trapped: step 1 is the first step (nothing to go
                        // back to) and the wizard is a full-screen route
                        // with no other exit. Clearing welcomeSeen makes
                        // /welcome render (it bounces to "/" while seen);
                        // the route guards converge on /welcome either way.
                        welcomeSeen.set(false);
                        navigate("/welcome", { replace: true });
                    }}
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
                        Create game
                    </Button>
                )}
            </div>
        </div>
    );
}

export default SetupPage;
