import { useStore } from "@nanostores/react";
import { DivIcon, type DragEndEvent, Icon } from "leaflet";
import { useState } from "react";
import { Fragment } from "react/jsx-runtime";
import { Marker, Polyline } from "react-leaflet";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { buildMarkerHtml, type CategoryId } from "@/lib/categories";
import {
    autoSave,
    hiderMode,
    questionModified,
    questions,
    save,
    triggerLocalRefresh,
} from "@/lib/context";
import type { ICON_COLORS } from "@/maps/api";

import { LatitudeLongitude } from "./LatLngPicker";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";
import { Button } from "./ui/button";
import { SidebarMenu } from "./ui/sidebar-l";

let isDragging = false;

const ColoredMarker = ({
    latitude,
    longitude,
    color,
    onChange,
    questionKey,
    sub = "",
}: {
    onChange: (event: DragEndEvent) => void;
    latitude: number;
    longitude: number;
    color: keyof typeof ICON_COLORS;
    questionKey: number;
    sub?: string;
}) => {
    const $questions = useStore(questions);
    const $hiderMode = useStore(hiderMode);
    const $autoSave = useStore(autoSave);
    const [open, setOpen] = useState(false);

    // Prefer category-coded SVG markers (matched to the question's id);
    // fall back to the legacy color-coded PNG icon when there's no
    // matching question (e.g. transient marker for the hider's location).
    const matchedQuestion = $questions.find((q) => q.key === questionKey);
    const category = matchedQuestion?.id as CategoryId | undefined;

    const pending = Boolean(matchedQuestion?.data?.drag);
    const icon = category
        ? new DivIcon({
              html: buildMarkerHtml(category, pending),
              className: "jl-marker",
              iconSize: [34, 46],
              iconAnchor: [17, 43],
          })
        : color
          ? new Icon({
                iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
                shadowUrl:
                    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png",
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41],
            })
          : undefined;

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <Marker
                position={[latitude, longitude]}
                icon={icon}
                draggable={true}
                eventHandlers={{
                    dragstart: () => {
                        isDragging = true;
                    },
                    dragend: (x) => {
                        onChange(x);
                        setTimeout(() => {
                            isDragging = false;
                        }, 100);
                    },
                    click: () => {
                        if (!isDragging) {
                            setOpen(true);
                        }
                    },
                }}
            />
            <DialogContent className="!bg-[hsl(var(--sidebar-background))] !text-white">
                {questionKey === -1 && $hiderMode !== false && (
                    <>
                        <h2 className="text-center text-2xl font-bold font-poppins">
                            {sub}
                        </h2>
                        <SidebarMenu>
                            <LatitudeLongitude
                                latitude={$hiderMode.latitude}
                                longitude={$hiderMode.longitude}
                                inlineEdit
                                onChange={(latitude, longitude) => {
                                    hiderMode.set({
                                        latitude:
                                            latitude ?? $hiderMode.latitude,
                                        longitude:
                                            longitude ?? $hiderMode.longitude,
                                    });
                                }}
                                label="Hider Location"
                            />
                        </SidebarMenu>
                    </>
                )}
                {$questions
                    .filter((q) => q.key === questionKey)
                    .map((q) => {
                        switch (q.id) {
                            case "radius":
                                return (
                                    <RadiusQuestionComponent
                                        key={q.key}
                                        data={q.data}
                                        questionKey={q.key}
                                        sub={sub}
                                    />
                                );
                            case "tentacles":
                                return (
                                    <TentacleQuestionComponent
                                        key={q.key}
                                        data={q.data}
                                        questionKey={q.key}
                                        sub={sub}
                                    />
                                );
                            case "thermometer":
                                return (
                                    <ThermometerQuestionComponent
                                        key={q.key}
                                        data={q.data}
                                        questionKey={q.key}
                                        sub={sub}
                                    />
                                );
                            case "matching":
                                return (
                                    <MatchingQuestionComponent
                                        key={q.key}
                                        data={q.data}
                                        questionKey={q.key}
                                        sub={sub}
                                    />
                                );
                            case "measuring":
                                return (
                                    <MeasuringQuestionComponent
                                        key={q.key}
                                        data={q.data}
                                        questionKey={q.key}
                                        sub={sub}
                                    />
                                );
                            default:
                                return null;
                        }
                    })}
                {questionKey === -1 && (
                    <Button // If it's the hider mode marker
                        onClick={() => {
                            hiderMode.set(false);
                        }}
                        variant="destructive"
                        className="font-semibold font-poppins"
                    >
                        Disable
                    </Button>
                )}
                {!$autoSave && (
                    <button
                        onClick={save}
                        className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500"
                    >
                        Save
                    </button>
                )}
            </DialogContent>
        </Dialog>
    );
};

