/**
 * Canonical "you are here" marker (v347).
 *
 * Used everywhere the app needs to show the local user's OWN live GPS
 * position on a map — the seeker's blue dot on the main map, the
 * hider's blue dot on their answer overlay and home screen, the
 * question-picker map's pin in lock-to-GPS mode. Before this component
 * existed each call site styled the dot independently (different
 * shades of blue, different sizes, some with pulse, some without),
 * which looked inconsistent across views.
 *
 * Visual: 18 px solid blue circle (#2A81CB — the standard Leaflet /
 * mapping-app "you are here" color) with a 3 px white border and a
 * soft drop-shadow. Optional subtle pulse ring for views where the
 * marker should draw the eye (the hider home, where it's the primary
 * focal point).
 *
 * Wrap in a `<Marker>` from react-map-gl (anchor="center") at the
 * lat/lng you want — this component is the inner content only.
 */
export interface SelfPositionMarkerProps {
    /** Optional accessible label override; defaults to "Your position". */
    label?: string;
    /** Show a subtle pulsing accuracy ring around the dot. Off by
     *  default — used by the hider's home view where the dot is the
     *  main focal point. */
    pulse?: boolean;
}

export function SelfPositionMarker({
    label = "Your position",
    pulse = false,
}: SelfPositionMarkerProps) {
    return (
        <div
            className="relative flex items-center justify-center"
            aria-label={label}
        >
            {pulse && (
                <span
                    aria-hidden
                    className="absolute w-7 h-7 rounded-full bg-[#2A81CB]/30 animate-ping pointer-events-none"
                />
            )}
            <span
                title={label}
                style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "#2A81CB",
                    border: "3px solid white",
                    boxShadow:
                        "0 0 0 1px #2A81CB, 0 1px 4px rgba(0,0,0,0.5)",
                }}
            />
        </div>
    );
}

export default SelfPositionMarker;
