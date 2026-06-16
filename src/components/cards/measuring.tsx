import { useStore } from "@nanostores/react";
import { Label } from "@radix-ui/react-label";
import * as React from "react";
import { useEffect, useState } from "react";

import CustomInitDialog from "@/components/CustomInitDialog";
import { LatitudeLongitude } from "@/components/LatLngPicker";
import NearestReferencePreview, {
    useNearestReference,
} from "@/components/NearestReferencePreview";
import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    customInitPreference,
    displayHidingZones,
    drawingQuestionKey,
    hiderMode,
    isLoading,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { gameSize } from "@/lib/gameSetup";
import { cleanDescription, isSubtypeAllowed } from "@/lib/subtypes";
import { cn } from "@/lib/utils";
import { determineMeasuringBoundary } from "@/maps/questions/measuring";
import {
    determineUnionizedStrings,
    type MeasuringQuestion,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

import { ManualAnswerDisclosure,QuestionCard } from "./base";

export const MeasuringQuestionComponent = ({
    data,
    questionKey,
    forceExpanded,
    sub,
    className,
    compactAnswer,
}: {
    data: MeasuringQuestion;
    questionKey: number;
    sub?: string;
    forceExpanded?: boolean;
    className?: string;
    compactAnswer?: boolean;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $displayHidingZones = useStore(displayHidingZones);
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $isLoading = useStore(isLoading);
    const $gameSize = useStore(gameSize);
    const $customInitPref = useStore(customInitPreference);
    const [customDialogOpen, setCustomDialogOpen] = React.useState(false);

    // Game rule: each (category, subtype) can only be asked once per game.
    const usedMeasuringTypes = React.useMemo<Set<string>>(
        () =>
            new Set(
                $questions
                    .filter(
                        (q) => q.id === "measuring" && q.key !== questionKey,
                    )
                    .map((q) => (q.data as MeasuringQuestion).type),
            ),
        [$questions, questionKey],
    );

    const label = `Measuring
    ${
        $questions
            .filter((q) => q.id === "measuring")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    let questionSpecific = <></>;

    switch (data.type) {
        case "mcdonalds":
        case "seven11":
            questionSpecific = (
                <span className="px-2 text-center text-orange-500">
                    This question will eliminate hiding zones that don&apos;t
                    fit the criteria. When you click on a zone, the parts of
                    that zone that don&apos;t satisfy the criteria will be
                    eliminated.
                </span>
            );
            break;
        case "aquarium":
        case "hospital":
        case "peak":
        case "museum":
        case "theme_park":
        case "zoo":
        case "cinema":
        case "library":
        case "golf_course":
        case "consulate":
        case "park":
            questionSpecific = (
                <span className="px-2 text-center text-orange-500">
                    This question will only influence the map when you click on
                    a hiding zone in the hiding zone sidebar.
                </span>
            );
            break;
        case "custom-measure":
            if (data.drag) {
                questionSpecific = (
                    <>
                        <p className="px-2 mb-1 text-center text-orange-500">
                            To modify the measuring question, enable it:
                            <Checkbox
                                className="mx-1 my-1"
                                checked={$drawingQuestionKey === questionKey}
                                onCheckedChange={(checked) => {
                                    if (checked) {
                                        drawingQuestionKey.set(questionKey);
                                    } else {
                                        drawingQuestionKey.set(-1);
                                    }
                                }}
                                disabled={!data.drag || $isLoading}
                            />
                            and use the buttons at the bottom left of the map.
                        </p>
                        <div className="flex justify-center mb-2">
                            <PresetsDialog
                                data={data}
                                presetTypeHint={data.type}
                            />
                        </div>
                    </>
                );
            }
            break;
    }

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            category="measuring"
            summary={
                data.drag
                    ? `${(data.type.charAt(0).toUpperCase() + data.type.slice(1)).replace(/-/g, " ")} · awaiting answer`
                    : `${(data.type.charAt(0).toUpperCase() + data.type.slice(1)).replace(/-/g, " ")} · ${data.hiderCloser ? "Closer" : "Further"}`
            }
            createdAt={data.createdAt}
            className={className}
            forceExpanded={forceExpanded}
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed; // Doesn't trigger a re-render so no need for questionModified
            }}
            locked={!data.drag}
            setLocked={(locked) => questionModified((data.drag = !locked))}
        >
            <CustomInitDialog
                open={customDialogOpen}
                onOpenChange={setCustomDialogOpen}
                onBlank={async () => {
                    if (!(data as any).geo) {
                        (data as any).geo = {
                            type: "FeatureCollection",
                            features: [],
                        };
                    } else {
                        (data as any).geo.features = [];
                    }
                    data.type = "custom-measure";
                    questionModified();
                    setCustomDialogOpen(false);
                }}
                onPrefill={async () => {
                    const boundary = await determineMeasuringBoundary(data);
                    if (!(data as any).geo) {
                        (data as any).geo = {
                            type: "FeatureCollection",
                            features: [],
                        };
                    }
                    (data as any).geo.features = boundary ? boundary : [];
                    data.type = "custom-measure";
                    questionModified();
                    setCustomDialogOpen(false);
                }}
            />
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Measuring Type"
                    options={Object.fromEntries(
                        measuringQuestionSchema.options
                            .filter((x) => x.description === NO_GROUP)
                            .flatMap((x) =>
                                determineUnionizedStrings(x.shape.type),
                            )
                            .map((x) => [
                                (x._def as any).value,
                                cleanDescription(x.description),
                            ])
                            .filter(
                                ([value, _]) =>
                                    (!usedMeasuringTypes.has(value as string) ||
                                        value === data.type) &&
                                    (isSubtypeAllowed(value as string, $gameSize) ||
                                        value === data.type),
                            ),
                    )}
                    groups={measuringQuestionSchema.options
                        .filter((x) => x.description !== NO_GROUP)
                        .map((x) => [
                            x.description,
                            Object.fromEntries(
                                determineUnionizedStrings(x.shape.type)
                                    .map((x) => [
                                        (x._def as any).value,
                                        cleanDescription(x.description),
                                    ])
                                    .filter(
                                        ([value, _]) =>
                                            !usedMeasuringTypes.has(
                                                value as string,
                                            ) || value === data.type,
                                    ),
                            ),
                        ])
                        .reduce(
                            (acc, [key, value]) => {
                                const values = {
                                    disabled: !$displayHidingZones,
                                    options: value,
                                };

                                if (acc[key]) {
                                    acc[key].options = {
                                        ...acc[key].options,
                                        ...value,
                                    };
                                } else {
                                    acc[key] = values;
                                }

                                return acc;
                            },
                            {} as Record<
                                string,
                                {
                                    disabled: boolean;
                                    options: Record<string, string>;
                                }
                            >,
                        )}
                    value={data.type}
                    onValueChange={async (value) => {
                        if (value === "custom-measure") {
                            if ($customInitPref === "ask") {
                                setCustomDialogOpen(true);
                                return;
                            }
                            if ($customInitPref === "blank") {
                                if (!(data as any).geo) {
                                    (data as any).geo = {
                                        type: "FeatureCollection",
                                        features: [],
                                    };
                                } else {
                                    (data as any).geo.features = [];
                                }
                            } else if ($customInitPref === "prefill") {
                                const boundary =
                                    await determineMeasuringBoundary(data);
                                if (!(data as any).geo) {
                                    (data as any).geo = {
                                        type: "FeatureCollection",
                                        features: [],
                                    };
                                }
                                (data as any).geo.features = boundary
                                    ? boundary
                                    : [];
                            }
                            data.type = value;
                            questionModified();
                            return;
                        }
                        data.type = value;
                        questionModified();
                    }}
                    disabled={!data.drag || $isLoading}
                />
            </SidebarMenuItem>
            {questionSpecific}

            {/* "Your nearest reference" preview — only in the configure
                dialog (forceExpanded), and only while the question is
                still a draft. Shows the name + your distance to the
                closest place of the chosen type, so you know what the
                hider is being compared against. */}
            {forceExpanded && data.drag && (
                <NearestReferencePreview
                    lat={data.lat}
                    lng={data.lng}
                    type={data.type}
                    mode="measuring"
                />
            )}

            <MeasuringLocation
                lat={data.lat}
                lng={data.lng}
                color={data.color}
                type={data.type}
                disabled={!data.drag || $isLoading}
                forceExpanded={forceExpanded}
                dragLive={data.drag}
                onChange={(lat, lng) => {
                    if (lat !== null) data.lat = lat;
                    if (lng !== null) data.lng = lng;
                    questionModified();
                }}
            />
            <ManualAnswerDisclosure compact={compactAnswer}>
                <div className="flex gap-2 items-center p-2">
                    <Label
                        className={cn(
                            "font-semibold text-lg",
                            $isLoading && "text-muted-foreground",
                        )}
                    >
                        Result
                    </Label>
                    <ToggleGroup
                        className="grow"
                        type="single"
                        value={
                            data.drag
                                ? ""
                                : data.hiderCloser
                                  ? "closer"
                                  : "further"
                        }
                        onValueChange={(value: "closer" | "further") => {
                            if (!value) return;
                            data.hiderCloser = value === "closer";
                            data.drag = false;
                            questionModified();
                        }}
                        disabled={!!$hiderMode || $isLoading}
                    >
                        <ToggleGroupItem value="further">
                            Hider Further
                        </ToggleGroupItem>
                        <ToggleGroupItem value="closer">
                            Hider Closer
                        </ToggleGroupItem>
                    </ToggleGroup>
                </div>
            </ManualAnswerDisclosure>
        </QuestionCard>
    );
};

/**
 * LatitudeLongitude + nearest-reference overlay for measuring questions.
 * Mirror of the matching card's helper — kept here as a copy so each
 * card stays self-contained.
 */
function MeasuringLocation({
    lat,
    lng,
    color,
    type,
    disabled,
    forceExpanded,
    dragLive,
    onChange,
}: {
    lat: number;
    lng: number;
    color: string;
    type: string;
    disabled?: boolean;
    forceExpanded?: boolean;
    dragLive?: boolean;
    onChange: (lat: number | null, lng: number | null) => void;
}) {
    // Guard the lookup on real coords. 0,0 is the "not set yet"
    // sentinel from runAddMeasuring; firing the Overpass call against
    // null island would waste a request and confuse the UI.
    const coordsSet = lat !== 0 || lng !== 0;
    const showRef = Boolean(forceExpanded && dragLive && coordsSet);
    const ref = useNearestReference(showRef ? lat : 0, showRef ? lng : 0, showRef ? type : "");

    // v276: keep the last-known reference visible while a subsequent
    // lookup is in flight (e.g. the seeker pin nudged by 1 m by GPS,
    // or an Overpass timeout flickered the state back to "loading"
    // → "error"). Without this, the configure-dialog map unmounted as
    // soon as `referencePoint` cleared and the user got stuck on the
    // "Locating you and the nearest reference…" placeholder.
    const [stickyRef, setStickyRef] = useState<{ lat: number; lng: number; name: string } | null>(null);
    useEffect(() => {
        if (ref.status === "ok") {
            setStickyRef({
                lat: ref.ref.lat,
                lng: ref.ref.lng,
                name: ref.ref.name,
            });
        }
    }, [ref]);
    // Drop the latch when the subtype changes — the old reference is
    // no longer relevant.
    useEffect(() => {
        setStickyRef(null);
    }, [type]);

    const referencePoint =
        showRef
            ? ref.status === "ok"
                ? { lat: ref.ref.lat, lng: ref.ref.lng, name: ref.ref.name }
                : stickyRef ?? undefined
            : undefined;

    // See cards/matching.tsx — defer the map inside the configure
    // dialog until both the seeker pin and the resolved nearest
    // reference are known. Avoids the play-area-centroid flash.
    const mapReady = !forceExpanded || (coordsSet && Boolean(referencePoint));

    return (
        <LatitudeLongitude
            latitude={lat}
            longitude={lng}
            colorName={color as any}
            onChange={onChange}
            disabled={disabled}
            referencePoint={referencePoint}
            // Inside the configure dialog the location must come from
            // GPS (or the place-search fallback) — never from a stray
            // map tap. Outside the dialog (`forceExpanded` false) the
            // question is already answered and the picker is just a
            // display, so the lock doesn't matter.
            lockToGps={forceExpanded}
            mapReady={mapReady}
            // v239: draw the closer/further half-plane impact on the
            // picker map, only while configuring a draft question.
            impactMode={forceExpanded ? "measuring" : undefined}
            impactType={type}
        />
    );
}