export const DraggableMarkers = () => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $hiderMode = useStore(hiderMode);

    return (
        <Fragment>
            {$hiderMode !== false && (
                <ColoredMarker
                    color="green"
                    key="hider"
                    sub="Hider Location"
                    questionKey={-1}
                    latitude={$hiderMode.latitude}
                    longitude={$hiderMode.longitude}
                    onChange={(e) => {
                        $hiderMode.latitude =
                            e.target.getLatLng().lat ?? $hiderMode.latitude;
                        $hiderMode.longitude =
                            e.target.getLatLng().lng ?? $hiderMode.longitude;

                        if (autoSave.get()) {
                            hiderMode.set({
                                ...$hiderMode,
                            });
                        } else {
                            triggerLocalRefresh.set(Math.random());
                        }
                    }}
                />
            )}
            {$questions.map((question) => {
                if (!question.data) return null;
                if (!question.data.drag) return null;
                if (
                    question.id === "matching" &&
                    question.data.type === "custom-zone"
                )
                    return null;

                switch (question.id) {
                    case "radius":
                    case "tentacles":
                    case "matching":
                    case "measuring":
                        return (
                            <ColoredMarker
                                color={question.data.color}
                                key={question.key}
                                questionKey={question.key}
                                latitude={question.data.lat}
                                longitude={question.data.lng}
                                onChange={(e) => {
                                    question.data.lat =
                                        e.target.getLatLng().lat;
                                    question.data.lng =
                                        e.target.getLatLng().lng;
                                    questionModified();
                                }}
                            />
                        );
                    case "thermometer":
                        return (
                            <Fragment key={question.key}>
                                <Polyline
                                    positions={[
                                        [
                                            question.data.latA,
                                            question.data.lngA,
                                        ],
                                        [
                                            question.data.latB,
                                            question.data.lngB,
                                        ],
                                    ]}
                                    pathOptions={{
                                        color: "#f5d268",
                                        weight: 3,
                                        dashArray: "8 6",
                                        opacity: 0.9,
                                    }}
                                />
                                <Marker
                                    position={thermometerArrowPos(
                                        question.data.latA,
                                        question.data.lngA,
                                        question.data.latB,
                                        question.data.lngB,
                                    )}
                                    icon={thermometerArrowIcon(
                                        bearingDeg(
                                            question.data.latA,
                                            question.data.lngA,
                                            question.data.latB,
                                            question.data.lngB,
                                        ),
                                    )}
                                    interactive={false}
                                    keyboard={false}
                                />
                                <ColoredMarker
                                    color={question.data.colorA}
                                    key={"a" + question.key.toString()}
                                    questionKey={question.key}
                                    sub="Start"
                                    latitude={question.data.latA}
                                    longitude={question.data.lngA}
                                    onChange={(e) => {
                                        question.data.latA =
                                            e.target.getLatLng().lat;
                                        question.data.lngA =
                                            e.target.getLatLng().lng;
                                        questionModified();
                                    }}
                                />
                                <ColoredMarker
                                    color={question.data.colorB}
                                    key={"b" + question.key.toString()}
                                    questionKey={question.key}
                                    sub="End"
                                    latitude={question.data.latB}
                                    longitude={question.data.lngB}
                                    onChange={(e) => {
                                        question.data.latB =
                                            e.target.getLatLng().lat;
                                        question.data.lngB =
                                            e.target.getLatLng().lng;
                                        questionModified();
                                    }}
                                />
                            </Fragment>
                        );
                    default:
                        return null;
                }
            })}
        </Fragment>
    );
};

/**
 * Compute the initial bearing (degrees, 0 = north, clockwise) between two
 * lat/lng points. Used to orient the directional arrowhead drawn on the
 * thermometer line so it points from A → B.
 */
function bearingDeg(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dLambda = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x =
        Math.cos(phi1) * Math.sin(phi2) -
        Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Position the arrowhead at ~80% of the way from A to B, so it floats just
 * inside the End marker rather than overlapping it. Uses linear
 * interpolation in lat/lng space — good enough for this scale; we don't
 * need great-circle geometry for a visual indicator.
 */
function thermometerArrowPos(
    latA: number,
    lngA: number,
    latB: number,
    lngB: number,
): [number, number] {
    const t = 0.5;
    return [latA + t * (latB - latA), lngA + t * (lngB - lngA)];
}

/**
 * SVG arrowhead DivIcon, rotated to align with the bearing from A → B.
 * The SVG's "up" (negative-y) is the forward direction; CSS rotate uses
 * clockwise degrees from up, which matches our bearing convention.
 */
function thermometerArrowIcon(bearing: number): DivIcon {
    const html = `
<div class="jl-thermometer-arrow" style="transform: rotate(${bearing.toFixed(1)}deg);">
  <svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <polygon points="10,1 18,17 10,13 2,17" fill="#f5d268" stroke="#3a3a2a" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>
</div>`.trim();
    return new DivIcon({
        html,
        className: "jl-thermometer-arrow-wrap",
        iconSize: [20, 20],
        iconAnchor: [10, 10],
    });
}
