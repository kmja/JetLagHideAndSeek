import { useStore } from "@nanostores/react";
import { Compass, Locate, LocateOff, Radio, RadioReceiver } from "lucide-react";
import type { MutableRefObject } from "react";
import type { MapRef } from "react-map-gl/maplibre";

import { followMe } from "@/lib/context";
import { cn } from "@/lib/utils";

/**
 * Two stacked "classic map" controls, rendered as floating buttons on
 * every interactive map (seeker map, hider background map, inline
 * question picker):
 *
 *   • Follow me — toggle the persisted `followMe` atom. While ON, the
 *     seeker/hider map re-centers on the live GPS fix as it moves.
 *     The icon flips between an active "locate" filled cross-hair and
 *     a struck-through version so the state is obvious at a glance.
 *   • Reset rotation + tilt — eases the map back to north-up, no
 *     pitch. Only enabled when the map is currently rotated or tilted
 *     (saves a visual control when there's nothing to reset).
 *
 * Stateless aside from the followMe atom subscription — the reset
 * action talks directly to the MapLibre instance via the ref the
 * parent already owns. Mounted as a sibling of MapGL so it isn't
 * caught up in the map's gesture surface.
 */
export function MapNavControls({
    mapRef,
    showFollowMe = true,
    gpsSharing,
    onToggleGpsShare,
    className,
}: {
    mapRef: MutableRefObject<MapRef | null>;
    /** Hide the follow-me toggle on maps that don't track live GPS
     *  (e.g. the inline question picker — it has its own pin). */
    showFollowMe?: boolean;
    /** Seeker map only: when `onToggleGpsShare` is provided, a small
     *  GPS-sharing status button renders above follow-me (green while
     *  sharing live position with the hider, muted when paused). v834:
     *  moved here from the manually-reopened lobby. */
    gpsSharing?: boolean;
    onToggleGpsShare?: () => void;
    className?: string;
}) {
    const $follow = useStore(followMe);

    const resetView = () => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        map.easeTo({ bearing: 0, pitch: 0, duration: 300 });
    };

    return (
        <div
            className={cn(
                "absolute z-10 flex flex-col gap-1.5 pointer-events-none",
                className,
            )}
        >
            {onToggleGpsShare && (
                <button
                    type="button"
                    onClick={onToggleGpsShare}
                    aria-label={
                        gpsSharing
                            ? "Sharing your location with the hider — tap to pause"
                            : "Location sharing paused — tap to resume"
                    }
                    aria-pressed={gpsSharing}
                    title={
                        gpsSharing
                            ? "Sharing your location with the hider — tap to pause"
                            : "Location sharing paused — tap to resume"
                    }
                    className={cn(
                        "pointer-events-auto h-10 w-10 rounded-md border-2 shadow-md transition-colors",
                        "flex items-center justify-center",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        gpsSharing
                            ? "bg-success border-success text-success-foreground hover:bg-success/90"
                            : "bg-background border-border text-muted-foreground hover:bg-accent",
                    )}
                >
                    {gpsSharing ? (
                        <Radio className="h-5 w-5" />
                    ) : (
                        <RadioReceiver className="h-5 w-5" />
                    )}
                </button>
            )}
            {showFollowMe && (
                <button
                    type="button"
                    onClick={() => followMe.set(!$follow)}
                    aria-label={
                        $follow
                            ? "Stop following my location"
                            : "Follow my location"
                    }
                    aria-pressed={$follow}
                    title={
                        $follow
                            ? "Stop following my location"
                            : "Follow my location"
                    }
                    className={cn(
                        "pointer-events-auto h-10 w-10 rounded-md border-2 shadow-md transition-colors",
                        "flex items-center justify-center",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        $follow
                            ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                            : "bg-background border-border text-foreground hover:bg-accent",
                    )}
                >
                    {$follow ? (
                        <Locate className="h-5 w-5" />
                    ) : (
                        <LocateOff className="h-5 w-5" />
                    )}
                </button>
            )}
            <button
                type="button"
                onClick={resetView}
                aria-label="Reset map rotation and tilt"
                title="Reset rotation + tilt"
                className={cn(
                    "pointer-events-auto h-10 w-10 rounded-md border-2 shadow-md transition-colors",
                    "flex items-center justify-center",
                    "bg-background border-border text-foreground hover:bg-accent",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
            >
                <Compass className="h-5 w-5" />
            </button>
        </div>
    );
}

export default MapNavControls;
