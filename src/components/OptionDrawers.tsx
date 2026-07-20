import { useStore } from "@nanostores/react";
import { BookOpen, HelpCircle, Target } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import {
    additionalMapGeoLocations,
    alwaysUsePastebin,
    customPresets,
    customStations,
    defaultUnit,
    disabledStations,
    displayHidingZonesOptions,
    hidingRadius,
    hidingRadiusUnits,
    hidingZone,
    includeDefaultStations,
    mapGeoJSON,
    mapGeoLocation,
    pastebinApiKey,
    permanentOverlay,
    polyGeoJSON,
    questions,
    showTutorial,
    triggerLocalRefresh,
    useCustomStations,
    zoneSidebarOpen,
} from "@/lib/context";
import {
    cn,
    compress,
    decompress,
    fetchFromPastebin,
    shareOrFallback,
    uploadToPastebin,
} from "@/lib/utils";
import { questionsSchema } from "@/maps/schema";

import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { RulebookTrigger } from "./RulebookSheet";
import { ThemeToggle } from "./ThemeToggle";
import { UnitSelect } from "./UnitSelect";

const HIDING_ZONE_URL_PARAM = "hz";
const HIDING_ZONE_COMPRESSED_URL_PARAM = "hzc";
const PASTEBIN_URL_PARAM = "pb";

/**
 * Desktop floating-button cluster (bottom-right of the seeker map).
 * Holds tutorial / rulebook / zones / share triggers plus a compact
 * "Settings" drawer with units + theme — the two app-level
 * preferences we kept after retiring the upstream "Options" sheet
 * (v265). Mobile players reach the same two controls via
 * SeekerTopBar's gear icon → Settings sheet (see BottomNav.tsx).
 *
 * Also responsible for one piece of legacy: the URL-param hiding-zone
 * loader. Old upstream share links (?hz, ?hzc, ?pb) still need to
 * import on first load so a user's bookmarked link survives the
 * rewrite. The loadHidingZone helper handles every legacy field the
 * old format carried.
 */
