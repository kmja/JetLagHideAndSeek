import { useStore } from "@nanostores/react";
import { Bookmark, MapPin, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { appConfirm } from "@/lib/confirm";
import {
    addScoutedSpot,
    removeScoutedSpot,
    scoutedSpots,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

import { SectionPill } from "./JetLagLogo";

/**
 * "Scouted spots" — a notebook for the hider to drop pins on
 * potential hiding locations while walking around their zone, so
 * they don't lose track of the bench-by-the-library or the alley
 * they spotted earlier. Each entry stores the GPS captured at save
 * time plus an optional freeform label.
 *
 * UI is intentionally tiny — one "Save current GPS" button + a list
 * of saved entries with a delete affordance. The hider already has
 * a map elsewhere; if we want the list to be a draggable map view
 * later that can be a follow-up.
 *
 * Persistent across reloads via `scoutedSpots` atom; cleared on
 * new-round / new-game by resetHiderRoundState.
 */
export function ScoutedSpotsPanel() {
    const $spots = useStore(scoutedSpots);
    const [draftLabel, setDraftLabel] = useState("");
    const [pending, setPending] = useState(false);

    const handleSaveHere = () => {
        if (
            typeof navigator === "undefined" ||
            !navigator.geolocation
        ) {
            toast.error("GPS unavailable on this device.");
            return;
        }
        setPending(true);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                addScoutedSpot({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    label: draftLabel.trim() || undefined,
                });
                setDraftLabel("");
                setPending(false);
                toast.success("Spot saved.", { autoClose: 1500 });
            },
            (err) => {
                setPending(false);
                toast.error(
                    err.code === err.PERMISSION_DENIED
                        ? "Allow location to save spots."
                        : "Couldn't read your GPS — try again.",
                );
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
        );
    };

    const handleRemove = async (id: string, label: string) => {
        const ok = await appConfirm({
            title: `Drop ${label || "this spot"}?`,
            description: "Removes it from your scouted list.",
            confirmLabel: "Drop",
            destructive: true,
        });
        if (ok) removeScoutedSpot(id);
    };

    return (
        <section className="mt-4 space-y-2">
            <div className="flex items-center gap-2">
                <Bookmark className="w-4 h-4 text-muted-foreground" />
                <SectionPill>Scouted spots</SectionPill>
                <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                    {$spots.length}
                </span>
            </div>

            {/* Save-here form */}
            <div className="flex items-stretch gap-2">
                <Input
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    placeholder="Label (optional)"
                    maxLength={40}
                    className="text-sm"
                />
                <Button
                    type="button"
                    onClick={handleSaveHere}
                    disabled={pending}
                    size="sm"
                    className="gap-1.5 shrink-0"
                >
                    <Plus className="w-4 h-4" />
                    {pending ? "GPS…" : "Save here"}
                </Button>
            </div>

            {$spots.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic px-1 leading-snug">
                    Pin potential hiding spots as you walk around. Stored
                    locally — only you see them.
                </p>
            ) : (
                <ul className="flex flex-col gap-1.5">
                    {[...$spots]
                        .sort((a, b) => b.savedAt - a.savedAt)
                        .map((spot) => (
                            <li
                                key={spot.id}
                                className={cn(
                                    "rounded-md border border-border bg-secondary/40",
                                    "px-3 py-2 flex items-start gap-2",
                                )}
                            >
                                <MapPin className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">
                                        {spot.label || "Saved spot"}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground tabular-nums">
                                        {spot.lat.toFixed(5)},{" "}
                                        {spot.lng.toFixed(5)}
                                    </div>
                                </div>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                        void handleRemove(
                                            spot.id,
                                            spot.label || "",
                                        )
                                    }
                                    title="Drop spot"
                                    aria-label="Drop spot"
                                    className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                            </li>
                        ))}
                </ul>
            )}
        </section>
    );
}

export default ScoutedSpotsPanel;
