import { useStore } from "@nanostores/react";
import * as React from "react";
import { toast } from "react-toastify";

import CustomInitDialog from "@/components/CustomInitDialog";
import { LatitudeLongitude } from "@/components/LatLngPicker";
import NearestReferencePreview, {
    useNearestReference,
} from "@/components/NearestReferencePreview";
import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
import {
    determineMatchingBoundary,
    findMatchingPlaces,
} from "@/maps/questions/matching";
import {
    determineUnionizedStrings,
    type MatchingQuestion,
    matchingQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

import { ManualAnswerDisclosure,QuestionCard } from "./base";

export const MatchingQuestionComponent = ({
    data,
    questionKey,
    forceExpanded,
    sub,
    className,
    compactAnswer,
}: {
    data: MatchingQuestion;
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
    const $customInitPref = useStore(customInitPreference);
    const $gameSize = useStore(gameSize);
    const [customDialogOpen, setCustomDialogOpen] = React.useState(false);
    const [pendingCustomType, setPendingCustomType] = React.useState<
        "custom-zone" | "custom-points" | null
    >(null);

    // Game rule: each (category, subtype) can only be asked once per game.
    // Build a set of types used by OTHER matching questions; the current
    // question's own type is always allowed (so its Select shows its value).
    const usedMatchingTypes = React.useMemo<Set<string>>(
        () =>
            new Set(
                $questions
                    .filter((q) => q.id === "matching" && q.key !== questionKey)
                    .map((q) => (q.data as MatchingQuestion).type),
            ),
        [$questions, questionKey],
    );

    const label = `Matching
    ${
        $questions
            .filter((q) => q.id === "matching")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    let questionSpecific = <></>;

    switch (data.type) {
        case "zone":
        case "letter-zone":
            questionSpecific = (
                <>
                    <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                        <Select
                            trigger="OSM Zone"
                            options={{
                                2: "OSM Zone 2 (Country)",
                                3: "OSM Zone 3 (region in Japan)",
                                4: "OSM Zone 4 (prefecture in Japan)",
                                5: "OSM Zone 5",
                                6: "OSM Zone 6",
                                7: "OSM Zone 7",
                                8: "OSM Zone 8",
                                9: "OSM Zone 9",
                                10: "OSM Zone 10",
                            }}
                            value={data.cat.adminLevel.toString()}
                            onValueChange={(value) =>
                                questionModified(
                                    (data.cat.adminLevel = parseInt(value) as
                                        | 2
                                        | 3
                                        | 4
                                        | 5
                                        | 6
                                        | 7
                                        | 8
                                        | 9
                                        | 10),
                                )
                            }
                            disabled={!data.drag || $isLoading}
                        />
                    </SidebarMenuItem>
                    {data.type === "letter-zone" && (
                        <span className="px-2 text-center text-orange-500">
                            Warning: The zone data has been simplified by
                            &plusmn;360 feet (100 meters) in order for the
                            browser to not crash.
                        </span>
                    )}
                </>
            );
            break;
        case "same-train-line":
            questionSpecific = (
                <span className="px-2 text-center text-orange-500">
                    Warning: The train line data is based on OpenStreetMap and
                    may have fewer train stations than expected. If you are
                    using this tool, ensure that the other players are also
                    using this tool.
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
        case "custom-zone":
        case "custom-points":
            if (data.drag) {
                questionSpecific = (
                    <>
                        <p className="px-2 mb-1 text-center text-orange-500">
                            To modify the matching{" "}
                            {data.type === "custom-zone" ? "zones" : "points"},
                            enable it:
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
                                disabled={$isLoading}
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
    }

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            category="matching"
            summary={
                data.drag
                    ? `${(data.type.charAt(0).toUpperCase() + data.type.slice(1)).replace(/-/g, " ")} · awaiting answer`
                    : `${(data.type.charAt(0).toUpperCase() + data.type.slice(1)).replace(/-/g, " ")} · ${data.same ? "Match" : "No match"}`
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
                    if (!pendingCustomType) return;
                    if (pendingCustomType === "custom-zone") {
                        (data as any).geo = undefined;
                        toast.info("Please draw the zone on the map.");
                    } else {
                        (data as any).geo = [];
                        toast.info("Please draw the points on the map.");
                    }
                    data.type = pendingCustomType;
                    questionModified();
                    setCustomDialogOpen(false);
                }}
                onPrefill={async () => {
                    if (!pendingCustomType) return;
                    if (pendingCustomType === "custom-zone") {
                        (data as any).geo =
                            await determineMatchingBoundary(data);
                    } else {
                        if (
                            data.type === "airport" ||
                            data.type === "major-city" ||
                            data.type === "aquarium-full" ||
                            data.type === "zoo-full" ||
                            data.type === "theme_park-full" ||
                            data.type === "peak-full" ||
                            data.type === "museum-full" ||
                            data.type === "hospital-full" ||
                            data.type === "cinema-full" ||
                            data.type === "library-full" ||
                            data.type === "golf_course-full" ||
                            data.type === "consulate-full" ||
                            data.type === "park-full"
                        ) {
                            (data as any).geo = await findMatchingPlaces(data);
                        } else {
                            (data as any).geo = [];
                            toast.info("Please draw the points on the map.");
                        }
                    }
                    data.type = pendingCustomType;
                    questionModified();
                    setCustomDialogOpen(false);
                }}
            />
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Matching Type"
                    options={Object.fromEntries(
                        matchingQuestionSchema.options
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
                                    (!usedMatchingTypes.has(
                                        value as string,
                                    ) ||
                                        value === data.type) &&
                                    (isSubtypeAllowed(
                                        value as string,
                                        $gameSize,
                                    ) ||
                                        value === data.type),
                            ),
                    )}
                    groups={matchingQuestionSchema.options
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
                                            (!usedMatchingTypes.has(
                                                value as string,
                                            ) ||
                                                value === data.type) &&
                                            (isSubtypeAllowed(
                                                value as string,
                                                $gameSize,
                                            ) ||
                                                value === data.type),
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
                        if (
                            value === "custom-zone" ||
                            value === "custom-points"
                        ) {
                            if ($customInitPref === "ask") {
                                setPendingCustomType(value);
                                setCustomDialogOpen(true);
                                return;
                            }
                            // Apply preference without dialog
                            if ($customInitPref === "blank") {
                                if (value === "custom-zone") {
                                    (data as any).geo = undefined;
                                    toast.info(
                                        "Please draw the zone on the map.",
                                    );
                                } else {
                                    (data as any).geo = [];
                                    toast.info(
                                        "Please draw the points on the map.",
                                    );
                                }
                            } else if ($customInitPref === "prefill") {
                                if (value === "custom-zone") {
                                    (data as any).geo =
                                        await determineMatchingBoundary(data);
                                } else {
                                    if (
                                        data.type === "airport" ||
                                        data.type === "major-city" ||
                                        data.type === "aquarium-full" ||
                                        data.type === "zoo-full" ||
                                        data.type === "theme_park-full" ||
                                        data.type === "peak-full" ||
                                        data.type === "museum-full" ||
                                        data.type === "hospital-full" ||
                                        data.type === "cinema-full" ||
                                        data.type === "library-full" ||
                                        data.type === "golf_course-full" ||
                                        data.type === "consulate-full" ||
                                        data.type === "park-full"
                                    ) {
                                        (data as any).geo =
                                            await findMatchingPlaces(data);
                                    } else {
                                        (data as any).geo = [];
                                        toast.info(
                                            "Please draw the points on the map.",
                                        );
                                    }
                                }
                            }
                            // The category should be defined such that no error is thrown if this is a zone question.
                            if (!(data as any).cat) {
                                (data as any).cat = { adminLevel: 3 };
                            }
                            questionModified((data.type = value));
                            return;
                        }

                        if (value === "same-length-station") {
                            data.lengthComparison = "same";
                            data.same = true;
                        }

                        // The category should be defined such that no error is thrown if this is a zone question.
                        if (!(data as any).cat) {
                            (data as any).cat = { adminLevel: 3 };
                        }
                        questionModified((data.type = value));
                    }}
                    disabled={!data.drag || $isLoading}
                />
            </SidebarMenuItem>
            {questionSpecific}

            {/* "Your nearest reference" preview — only in the configure
                dialog (forceExpanded), and only while the question is
                still a draft. Helps the seeker confirm which specific
                place the hider is being matched against. */}
            {forceExpanded && data.drag && (
                <NearestReferencePreview
                    lat={data.lat}
                    lng={data.lng}
                    type={data.type}
                    mode="matching"
                />
            )}

            {data.type !== "custom-zone" && (
                <MatchingMeasuringLocation
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
            )}
            <ManualAnswerDisclosure compact={compactAnswer}>
                <div
                    className={cn(
                        "flex gap-2 items-center p-2",
                        data.type === "same-length-station" && "flex-col",
                    )}
                >
                    <Label
                        className={cn(
                            "font-semibold text-lg",
                            $isLoading && "text-muted-foreground",
                            data.type === "same-length-station" &&
                                "text-center",
                        )}
                    >
                        Result
                    </Label>
                    {data.type === "same-length-station" ? (
                        <ToggleGroup
                            className="grow"
                            type="single"
                            value={
                                data.lengthComparison
                                    ? data.lengthComparison
                                    : data.same === true
                                      ? "same"
                                      : data.same === false
                                        ? "different"
                                        : "same"
                            }
                            onValueChange={(
                                value:
                                    | "shorter"
                                    | "same"
                                    | "longer"
                                    | "different",
                            ) => {
                                if (
                                    value === "shorter" ||
                                    value === "longer"
                                ) {
                                    data.lengthComparison = value;
                                } else if (value === "same") {
                                    data.lengthComparison = "same";
                                    data.same = true;
                                } else if (value === "different") {
                                    data.same = false;
                                } else {
                                    return;
                                }
                                data.drag = false;
                                questionModified();
                            }}
                            disabled={!!$hiderMode || $isLoading}
                        >
                            <ToggleGroupItem value="shorter">
                                Shorter
                            </ToggleGroupItem>
                            <ToggleGroupItem value="same">Same</ToggleGroupItem>
                            <ToggleGroupItem value="longer">
                                Longer
                            </ToggleGroupItem>
                        </ToggleGroup>
                    ) : (
                        <ToggleGroup
                            className="grow"
                            type="single"
                            value={
                                data.drag
                                    ? ""
                                    : data.same
                                      ? "same"
                                      : "different"
                            }
                            onValueChange={(value) => {
                                if (value === "same") {
                                    data.same = true;
                                } else if (value === "different") {
                                    data.same = false;
                                } else {
                                    return;
                                }
                                data.drag = false;
                                questionModified();
                            }}
                            disabled={!!$hiderMode || $isLoading}
                        >
                            <ToggleGroupItem value="different">
                                Different
                            </ToggleGroupItem>
                            <ToggleGroupItem value="same">Same</ToggleGroupItem>
                        </ToggleGroup>
                    )}
                </div>
            </ManualAnswerDisclosure>
        </QuestionCard>
    );
};

/**
 * Thin wrapper around LatitudeLongitude that fetches the seeker's
 * nearest reference (when meaningful for the question type) and threads
 * its coordinates into the picker so a dashed line is drawn on the map
 * between the seeker pin and the resolved place. Only fires the lookup
 * inside the configure dialog (`forceExpanded`) and while the question
 * is still a draft — once it's answered, the map's elimination mask
 * carries the visual.
 */
function MatchingMeasuringLocation({
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
    // Always call the hook (no conditional hooks). When the type isn't
    // resolvable, useNearestReference returns { status: "none" } and we
    // pass no referencePoint to the picker. Skip the lookup at the 0,0
    // sentinel (runAddMatching's "not set yet" value) — firing on null
    // island wastes a request and would surface a confusing "Your
    // nearest reference" 10000 km away.
    const coordsSet = lat !== 0 || lng !== 0;
    const showRef = Boolean(forceExpanded && dragLive && coordsSet);
    const ref = useNearestReference(showRef ? lat : 0, showRef ? lng : 0, showRef ? type : "");

    const referencePoint =
        showRef && ref.status === "ok"
            ? { lat: ref.ref.lat, lng: ref.ref.lng, name: ref.ref.name }
            : undefined;

    // Inside the configure dialog, defer the map until *both* the
    // seeker pin and the nearest-reference dot are ready. Showing the
    // map while one of them is still resolving meant a flicker of an
    // unrelated centroid, then a fly-to-GPS, then a fit-bounds — three
    // animations the user didn't ask for. Outside the configure dialog
    // (drawer/sidebar render) the map renders as before.
    const mapReady = !forceExpanded || (coordsSet && Boolean(referencePoint));

    return (
        <LatitudeLongitude
            latitude={lat}
            longitude={lng}
            colorName={color as any}
            onChange={onChange}
            disabled={disabled}
            referencePoint={referencePoint}
            // See measuring.tsx: GPS or place-search only inside the
            // configure dialog. Display-only outside.
            lockToGps={forceExpanded}
            mapReady={mapReady}
        />
    );
}
