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
import { PreloadChoicesPanel } from "@/components/PreloadChoicesPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    displayName as displayNameAtom,
    multiplayerEnabled,
    pickRandomCastName,
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

    const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
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
    const [draftDisplayName, setDraftDisplayName] = useState(
        displayNameAtom.get() || "",
    );
    // Resolved once per mount so the cast-name hint stays stable
    // while the user is mid-edit.
    const [castPlaceholder] = useState(() => pickRandomCastName());

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
        const trimmedName = draftDisplayName.trim();
        displayNameAtom.set(trimmedName);

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
                        {step === 1 && "Where are you playing?"}
                        {step === 2 && "What transit is allowed?"}
                        {step === 3 && "How big is the game?"}
                        {step === 4 && "What should we preload?"}
                    </h1>
                    <SectionPill>Step {step} / 4</SectionPill>
                </div>
                <p className="text-xs leading-snug text-muted-foreground">
                    {step === 1 &&
                        "Pick the city or region you'll be seeking in. Add neighbouring municipalities if they should count as one play area."}
                    {step === 2 &&
                        "Which public transit modes the hider can use."}
                    {step === 3 &&
                        "Larger games span more ground and last longer."}
                    {step === 4 &&
                        "We'll warm these caches at the start of the hiding period so seekers don't see loading spinners mid-game. You can flip any of these later in Settings."}
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
                        <div className="space-y-5">
                            <SizeStep
                                value={draftSize}
                                onChange={setDraftSizeManual}
                            />
                            <div className="space-y-1.5 border-t border-border pt-4">
                                <label className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                    Your display name
                                </label>
                                <Input
                                    value={draftDisplayName}
                                    onChange={(e) =>
                                        setDraftDisplayName(e.target.value)
                                    }
                                    placeholder={`What others see (e.g. ${castPlaceholder})`}
                                    maxLength={24}
                                />
                                <p className="text-[10px] text-muted-foreground leading-snug">
                                    Starting the game also hosts an online
                                    room you can share with friends. Leave
                                    blank to play offline.
                                </p>
                            </div>
                        </div>
                    )}
                    {step === 4 && (
                        <PreloadChoicesPanel
                            areaKm2={
                                draftFeature
                                    ? estimateAreaKm2(draftFeature)
                                    : null
                            }
                        />
                    )}
                </div>
            </div>

            <div className="px-6 py-4 shrink-0 border-t border-border flex items-center justify-between gap-2">
                <Button
                    variant="outline"
                    onClick={() =>
                        setStep((s) =>
                            s > 1 ? ((s - 1) as 1 | 2 | 3 | 4) : s,
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
                            setStep((s) => ((s + 1) as 1 | 2 | 3 | 4))
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
