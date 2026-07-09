import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import type { TransitMode } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import { geocode } from "@/maps/api/geocode";
import { findExtensionCandidates } from "@/maps/api/playAreaExtensions";
import {
    findTransitReachCandidates,
    type RailRouteKind,
    type TransitReachResult,
} from "@/maps/api/transitReach";
import type { OpenStreetMap } from "@/maps/api/types";

/**
 * Developer comparison at `/debug/adjacency` (Topic 2 prototype) — for a
 * searched city, run BOTH the shipped ADMIN-ADJACENCY selector
 * (`findExtensionCandidates`) and the prototype TRANSIT-REACH selector
 * (`findTransitReachCandidates`) and show the two candidate sets side by
 * side, so the transit-reach idea ("everywhere the subway / commuter train
 * runs") can be eyeballed on Stockholm + test cities before it becomes the
 * default. Writes NO global state — purely a read-only inspector.
 */

const ALL_MODES: TransitMode[] = ["bus", "tram", "train", "subway", "ferry"];
const KIND_OPTIONS: RailRouteKind[] = [
    "subway",
    "light_rail",
    "commuter",
    "tram",
];
const PRESETS = [
    "Stockholm",
    "New York City",
    "London",
    "Paris",
    "Berlin",
    "Chicago",
    "Sydney",
    "Copenhagen",
];

interface AdminCandidate {
    name: string;
    relationId: number;
    distanceKm: number;
    hasMatchingTransit: boolean;
}

