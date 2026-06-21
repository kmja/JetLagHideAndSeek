import { useStore } from "@nanostores/react";
import { OpenLocationCode } from "open-location-code";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebounce } from "@/hooks/useDebounce";
import { allowGooglePlusCodes, isLoading } from "@/lib/context";
import type { ImpactMode } from "@/lib/questionImpact";
import { cn } from "@/lib/utils";
import {
    determineName,
    geocode,
    ICON_COLORS,
    reverseGeocode,
} from "@/maps/api";

import { Button } from "./ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "./ui/command";
import { Separator } from "./ui/separator";
import { SidebarMenuItem } from "./ui/sidebar-l";

// Lazy-loaded to keep maplibre-gl (~880 KB) off the critical path —
// LatitudeLongitude is imported widely but the inline map only renders
// inside a question's configure dialog, so deferring its chunk until
// first open keeps the initial bundle lean. (Historical note: this
// comment used to cite react-leaflet + the Astro SSR "window is not
// defined" crash — both are gone. Every map is maplibre now, and the
// app is a client-rendered SPA, so there's no SSR import graph to
// protect. The lazy() is now purely a bundle-size optimisation.)
const InlineLocationPicker = lazy(() => import("./InlineLocationPicker"));

const parseCoordinatesFromText = (
    text: string,
): { lat: number | null; lng: number | null } => {
    // Format: decimal degrees (e.g., 37.7749, -122.4194 or 37,7749, -122,4194)
    const decimalPattern = /(-?\d+[.,]\d+)\s*,\s*(-?\d+[.,]\d+)/;

    // Format: degrees, minutes, seconds (e.g., 37°46'26"N, 122°25'10"W)
    const dmsPattern =
        /(\d+)°\s*(\d+)['′]?\s*(?:(\d+(?:\.\d+)?)["″]?\s*)?([NS])[,\s]+(\d+)°\s*(\d+)['′]?\s*(?:(\d+(?:\.\d+)?)["″]?\s*)?([EW])/i;

    // Format: decimal degrees with cardinal directions (e.g., 48,89607° N, 9,09885° E or 48.89607° N, 9.09885° E)
    const decimalCardinalPattern =
        /(\d+[.,]\d+)°\s*([NS])\s*,\s*(\d+[.,]\d+)°\s*([EW])/i;

    const decimalMatch = text.match(decimalPattern);
    if (decimalMatch) {
        return {
            lat: parseFloat(decimalMatch[1].replace(",", ".")),
            lng: parseFloat(decimalMatch[2].replace(",", ".")),
        };
    }

    const dmsMatch = text.match(dmsPattern);
    if (dmsMatch) {
        let lat =
            parseInt(dmsMatch[1]) +
            parseInt(dmsMatch[2]) / 60 +
            (parseFloat(dmsMatch[3]) || 0) / 3600;
        let lng =
            parseInt(dmsMatch[5]) +
            parseInt(dmsMatch[6]) / 60 +
            (parseFloat(dmsMatch[7]) || 0) / 3600;

        if (dmsMatch[4].toUpperCase() === "S") lat = -lat;
        if (dmsMatch[8].toUpperCase() === "W") lng = -lng;

        return { lat, lng };
    }

    const decimalCardinalMatch = text.match(decimalCardinalPattern);
    if (decimalCardinalMatch) {
        let lat = parseFloat(decimalCardinalMatch[1].replace(",", "."));
        let lng = parseFloat(decimalCardinalMatch[3].replace(",", "."));

        if (decimalCardinalMatch[2].toUpperCase() === "S") lat = -lat;
        if (decimalCardinalMatch[4].toUpperCase() === "W") lng = -lng;

        return { lat, lng };
    }

    return { lat: null, lng: null };
};

/**
 * Standalone place-search field. Renders a Photon-backed search box
 * that, on result selection, writes back via `onPick(lat, lng)`. The
 * matching/measuring configure dialogs use this as the manual fallback
 * when GPS is denied (the map picker is otherwise display-only).
 */
const PlaceSearchInput = ({
    onPick,
    placeholder = "Search a place to set location...",
    disabled,
}: {
    onPick: (lat: number, lng: number) => void;
    placeholder?: string;
    disabled?: boolean;
}) => {
    const [inputValue, setInputValue] = useState("");
    const debouncedValue = useDebounce<string>(inputValue);
    const [results, setResults] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    useEffect(() => {
        if (debouncedValue === "") {
            setResults([]);
            setError(false);
            return;
        }
        setLoading(true);
        setResults([]);
        geocode(debouncedValue, "en", false)
            .then((x) => {
                setResults(x);
                setLoading(false);
            })
            .catch(() => {
                setError(true);
                setLoading(false);
            });
    }, [debouncedValue]);

    return (
        <Command shouldFilter={false}>
            <CommandInput
                placeholder={placeholder}
                onKeyUp={(x) => setInputValue(x.currentTarget.value)}
                disabled={disabled}
            />
            {(inputValue !== "" || results.length > 0) && (
                <CommandList>
                    <CommandEmpty>
                        {loading
                            ? "Loading..."
                            : error
                              ? "Error loading places."
                              : "No locations found."}
                    </CommandEmpty>
                    <CommandGroup>
                        {results.map((result) => (
                            <CommandItem
                                key={`${result.properties.osm_id}${result.properties.name}`}
                                onSelect={() => {
                                    const coords = result.geometry.coordinates;
                                    onPick(coords[1], coords[0]);
                                    setInputValue("");
                                    setResults([]);
                                }}
                                className="cursor-pointer"
                            >
                                {determineName(result)}
                            </CommandItem>
                        ))}
                    </CommandGroup>
                </CommandList>
            )}
        </Command>
    );
};

const LatLngEditForm = ({
    latitude,
    longitude,
    onChange,
    disabled,
}: {
    latitude: number;
    longitude: number;
    onChange: (lat: number | null, lng: number | null) => void;
    disabled?: boolean;
}) => {
    const [inputValue, setInputValue] = useState("");
    const debouncedValue = useDebounce<string>(inputValue);
    const [results, setResults] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const $allowGooglePlusCodes = useStore(allowGooglePlusCodes);
    const googlePlusCodesRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (debouncedValue === "") {
            setResults([]);
            return;
        } else {
            setLoading(true);
            setResults([]);
            geocode(debouncedValue, "en", false)
                .then((x) => {
                    setResults(x);
                    setLoading(false);
                })
                .catch(() => {
                    setError(true);
                    setLoading(false);
                });
        }
    }, [debouncedValue]);

    const _latlngLabels = results.map((r) => determineName(r));
    const _latlngLabelCounts: Record<string, number> = {};
    _latlngLabels.forEach((l) => {
        _latlngLabelCounts[l] = (_latlngLabelCounts[l] || 0) + 1;
    });
    const _latlngLabelByKey: Record<string, string> = {};
    const _latlngOcc: Record<string, number> = {};
    results.forEach((r) => {
        const key = `${r.properties.osm_id}${r.properties.name}`;
        const lbl = determineName(r);
        const idx = (_latlngOcc[lbl] = (_latlngOcc[lbl] || 0) + 1);
        _latlngLabelByKey[key] =
            _latlngLabelCounts[lbl] > 1 ? `${lbl} (${idx})` : lbl;
    });

    return (
        <>
            <Command shouldFilter={false}>
                <CommandInput
                    placeholder="Search place..."
                    onKeyUp={(x) => setInputValue(x.currentTarget.value)}
                    disabled={disabled}
                />
                <CommandList>
                    <CommandEmpty>
                        {loading
                            ? "Loading..."
                            : error
                              ? "Error loading places."
                              : "No locations found."}
                    </CommandEmpty>
                    <CommandGroup>
                        {results.map((result) => (
                            <CommandItem
                                key={`${result.properties.osm_id}${result.properties.name}`}
                                onSelect={() => {
                                    const coords = result.geometry.coordinates;
                                    onChange(coords[0], coords[1]);
                                }}
                                className="cursor-pointer"
                            >
                                {(() => {
                                    const _key = `${result.properties.osm_id}${result.properties.name}`;
                                    return (
                                        _latlngLabelByKey[_key] ||
                                        determineName(result)
                                    );
                                })()}
                            </CommandItem>
                        ))}
                    </CommandGroup>
                </CommandList>
            </Command>
            <div className="flex gap-2 items-center">
                <Label className="min-w-16">Latitude</Label>
                <Input
                    type="number"
                    value={Math.abs(latitude)}
                    min={0}
                    max={90}
                    onChange={(e) => {
                        if (isNaN(parseFloat(e.target.value))) return;
                        onChange(
                            parseFloat(e.target.value) *
                                (latitude !== 0 ? Math.sign(latitude) : -1),
                            null,
                        );
                    }}
                    disabled={disabled}
                />
                <Button
                    variant="outline"
                    onClick={() => onChange(-latitude, null)}
                    disabled={disabled}
                >
                    {latitude > 0 ? "N" : "S"}
                </Button>
            </div>
            <div className="flex gap-2 items-center">
                <Label className="min-w-16">Longitude</Label>
                <Input
                    type="number"
                    value={Math.abs(longitude)}
                    min={0}
                    max={180}
                    onChange={(e) => {
                        if (isNaN(parseFloat(e.target.value))) return;
                        onChange(
                            null,
                            parseFloat(e.target.value) *
                                (longitude !== 0 ? Math.sign(longitude) : -1),
                        );
                    }}
                    disabled={disabled}
                />
                <Button
                    variant="outline"
                    onClick={() => onChange(null, -longitude)}
                    disabled={disabled}
                >
                    {longitude > 0 ? "E" : "W"}
                </Button>
            </div>

            {$allowGooglePlusCodes && (
                <>
                    <Separator />

                    <div className="flex gap-2 items-center">
                        <Label className="min-w-32">Google Plus Code</Label>
                        <Input
                            type="text"
                            disabled={disabled}
                            ref={googlePlusCodesRef}
                            placeholder="i.e., Q9CM+3P Narita, Chiba, Japan"
                        />
                        <Button
                            variant="secondary"
                            onClick={async () => {
                                if (!googlePlusCodesRef.current) return;
                                const code =
                                    googlePlusCodesRef.current.value.trim();
                                if (code === "") return;

                                const olc =
                                    new OpenLocationCode() as typeof OpenLocationCode;

                                let codeBase = code.split(" ")[0];

                                if (!olc.isValid(codeBase)) {
                                    toast.error("Invalid Google Plus code");
                                    return;
                                }

                                if (olc.isShort(codeBase)) {
                                    const location = code.split(" ")[1];

                                    setLoading(true);

                                    const geo = await geocode(
                                        location,
                                        "en",
                                        false,
                                    );

                                    if (geo.length === 0) {
                                        toast.error(
                                            "Could not resolve location for short code",
                                        );
                                        setLoading(false);
                                        return;
                                    }

                                    const center = geo[0].geometry.coordinates;

                                    codeBase = olc.recoverNearest(
                                        codeBase,
                                        center[0],
                                        center[1],
                                    );

                                    setLoading(false);
                                }

                                const coordinates = olc.decode(codeBase);

                                onChange(
                                    coordinates.latitudeCenter,
                                    coordinates.longitudeCenter,
                                );
                            }}
                            disabled={disabled}
                        >
                            Import
                        </Button>
                    </div>
                </>
            )}
        </>
    );
};