export const OptionDrawers = ({
    className,
}: {
    className?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $defaultUnit = useStore(defaultUnit);
    const $hidingZone = useStore(hidingZone);
    const $pastebinApiKey = useStore(pastebinApiKey);
    const $alwaysUsePastebin = useStore(alwaysUsePastebin);
    const lastDefaultUnit = useRef($defaultUnit);
    const hasSyncedInitialUnit = useRef(false);
    const [isSettingsOpen, setSettingsOpen] = useState(false);

    useEffect(() => {
        const currentDefault = $defaultUnit;

        if (!hasSyncedInitialUnit.current) {
            hasSyncedInitialUnit.current = true;
            if (hidingRadiusUnits.get() !== currentDefault) {
                hidingRadiusUnits.set(currentDefault);
            }
        } else if (lastDefaultUnit.current !== currentDefault) {
            hidingRadiusUnits.set(currentDefault);
        }

        lastDefaultUnit.current = currentDefault;
    }, [$defaultUnit]);

    useEffect(() => {
        const params = new URL(window.location.toString()).searchParams;
        const hidingZoneOld = params.get(HIDING_ZONE_URL_PARAM);
        const hidingZoneCompressed = params.get(
            HIDING_ZONE_COMPRESSED_URL_PARAM,
        );
        const pastebinId = params.get(PASTEBIN_URL_PARAM);

        if (hidingZoneOld !== null) {
            // Legacy base64 encoding
            try {
                loadHidingZone(atob(hidingZoneOld));
                window.history.replaceState({}, "", window.location.pathname);
            } catch (e) {
                toast.error(`Invalid hiding zone settings: ${e}`);
            }
        } else if (hidingZoneCompressed !== null) {
            decompress(hidingZoneCompressed).then((data) => {
                try {
                    loadHidingZone(data);
                    window.history.replaceState(
                        {},
                        "",
                        window.location.pathname,
                    );
                } catch (e) {
                    toast.error(`Invalid hiding zone settings: ${e}`);
                }
            });
        } else if (pastebinId !== null) {
            fetchFromPastebin(pastebinId)
                .then((data) => {
                    try {
                        loadHidingZone(data);
                        window.history.replaceState(
                            {},
                            "",
                            window.location.pathname,
                        );
                        toast.success(
                            "Hiding zone loaded from share link.",
                        );
                    } catch (e) {
                        toast.error(`Invalid data in share link: ${e}`);
                    }
                })
                .catch((error) => {
                    console.error("Failed to fetch from Pastebin:", error);
                    toast.error(
                        `Couldn't load share link: ${error.message}`,
                    );
                });
        }
    }, []);

    const loadHidingZone = (hidingZone: string) => {
        try {
            const geojson = JSON.parse(hidingZone);

            if (
                geojson.properties &&
                geojson.properties.isHidingZone === true
            ) {
                questions.set(
                    questionsSchema.parse(geojson.properties.questions ?? []),
                );
                mapGeoLocation.set(geojson);
                mapGeoJSON.set(null);
                polyGeoJSON.set(null);

                if (geojson.alternateLocations) {
                    additionalMapGeoLocations.set(geojson.alternateLocations);
                } else {
                    additionalMapGeoLocations.set([]);
                }
            } else {
                if (geojson.questions) {
                    questions.set(questionsSchema.parse(geojson.questions));
                    delete geojson.questions;

                    mapGeoJSON.set(geojson);
                    polyGeoJSON.set(geojson);
                } else {
                    questions.set([]);
                    mapGeoJSON.set(geojson);
                    polyGeoJSON.set(geojson);
                }
            }

            const incomingPresets =
                geojson.presets ?? geojson.properties?.presets;
            if (incomingPresets && Array.isArray(incomingPresets)) {
                try {
                    const normalized = (incomingPresets as any[])
                        .filter((p) => p && p.data)
                        .map((p) => {
                            return {
                                id:
                                    p.id ??
                                    (typeof crypto !== "undefined" &&
                                    typeof (crypto as any).randomUUID ===
                                        "function"
                                        ? (crypto as any).randomUUID()
                                        : String(Date.now()) + Math.random()),
                                name: p.name ?? "Imported preset",
                                type: p.type ?? "custom",
                                data: p.data,
                                createdAt:
                                    p.createdAt ?? new Date().toISOString(),
                            };
                        });
                    if (normalized.length > 0) {
                        customPresets.set(normalized);
                        toast.info(`Imported ${normalized.length} preset(s)`);
                    }
                } catch (err) {
                    console.warn("Failed to import presets", err);
                }
            }

            if (
                geojson.disabledStations !== null &&
                geojson.disabledStations.constructor === Array
            ) {
                disabledStations.set(geojson.disabledStations);
            }

            if (geojson.hidingRadius !== null) {
                hidingRadius.set(geojson.hidingRadius);
            }

            if (geojson.zoneOptions) {
                displayHidingZonesOptions.set(geojson.zoneOptions ?? []);
            }

            if (typeof geojson.useCustomStations === "boolean") {
                useCustomStations.set(geojson.useCustomStations);
            }

            if (
                geojson.customStations &&
                geojson.customStations.constructor === Array
            ) {
                customStations.set(geojson.customStations);
            }

            if (typeof geojson.includeDefaultStations === "boolean") {
                includeDefaultStations.set(geojson.includeDefaultStations);
            }

            if (geojson.permanentOverlay) {
                permanentOverlay.set(geojson.permanentOverlay);
            } else {
                permanentOverlay.set(null);
            }

            toast.success("Hiding zone loaded successfully", {
                autoClose: 2000,
            });
        } catch (e) {
            toast.error(`Invalid hiding zone settings: ${e}`);
        }
    };

    return (
        <div
            className={cn(
                "flex justify-end gap-2 max-[412px]:!mb-4 max-[340px]:flex-col items-center",
                className,
            )}
        >
            <Button
                variant="outline"
                size="icon"
                className="shadow-md shrink-0"
                title="Open tutorial"
                aria-label="Open tutorial"
                onClick={() => {
                    showTutorial.set(true);
                }}
            >
                <HelpCircle className="w-4 h-4" />
            </Button>
            <RulebookTrigger>
                <Button
                    variant="outline"
                    size="icon"
                    className="shadow-md shrink-0"
                    title="Open Hide + Seek rulebook (searchable)"
                    aria-label="Open rulebook"
                >
                    <BookOpen className="w-4 h-4" />
                </Button>
            </RulebookTrigger>
            <Button
                variant="outline"
                className="shadow-md shrink-0 gap-2"
                title="Open hiding zone settings"
                aria-label="Open hiding zone settings"
                onClick={() => zoneSidebarOpen.set(true)}
            >
                <Target className="w-4 h-4" />
                Zones
            </Button>
            <Button
                className="shadow-md"
                onClick={async () => {
                    const hidingZoneString = JSON.stringify($hidingZone);
                    let compressedData;
                    try {
                        compressedData = await compress(hidingZoneString);
                    } catch (error) {
                        console.error("Compression failed:", error);
                        toast.error(`Failed to prepare data for sharing`);
                        return;
                    }

                    const baseUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
                    let shareUrl = `${baseUrl}?${HIDING_ZONE_COMPRESSED_URL_PARAM}=${compressedData}`;

                    if ($alwaysUsePastebin || shareUrl.length > 2000) {
                        if (!$pastebinApiKey) {
                            toast.error(
                                "Hiding zone is too large to share. Trim the selection and try again.",
                            );
                            return;
                        }
                        try {
                            toast.info("Uploading share link…");
                            const pastebinUrl = await uploadToPastebin(
                                $pastebinApiKey,
                                hidingZoneString,
                            );
                            const pasteId = pastebinUrl.substring(
                                pastebinUrl.lastIndexOf("/") + 1,
                            );
                            shareUrl = `${baseUrl}?${PASTEBIN_URL_PARAM}=${pasteId}`;
                            toast.success(
                                "Share link ready to copy.",
                            );
                        } catch (error) {
                            console.error("Pastebin upload failed:", error);
                            toast.error(
                                `Couldn't create share link — try again.`,
                            );
                            return;
                        }
                    }

                    await shareOrFallback(shareUrl).then((result) => {
                        if (result === false) {
                            return toast.error(
                                `Clipboard not supported. Try manually copying/pasting: ${shareUrl}`,
                                { className: "p-0 w-[1000px]" },
                            );
                        }

                        if (result === "clipboard") {
                            toast.success(
                                "Hiding zone URL copied to clipboard",
                                {
                                    autoClose: 2000,
                                },
                            );
                        }
                    });
                }}
                data-tutorial-id="share-questions-button"
            >
                Share
            </Button>
            <Drawer open={isSettingsOpen} onOpenChange={setSettingsOpen}>
                <DrawerTrigger className="w-24" asChild>
                    <Button
                        className="shadow-md w-24"
                        data-tutorial-id="option-questions-button"
                    >
                        Settings
                    </Button>
                </DrawerTrigger>
                <DrawerContent>
                    <div className="mx-auto w-full max-w-sm pb-6">
                        <DrawerHeader>
                            <DrawerTitle className="text-2xl font-semibold font-poppins">
                                Settings
                            </DrawerTitle>
                        </DrawerHeader>
                        <div className="px-6 flex flex-col gap-5">
                            <div className="flex items-center justify-between gap-3">
                                <Label className="text-base">Units</Label>
                                <UnitSelect
                                    unit={$defaultUnit}
                                    onChange={defaultUnit.set}
                                />
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <Label className="text-base">Theme</Label>
                                <ThemeToggle />
                            </div>
                        </div>
                    </div>
                </DrawerContent>
            </Drawer>
        </div>
    );
};
