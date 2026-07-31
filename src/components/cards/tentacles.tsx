import { useStore } from "@nanostores/react";
import React from "react";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { UnitSelect } from "@/components/UnitSelect";
import {
    drawingQuestionKey,
    isLoading,
    isQuestionEditable,
    questionModified,
    questions,
} from "@/lib/context";
import { gameSize } from "@/lib/gameSetup";
import { cleanDescription, isSubtypeAllowed } from "@/lib/subtypes";
import { cn } from "@/lib/utils";
import { findTentacleLocations } from "@/maps/api";
import {
    determineUnionizedStrings,
    NO_GROUP,
    type TentacleQuestion,
    tentacleQuestionSchema,
    type TraditionalTentacleQuestion,
} from "@/maps/schema";

import { QuestionCard } from "./base";

export const TentacleQuestionComponent = ({
    data,
    questionKey,
    forceExpanded,
    sub,
    className,
    compactAnswer,
}: {
    data: TentacleQuestion;
    questionKey: number;
    sub?: string;
    forceExpanded?: boolean;
    className?: string;
    compactAnswer?: boolean;
}) => {
    const $questions = useStore(questions);
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $isLoading = useStore(isLoading);
    const $gameSize = useStore(gameSize);

    // Game rule: each (category, subtype) can only be asked once per game.
    // Cast to Set<string> so we can probe with arbitrary value strings
    // from the schema enumeration without TS narrowing complaints.
    const usedTentacleTypes = React.useMemo<Set<string>>(
        () =>
            new Set(
                $questions
                    .filter(
                        (q) => q.id === "tentacles" && q.key !== questionKey,
                    )
                    .map((q) => (q.data as TentacleQuestion).locationType),
            ),
        [$questions, questionKey],
    );

    const label = `Tentacles
    ${
        $questions
            .filter((q) => q.id === "tentacles")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            category="tentacles"
            summary={
                data.drag
                    ? `${(data.locationType.charAt(0).toUpperCase() + data.locationType.slice(1)).replace(/-/g, " ")} · awaiting answer`
                    : (data.locationType.charAt(0).toUpperCase() +
                          data.locationType.slice(1)).replace(/-/g, " ")
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
            {/* The radius is rulebook-fixed per subtype (museum/library/
                cinema/hospital = 2 km, zoo/aquarium/theme-park/metro = 25 km;
                stamped at creation), so there's no radius/unit picker for a
                standard tentacle — it's determined by the question you chose,
                which is itself gated by game size. Custom tentacles have no
                fixed radius, so they keep the manual control. */}
            {data.locationType === "custom" && (
                <SidebarMenuItem>
                    <div
                        className={cn(
                            MENU_ITEM_CLASSNAME,
                            "gap-2 flex flex-row",
                        )}
                    >
                        <Input
                            type="number"
                            className="rounded-md p-2 w-16"
                            value={data.radius}
                            onChange={(e) =>
                                questionModified(
                                    (data.radius = parseFloat(e.target.value)),
                                )
                            }
                            disabled={!isQuestionEditable(data) || $isLoading}
                        />
                        <UnitSelect
                            unit={data.unit}
                            onChange={(unit) =>
                                questionModified((data.unit = unit))
                            }
                            disabled={!isQuestionEditable(data) || $isLoading}
                        />
                    </div>
                </SidebarMenuItem>
            )}
            {/* v875: the subtype is chosen in the picker step (and named in
                the card header), so the redundant "Location Type" dropdown is
                hidden — matching matching/measuring (v611). Kept in the tree
                (not deleted) so the "custom" tentacle-locations editing path +
                its imports stay intact; only surfaced for an already-custom
                question. */}
            <SidebarMenuItem
                className={cn(
                    MENU_ITEM_CLASSNAME,
                    data.locationType !== "custom" && "hidden",
                )}
            >
                <Select
                    trigger="Location Type"
                    options={Object.fromEntries(
                        tentacleQuestionSchema.options
                            .filter((x) => x.description === NO_GROUP)
                            .flatMap((x) =>
                                determineUnionizedStrings(x.shape.locationType),
                            )
                            .map((x) => [
                                (x._def as any).value,
                                cleanDescription(x.description),
                            ])
                            .filter(
                                ([value, _]) =>
                                    (!usedTentacleTypes.has(value as string) ||
                                        value === data.locationType) &&
                                    (isSubtypeAllowed(value as string, $gameSize) ||
                                        value === data.locationType),
                            ),
                    )}
                    groups={Object.fromEntries(
                        tentacleQuestionSchema.options
                            .filter((x) => x.description !== NO_GROUP)
                            .map((x) => [
                                x.description,
                                Object.fromEntries(
                                    determineUnionizedStrings(
                                        x.shape.locationType,
                                    )
                                        .map((x) => [
                                            (x._def as any).value,
                                            cleanDescription(x.description),
                                        ])
                                        .filter(
                                            ([value, _]) =>
                                                (!usedTentacleTypes.has(
                                                    value as string,
                                                ) ||
                                                    value ===
                                                        data.locationType) &&
                                                (isSubtypeAllowed(
                                                    value as string,
                                                    $gameSize,
                                                ) ||
                                                    value ===
                                                        data.locationType),
                                        ),
                                ),
                            ]),
                    )}
                    value={data.locationType}
                    onValueChange={async (value) => {
                        if (value === "custom") {
                            const priorLocations = await findTentacleLocations(
                                data as TraditionalTentacleQuestion,
                            );

                            data.locationType = "custom";
                            data.places = priorLocations.features.map((x) => ({
                                ...x,
                                properties: {
                                    ...x.properties,
                                    name:
                                        x.properties?.["name:en"] ??
                                        x.properties?.name,
                                },
                            }));
                            data.location = false;
                        } else {
                            data.location = false;
                            data.locationType = value;
                        }
                        questionModified();
                    }}
                    disabled={!isQuestionEditable(data) || $isLoading}
                />
            </SidebarMenuItem>
            {data.locationType === "custom" && data.drag && (
                <>
                    <p className="px-2 mb-1 text-center text-orange-500">
                        To modify tentacle locations, enable it:
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
                            disabled={!isQuestionEditable(data) || $isLoading}
                        />
                        and use the buttons at the bottom left of the map.
                    </p>
                    <div className="flex justify-center mb-2">
                        <PresetsDialog
                            data={data}
                            presetTypeHint="custom-tentacles"
                        />
                    </div>
                </>
            )}
            <LatitudeLongitude
                latitude={data.lat}
                longitude={data.lng}
                colorName={data.color}
                onChange={(lat, lng) => {
                    // Location is immutable once the question is sent —
                    // drop writes (incl. the picker's GPS auto-seed) for
                    // committed questions.
                    if (!isQuestionEditable(data)) return;
                    if (lat !== null) {
                        data.lat = lat;
                    }
                    if (lng !== null) {
                        data.lng = lng;
                    }
                    questionModified();
                }}
                disabled={!isQuestionEditable(data) || $isLoading}
                // The tentacle reach is centred on the SEEKER's own
                // position, so lock the pin to GPS — tapping the map must
                // not relocate it (and, once a fix lands, it renders as the
                // canonical blue "you are here" dot, not a placeable
                // teardrop). Custom tentacles place their own points, so
                // they stay free-pick.
                lockToGps={data.locationType !== "custom"}
                // v239: draw the tentacle reach circle + every candidate
                // on the picker map so the seeker reads the density.
                impactMode={
                    forceExpanded && data.locationType !== "custom"
                        ? "tentacles"
                        : undefined
                }
                impactType={data.locationType}
                tentacleRadiusKm={data.radius}
            />
        </QuestionCard>
    );
};