export const LatitudeLongitude = ({
    latitude,
    longitude,
    onChange,
    label = "Location",
    colorName,
    children,
    disabled,
    inlineEdit = false,
    radiusMeters,
    referencePoint,
    lockToGps = false,
    mapReady = true,
    impactMode,
    impactType,
    tentacleRadiusKm,
}: {
    latitude: number;
    longitude: number;
    onChange: (lat: number | null, lng: number | null) => void;
    label?: string;
    colorName?: keyof typeof ICON_COLORS;
    className?: string;
    children?: React.ReactNode;
    disabled?: boolean;
    inlineEdit?: boolean;
    /** Optional radius (meters) — surfaces a preview circle on the
     *  inline picker map. Used by radar questions. */
    radiusMeters?: number;
    /** Optional second point to show on the picker map, with a dashed
     *  line drawn from the primary pin to it. Used by matching/
     *  measuring configure dialogs to surface the seeker's actual
     *  nearest reference (e.g. "Stockholm Aquarium"). */
    referencePoint?: {
        lat: number;
        lng: number;
        name?: string;
    };
    /**
     * When true, the map picker is display-only: no tap-to-place, no
     * draggable pin. Seeker location must come from GPS, or — if GPS
     * is denied — from the manual place search rendered below the
     * map. Used by matching/measuring configure dialogs.
     */
    lockToGps?: boolean;
    /**
     * Gate the inline map render. When false, a small "Locating…"
     * placeholder is shown in the map's slot instead — useful for
     * matching/measuring where the map is only meaningful once *both*
     * the seeker pin and the resolved nearest reference are known.
     * The PlaceSearchInput below stays mounted in lock-to-GPS mode
     * so the user can still set a location while the map is gated.
     */
    mapReady?: boolean;
    /** Question-impact overlay (v239) — passthrough to
     *  InlineLocationPicker. See its props. */
    impactMode?: ImpactMode;
    impactType?: string;
    tentacleRadiusKm?: number;
}) => {
    const $isLoading = useStore(isLoading);

    // Resolve the coordinates to a friendly "near X" label via Nominatim.
    // Debounced + cached inside reverseGeocode itself, so dragging a marker
    // around won't fire a request per pixel.
    const [nearby, setNearby] = useState<string | null>(null);
    useEffect(() => {
        if (
            typeof latitude !== "number" ||
            typeof longitude !== "number" ||
            Number.isNaN(latitude) ||
            Number.isNaN(longitude)
        ) {
            setNearby(null);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            reverseGeocode(latitude, longitude).then((name) => {
                if (!cancelled) setNearby(name);
            });
        }, 400);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [latitude, longitude]);

    return (
        <>
            <SidebarMenuItem
                className={cn(
                    "px-2 py-2 rounded-md space-y-1 mt-2",
                    "bg-secondary/30 border border-border",
                    $isLoading && "opacity-60",
                )}
            >
                {!inlineEdit && (
                    <div
                        className={cn(
                            "flex justify-between items-baseline gap-2",
                            $isLoading && "opacity-50",
                        )}
                    >
                        <div className="text-xs uppercase tracking-wider font-poppins font-semibold text-muted-foreground shrink-0">
                            {label}
                        </div>
                        <div className="text-xs text-foreground/80 truncate min-w-0 text-right">
                            {nearby ? (
                                <>
                                    near{" "}
                                    <span className="font-medium">
                                        {nearby}
                                    </span>
                                </>
                            ) : (
                                <span className="text-muted-foreground italic">
                                    locating…
                                </span>
                            )}
                        </div>
                    </div>
                )}
                {!inlineEdit && (
                    <div className="mt-2 space-y-2">
                        {mapReady ? (
                            <Suspense
                                fallback={
                                    <div className="w-full h-[40vh] rounded-md border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground">
                                        Loading map…
                                    </div>
                                }
                            >
                                <InlineLocationPicker
                                    latitude={latitude}
                                    longitude={longitude}
                                    onChange={(la, ln) => onChange(la, ln)}
                                    radiusMeters={radiusMeters}
                                    referencePoint={referencePoint}
                                    lockToGps={lockToGps}
                                    disabled={disabled}
                                    impactMode={impactMode}
                                    impactType={impactType}
                                    tentacleRadiusKm={tentacleRadiusKm}
                                />
                            </Suspense>
                        ) : (
                            <div className="w-full h-[40vh] rounded-md border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground px-4 text-center">
                                Locating you and the nearest reference…
                            </div>
                        )}
                        {/* Manual entry path. In lock-to-GPS mode the map
                            is display-only, so a place search is the
                            only way to set a location when GPS is denied
                            (or to override an inaccurate fix). */}
                        {lockToGps && (
                            <PlaceSearchInput
                                onPick={(la, ln) => onChange(la, ln)}
                                disabled={disabled}
                            />
                        )}
                    </div>
                )}

                {/* The `inlineEdit` branch is still used by HiderView etc.
                    — it shows the bare lat/lng form without a map. The
                    `!inlineEdit` branch is no longer needed: the inline
                    map picker above already handles tap-to-place AND has
                    its own GPS button. */}
                {inlineEdit && (
                    <div className="flex flex-col gap-2 w-full mb-2">
                        <LatLngEditForm
                            latitude={latitude}
                            longitude={longitude}
                            onChange={onChange}
                            disabled={disabled}
                        />
                    </div>
                )}
            </SidebarMenuItem>
            {children}
        </>
    );
};