export function DebugAdjacencyPage() {
    const [query, setQuery] = useState("Stockholm");
    const [radiusKm, setRadiusKm] = useState(40);
    const [kinds, setKinds] = useState<RailRouteKind[]>([
        "subway",
        "light_rail",
        "commuter",
    ]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [primaryName, setPrimaryName] = useState<string | null>(null);
    const [admin, setAdmin] = useState<AdminCandidate[] | null>(null);
    const [reach, setReach] = useState<TransitReachResult | null>(null);

    const toggleKind = (k: RailRouteKind) =>
        setKinds((prev) =>
            prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
        );

    const run = async () => {
        setLoading(true);
        setError(null);
        setAdmin(null);
        setReach(null);
        setPrimaryName(null);
        try {
            const results = (await geocode(query, "en")) as OpenStreetMap[];
            const primary = results?.[0];
            if (!primary) {
                setError(`No play area found for "${query}"`);
                return;
            }
            setPrimaryName(primary.properties.name ?? query);
            const [adminRes, reachRes] = await Promise.all([
                findExtensionCandidates(primary, ALL_MODES, {
                    radiusKm,
                    limit: 40,
                })
                    .then((cs) =>
                        cs.map((c) => ({
                            name:
                                (c.feature.properties.name as string) ??
                                `r${c.feature.properties.osm_id}`,
                            relationId: c.feature.properties.osm_id,
                            distanceKm: c.distanceKm,
                            hasMatchingTransit: c.hasMatchingTransit,
                        })),
                    )
                    .catch((e) => {
                        console.warn("admin adjacency failed", e);
                        return [] as AdminCandidate[];
                    }),
                findTransitReachCandidates(primary, { radiusKm, kinds }).catch(
                    (e) => {
                        console.warn("transit reach failed", e);
                        return null;
                    },
                ),
            ]);
            setAdmin(adminRes);
            setReach(reachRes);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    };

    const adminIds = new Set((admin ?? []).map((a) => a.relationId));
    const reachIds = new Set((reach?.candidates ?? []).map((c) => c.relationId));

    return (
        <div className="min-h-screen bg-background text-foreground p-4 md:p-8">
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-center gap-3">
                    <Link
                        to="/welcome"
                        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="w-4 h-4" /> Back
                    </Link>
                    <h1 className="text-xl font-semibold">
                        Adjacency comparison
                    </h1>
                </div>
                <p className="text-sm text-muted-foreground">
                    Admin-adjacency (shipped) vs. transit-reach (prototype:
                    every municipality the subway / commuter train actually
                    stops in). Read-only — nothing is saved.
                </p>

                <div className="space-y-3 rounded-lg border border-border p-4">
                    <div className="flex flex-wrap gap-2">
                        {PRESETS.map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => setQuery(p)}
                                className={cn(
                                    "rounded-full border px-3 py-1 text-xs",
                                    query === p
                                        ? "bg-primary text-primary-foreground border-primary"
                                        : "border-border hover:bg-accent",
                                )}
                            >
                                {p}
                            </button>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-end gap-4">
                        <label className="flex flex-col gap-1 text-xs">
                            City
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") void run();
                                }}
                                className="rounded-md border border-border bg-background px-2 py-1 text-sm w-56"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                            Radius: {radiusKm} km
                            <input
                                type="range"
                                min={10}
                                max={80}
                                step={5}
                                value={radiusKm}
                                onChange={(e) =>
                                    setRadiusKm(Number(e.target.value))
                                }
                            />
                        </label>
                        <div className="flex flex-col gap-1 text-xs">
                            Rail kinds
                            <div className="flex gap-2">
                                {KIND_OPTIONS.map((k) => (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => toggleKind(k)}
                                        className={cn(
                                            "rounded-md border px-2 py-1",
                                            kinds.includes(k)
                                                ? "bg-primary/15 border-primary text-foreground"
                                                : "border-border text-muted-foreground",
                                        )}
                                    >
                                        {k}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => void run()}
                            disabled={loading}
                            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                        >
                            {loading ? "Running…" : "Compare"}
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                        {error}
                    </div>
                )}

                {primaryName && (
                    <div className="text-sm">
                        Primary: <strong>{primaryName}</strong>
                        {reach && (
                            <span className="text-muted-foreground">
                                {" "}
                                — {reach.stops.length} rail stops found
                            </span>
                        )}
                    </div>
                )}

                {(admin || reach) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Admin adjacency */}
                        <div className="rounded-lg border border-border">
                            <div className="border-b border-border px-3 py-2 text-sm font-semibold">
                                Admin-adjacency (shipped) — {admin?.length ?? 0}
                            </div>
                            <ul className="divide-y divide-border/60 max-h-[60vh] overflow-y-auto">
                                {(admin ?? []).map((a) => (
                                    <li
                                        key={a.relationId}
                                        className="flex items-center justify-between px-3 py-1.5 text-sm"
                                    >
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={cn(
                                                    "w-1.5 h-1.5 rounded-full",
                                                    reachIds.has(a.relationId)
                                                        ? "bg-success"
                                                        : "bg-warning",
                                                )}
                                                title={
                                                    reachIds.has(a.relationId)
                                                        ? "also in transit-reach"
                                                        : "admin-only (no rail)"
                                                }
                                            />
                                            {a.name}
                                        </span>
                                        <span className="text-xs text-muted-foreground tabular-nums">
                                            {a.distanceKm.toFixed(1)} km
                                            {a.hasMatchingTransit ? " · transit" : ""}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        {/* Transit reach */}
                        <div className="rounded-lg border border-border">
                            <div className="border-b border-border px-3 py-2 text-sm font-semibold">
                                Transit-reach (prototype) —{" "}
                                {reach?.candidates.length ?? 0}
                            </div>
                            <ul className="divide-y divide-border/60 max-h-[60vh] overflow-y-auto">
                                {(reach?.candidates ?? []).map((c) => (
                                    <li
                                        key={c.relationId}
                                        className="flex items-center justify-between px-3 py-1.5 text-sm"
                                    >
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={cn(
                                                    "w-1.5 h-1.5 rounded-full",
                                                    adminIds.has(c.relationId)
                                                        ? "bg-success"
                                                        : "bg-info",
                                                )}
                                                title={
                                                    adminIds.has(c.relationId)
                                                        ? "also in admin-adjacency"
                                                        : "rail-only (not admin-adjacent)"
                                                }
                                            />
                                            {c.name}
                                        </span>
                                        <span className="text-xs text-muted-foreground tabular-nums">
                                            {c.stopCount} stops ·{" "}
                                            {c.kinds.join("/")}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}

                {reach && reach.candidates.length > 0 && (
                    <div className="text-xs text-muted-foreground space-y-1">
                        <div>
                            <span className="inline-block w-2 h-2 rounded-full bg-success align-middle" />{" "}
                            in both ·{" "}
                            <span className="inline-block w-2 h-2 rounded-full bg-info align-middle" />{" "}
                            rail-only (transit-reach adds these) ·{" "}
                            <span className="inline-block w-2 h-2 rounded-full bg-warning align-middle" />{" "}
                            admin-only (no rail — transit-reach drops these)
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default DebugAdjacencyPage;
