import { toast } from "react-toastify";

import {
    disabledStations,
    mapContext,
    mapGeoJSON,
    mapGeoLocation,
    permanentOverlay,
    polyGeoJSON,
    questions,
} from "@/lib/context";
import { playArea } from "@/lib/gameSetup";
import { determineName, type OpenStreetMap } from "@/maps/api";
import { triggerPolygonsOsmFrBuild } from "@/maps/api/polygonsOsmFr";

/**
 * Commit a NEW primary play-area selection live — the shared side effects
 * behind both the setup wizard's "Save changes" (`GameSetupDialog`) and the
 * lobby's dedicated "Edit play area" dialog (v838). Sets `playArea` +
 * `mapGeoLocation`, pre-builds the boundary polygon, and WIPES questions +
 * the zone/overlay caches (the old questions are no longer geographically
 * valid once the area moves). Fires the "questions cleared" toast.
 *
 * Does NOT push to peers (`hostPushSetup`) or close any dialog — the caller
 * owns those.
 */
export function commitPlayAreaChange(feature: OpenStreetMap): void {
    const coords = feature.geometry.coordinates as number[];
    const [lat, lng] = coords;
    playArea.set({ displayName: determineName(feature), lat, lng });
    mapGeoLocation.set(feature);
    // Pre-build the polygons.osm.fr polygon so the boundary fast-path racer
    // has one ready by the time the map loads (idempotent per relation).
    if (feature.properties.osm_type === "R") {
        triggerPolygonsOsmFrBuild(feature.properties.osm_id);
    }
    questions.set([]);
    mapGeoJSON.set(null);
    polyGeoJSON.set(null);
    disabledStations.set([]);
    permanentOverlay.set(null);
    const map = mapContext.get();
    map?.flyTo([lat, lng], 11, { duration: 0.6 });
    toast.info("Play area updated — questions cleared.", { autoClose: 3000 });
}
