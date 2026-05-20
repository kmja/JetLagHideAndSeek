import "leaflet/dist/leaflet.css";
import { LocateFixed } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
    MapContainer,
    Marker,
    TileLayer,
    useMap,
    useMapEvents,
} from "react-leaflet";

/**
 * Tap-on-map location picker. Opens as a modal containing a Leaflet map
 * pre-centered on the current question coordinates (or GPS if none).
 * The user taps anywhere on the map to drop a pin, then confirms.
 *
 * Deliberately uses the same dark cartocdn tiles as the main map and the
 * hider view so the visual style is consistent.
 *
 * Performance note: each open mounts a fresh Leaflet instance. That's
 * acceptable because:
 *   - The dialog is short-lived (user picks, confirms, closes)
 *   - Leaflet's startup cost is < 100ms on a mid-range device
 *   - Only one picker is open at a time
 * If this ever becomes a hot path, the map can be cached via a portal
 * or the Leaflet instance pre-warmed.
 */
export function MapPickerDialog({
    open,
    onOpenChange,
    initialLat,
    initialLng,
    onConfirm,
    title = "Set location",
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialLat: number;
    initialLng: number;
    onConfirm: (lat: number, lng: number) => void;
    title?: string;
}) {
    // Picked coordinates — defaults to the initial values when opened so
    // the user can just tap "Set location" without moving anything if
    // their existing location was already right.
    const [picked, setPicked] = useState<{ lat: number; lng: number }>({
        lat: initialLat,
        lng: initialLng,
    });

    // Reset to initial whenever the dialog is reopened with new coords.
    useEffect(() => {
        if (open) setPicked({ lat: initialLat, lng: initialLng });
    }, [open, initialLat, initialLng]);

    const handleConfirm = () => {
        onConfirm(picked.lat, picked.lng);
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0",
                )}
            >
                <div className="px-6 pt-6 pb-3 shrink-0 border-b border-border">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        Tap the map to set the location, or use your GPS.
                    </DialogDescription>
                </div>

                <div className="flex-1 overflow-hidden min-h-0 px-4 py-3">
                    <div className="w-full h-[50vh] rounded-md overflow-hidden border border-border">
                        <MapContainer
                            center={[picked.lat, picked.lng]}
                            zoom={13}
                            scrollWheelZoom={true}
                            style={{ height: "100%", width: "100%" }}
                        >
                            <TileLayer
                                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
                                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                            />
                            <ClickToPlace
                                onPlace={(lat, lng) =>
                                    setPicked({ lat, lng })
                                }
                            />
                            <PickedPin lat={picked.lat} lng={picked.lng} />
                            <RecenterOnPicked
                                lat={picked.lat}
                                lng={picked.lng}
                                recenterKey={`${initialLat},${initialLng}`}
                            />
                        </MapContainer>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 text-xs">
                        <div className="text-muted-foreground tabular-nums truncate min-w-0">
                            {picked.lat.toFixed(5)}, {picked.lng.toFixed(5)}
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5 shrink-0"
                            onClick={() => {
                                if (
                                    typeof navigator === "undefined" ||
                                    !navigator.geolocation
                                ) {
                                    return;
                                }
                                navigator.geolocation.getCurrentPosition(
                                    (pos) =>
                                        setPicked({
                                            lat: pos.coords.latitude,
                                            lng: pos.coords.longitude,
                                        }),
                                    () => {
                                        /* silent — user can still tap to pick */
                                    },
                                    { enableHighAccuracy: true },
                                );
                            }}
                        >
                            <LocateFixed className="w-3.5 h-3.5" />
                            Use my GPS
                        </Button>
                    </div>
                </div>

                <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-end">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button onClick={handleConfirm}>Set location</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Captures map clicks/taps and bubbles them up as a pick event. */
function ClickToPlace({
    onPlace,
}: {
    onPlace: (lat: number, lng: number) => void;
}) {
    useMapEvents({
        click: (e) => {
            onPlace(e.latlng.lat, e.latlng.lng);
        },
    });
    return null;
}

/** Recenters the map when the picked point changes substantially —
 *  i.e. when the user uses the GPS button, not when they tap nearby. */
function RecenterOnPicked({
    lat,
    lng,
    recenterKey,
}: {
    lat: number;
    lng: number;
    recenterKey: string;
}) {
    const map = useMap();
    const [lastKey, setLastKey] = useState(recenterKey);
    useEffect(() => {
        if (recenterKey !== lastKey) {
            map.flyTo([lat, lng], map.getZoom(), { duration: 0.3 });
            setLastKey(recenterKey);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recenterKey]);
    return null;
}

/** Visible pin at the currently-picked spot. The leaflet `divIcon` is
 *  constructed via a dynamic import so leaflet's module body (which touches
 *  `window`) never runs during Astro's server-side static generation. */
function PickedPin({ lat, lng }: { lat: number; lng: number }) {
    const [icon, setIcon] = useState<ReturnType<
        typeof buildPinIcon
    > | null>(null);

    useEffect(() => {
        let cancelled = false;
        import("leaflet").then((L) => {
            if (!cancelled) setIcon(buildPinIcon(L));
        });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!icon) return null;
    return <Marker position={[lat, lng]} icon={icon} />;
}

/** Construct the primary-colored teardrop DivIcon from a loaded leaflet
 *  module. Kept separate so the dynamic-import callsite stays tidy. */
function buildPinIcon(L: typeof import("leaflet")) {
    return new L.DivIcon({
        html: `
<div class="jl-picker-pin">
  <svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 24 14 24s14-13.5 14-24C28 6.27 21.73 0 14 0z" fill="hsl(var(--primary))" stroke="white" stroke-width="2"/>
    <circle cx="14" cy="14" r="5" fill="white"/>
  </svg>
</div>`.trim(),
        className: "jl-picker-pin-wrap",
        iconSize: [28, 38],
        iconAnchor: [14, 36],
    });
}

// Default export so React.lazy(() => import("./MapPickerDialog")) resolves
// directly to this component.
export default MapPickerDialog;
