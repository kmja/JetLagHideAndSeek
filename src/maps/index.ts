import type { Feature, FeatureCollection } from "geojson";

import {
    adjustPerMatching,
    hiderifyMatching,
    matchingPlanningPolygon,
} from "./questions/matching";
import {
    adjustPerMeasuring,
    hiderifyMeasuring,
    measuringPlanningPolygon,
} from "./questions/measuring";
import {
    adjustPerRadius,
    hiderifyRadius,
    radiusPlanningPolygon,
} from "./questions/radius";
import {
    adjustPerTentacle,
    hiderifyTentacles,
    tentaclesPlanningPolygon,
} from "./questions/tentacles";
import {
    adjustPerThermometer,
    hiderifyThermometer,
    thermometerPlanningPolygon,
} from "./questions/thermometer";
import type { Question, Questions } from "./schema";

export * from "./geo-utils";

export const hiderifyQuestion = async (question: Question) => {
    if (question.data.drag) {
        switch (question.id) {
            case "radius":
                question.data = hiderifyRadius(question.data);
                break;
            case "thermometer":
                question.data = await hiderifyThermometer(question.data);
                break;
            case "tentacles":
                question.data = await hiderifyTentacles(question.data);
                break;
            case "matching":
                question.data = await hiderifyMatching(question.data);
                break;
            case "measuring":
                question.data = await hiderifyMeasuring(question.data);
                break;
        }
    }

    return question;
};

export const determinePlanningPolygon = async (
    question: Question,
    planningModeEnabled: boolean,
) => {
    // Show the preview polygon whenever the question is still a draft
    // (`drag: true`) — the seeker is configuring it and needs to see its
    // effect on the map. This used to require planning mode to be enabled,
    // but with the new draft/answer flow every unanswered question is
    // effectively in planning mode. `planningModeEnabled` is accepted but
    // intentionally unused.
    void planningModeEnabled;
    if (question.data.drag) {
        switch (question.id) {
            case "radius":
                return radiusPlanningPolygon(question.data);
            case "thermometer":
                return thermometerPlanningPolygon(question.data);
            case "tentacles":
                return tentaclesPlanningPolygon(question.data);
            case "matching":
                return matchingPlanningPolygon(question.data);
            case "measuring":
                return measuringPlanningPolygon(question.data);
        }
    }
};

export async function adjustMapGeoDataForQuestion(
    question: any,
    mapGeoData: any,
) {
    try {
        switch (question?.id) {
            case "radius":
                return await adjustPerRadius(question.data, mapGeoData);
            case "thermometer":
                return await adjustPerThermometer(question.data, mapGeoData);
            case "tentacles":
                if (question.data.location === false) {
                    return adjustPerRadius(
                        { ...question.data, within: false },
                        mapGeoData,
                    );
                }
                return await adjustPerTentacle(question.data, mapGeoData);
            case "matching":
                return await adjustPerMatching(question.data, mapGeoData);
            case "measuring":
                return await adjustPerMeasuring(question.data, mapGeoData);
            default:
                return mapGeoData;
        }
    } catch {
        return mapGeoData;
    }
}

export async function applyQuestionsToMapGeoData(
    questions: Questions,
    mapGeoData: any,
    planningModeEnabled: boolean,
    planningModeCallback?: (
        polygon: FeatureCollection | Feature,
        question: any,
    ) => void,
): Promise<any> {
    for (const question of questions) {
        if (planningModeCallback) {
            const planningPolygon = await determinePlanningPolygon(
                question,
                planningModeEnabled,
            );
            if (planningPolygon) {
                planningModeCallback(planningPolygon, question);
            }
        }
        // A question with `drag: true` is "draft / awaiting answer" — the
        // seeker has asked it but the hider hasn't replied yet, so we must
        // NOT bake the schema-default answer (e.g. `within: true`) into the
        // map mask. The user commits the question by tapping the lock icon
        // on the card or by interacting with the answer toggle, both of
        // which flip `drag: false`. (Upstream only honored this in planning
        // mode; we honor it always — see #5 in the recent feedback.)
        if (question.data.drag) {
            continue;
        }
        // Vetoed questions carry no answer — the hider played the Veto
        // card — so they must eliminate NOTHING (the schema-default
        // answer like `within:true` would otherwise mask the map).
        // `randomizedAway` is the same case: the ORIGINAL question that
        // Randomize redirected away (its auto-answered substitute is a
        // separate question that does the elimination).
        if (
            (question.data as { vetoed?: boolean }).vetoed ||
            (question.data as { randomizedAway?: boolean }).randomizedAway
        ) {
            continue;
        }

        // v389: one failing elimination must not zero the others. The
        // visible bug was an app reload after a deploy: the @arcgis/core
        // lazy chunk hadn't activated through the new service worker yet,
        // adjustPerRadius's arcBuffer call threw, the outer try/catch in
        // Map.tsx kept `working = inner`, and the user saw the full
        // unmasked play area while the answered Radar question still sat
        // in the questions log. Per-question try/catch preserves the
        // already-accumulated mapGeoData and continues with the next
        // question. Logged loudly with a key so console grep can find it.
        try {
            const next = await adjustMapGeoDataForQuestion(
                question,
                mapGeoData,
            );
            // Guard against adjusters that early-return undefined on null
            // input — would crash the `.type` check below and propagate to
            // every later question via mapGeoData=undefined.
            if (next == null) continue;
            mapGeoData = next;
        } catch (e) {
            console.warn(
                `[applyQuestionsToMapGeoData] question key=${
                    (question as { key?: number }).key ?? "?"
                } id=${question.id} elimination threw:`,
                e,
            );
            continue;
        }

        if (mapGeoData.type !== "FeatureCollection") {
            mapGeoData = {
                type: "FeatureCollection",
                features: [mapGeoData],
            };
        }
    }
    return mapGeoData;
}
