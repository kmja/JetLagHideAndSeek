import { ArrowLeft } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";

import { GoGoGoOverlay } from "@/components/GoGoGoOverlay";
import { HiderTimer } from "@/components/HiderTimer";
import { HiderUnansweredOverlay } from "@/components/HiderUnansweredOverlay";
import { LocationPauseBanner } from "@/components/LocationPauseBanner";
import { MapTilesVeil } from "@/components/MapTilesVeil";
import { PendingAnswerOverlay } from "@/components/PendingAnswerOverlay";
import { SeekerFrozenBanner } from "@/components/SeekerFrozenBanner";
import { ThermometerOverlay } from "@/components/ThermometerOverlay";
import type { InboxEntry } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

/**
 * Developer overlay gallery at `/debug/overlays` — EVERY state of EVERY
 * floating overlay shown at once, side by side.
 *
 * Each overlay takes a `preview` prop that shadows the global atoms it
 * would normally read, so the gallery drives every cell to a specific
 * state WITHOUT writing any global state. That's what lets several states
 * of the same overlay appear simultaneously (impossible when they all
 * read one shared atom) — and it means the gallery can never disturb a
 * real in-progress game. No snapshot/restore needed.
 *
 * Why cells: the overlays position with `fixed` / `absolute` against the
 * viewport. Each cell sets a non-`none` `transform`, which makes it the
 * containing block for its overlay's positioning, so each lays itself out
 * within its own cell instead of the whole window.
 */

// Throwaway lat/lng for mock question geometry (central London).
const MOCK_LAT = 51.5074;
const MOCK_LNG = -0.1278;

function mockRadius(createdAt: number | undefined): Question {
    return {
        id: "radius",
        key: 999001,
        data: {
            lat: MOCK_LAT,
            lng: MOCK_LNG,
            radius: 5,
            unit: "kilometers",
            drag: true,
            ...(createdAt !== undefined ? { createdAt } : {}),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

function mockThermometer(now: number): Question {
    return {
        id: "thermometer",
        key: 999002,
        data: {
            status: "started",
            startedAt: now - 90_000,
            targetSig: "1km",
            distance: "1km",
            latA: MOCK_LAT,
            lngA: MOCK_LNG,
            latB: MOCK_LAT,
            lngB: MOCK_LNG,
            drag: true,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

/** A pending (sent, awaiting-answer) question of any type, for the
 *  PendingAnswerOverlay cells. `createdAt` set → shows the live timer. */
function mockPending(
    id: string,
    data: Record<string, unknown>,
    key: number,
    now: number,
): Question {
    return {
        id,
        key,
        data: {
            lat: MOCK_LAT,
            lng: MOCK_LNG,
            drag: true,
            createdAt: now,
            ...data,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

/** A waiting inbox entry for the hider's unanswered-question pill. */
function mockInbox(
    id: string,
    data: Record<string, unknown>,
    now: number,
): InboxEntry {
    return {
        key: 999100,
        id,
        data: { lat: MOCK_LAT, lng: MOCK_LNG, drag: true, ...data },
        arrivedAt: now - 48_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

/** A single labelled gallery cell that becomes the containing block for
 *  its overlay's fixed/absolute positioning. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                {label}
            </div>
            <div
                className={cn(
                    "relative h-72 rounded-lg border border-border overflow-hidden",
                    "bg-[hsl(var(--sidebar-background))]",
                )}
                // A non-`none` transform makes this the containing block
                // for the overlay's `fixed`/`absolute` positioning.
                style={{ transform: "translateZ(0)" }}
            >
                <div
                    className="absolute inset-0 opacity-[0.15]"
                    style={{
                        backgroundImage:
                            "linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)",
                        backgroundSize: "28px 28px",
                    }}
                    aria-hidden
                />
                {children}
            </div>
        </div>
    );
}

export function DebugOverlaysPage() {
    // Fix a mount-time "now" so each preview's relative timestamps
    // (countdowns etc.) are stable and read sensibly.
    const [now] = useState(() => Date.now());
    const M = 60_000;

    // The app is hardcoded dark, but overlays render in both themes. The
    // gallery applies `dark`/`light` to its own subtree (both classes
    // re-declare the full token set in globals.css) so it can preview the
    // overlays under either theme regardless of the global `.dark`.
    const [theme, setTheme] = useState<"dark" | "light">("dark");

    return (
        <div
            className={cn(
                theme,
                "min-h-screen bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
            )}
            style={{ colorScheme: theme }}
        >
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-border bg-background/95 backdrop-blur">
                <Link
                    to="/"
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md hover:bg-accent shrink-0"
                    aria-label="Back to app"
                >
                    <ArrowLeft className="w-4 h-4" />
                </Link>
                <div className="min-w-0 flex-1">
                    <div className="font-display font-extrabold uppercase text-sm leading-none tracking-wide">
                        Overlay gallery
                    </div>
                    <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                        Every state of every overlay · preview-only, does not
                        touch your game
                    </div>
                </div>
                {/* Theme toggle — preview the overlays in light or dark. */}
                <div className="flex items-center rounded-md border border-border overflow-hidden shrink-0 text-xs font-semibold">
                    {(["dark", "light"] as const).map((t) => (
                        <button
                            key={t}
                            type="button"
                            onClick={() => setTheme(t)}
                            className={cn(
                                "px-2.5 py-1.5 capitalize transition-colors",
                                theme === t
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-background text-muted-foreground hover:bg-accent",
                            )}
                        >
                            {t}
                        </button>
                    ))}
                </div>
            </div>

            {/* Gallery grid */}
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {/* ── Hider timer ─────────────────────────────── */}
                <Cell label="Timer · hiding (5:00 left)">
                    <HiderTimer preview={{ endsAt: now + 5 * M }} />
                </Cell>
                <Cell label="Timer · hiding (0:20 left)">
                    <HiderTimer preview={{ endsAt: now + 20_000 }} />
                </Cell>
                <Cell label="Timer · seeking (hidden 2:00)">
                    <HiderTimer preview={{ endsAt: now - 2 * M }} />
                </Cell>
                <Cell label="Timer · seeking + endgame">
                    <HiderTimer
                        preview={{
                            endsAt: now - 2 * M,
                            endgameStartedAt: now - M,
                        }}
                    />
                </Cell>

                {/* ── Pending question ────────────────────────── */}
                <Cell label="Pending · radar not sent">
                    <PendingAnswerOverlay
                        preview={{ questions: [mockRadius(undefined)] }}
                    />
                </Cell>
                <Cell label="Pending · radar waiting">
                    <PendingAnswerOverlay
                        preview={{ questions: [mockRadius(now)] }}
                    />
                </Cell>
                <Cell label="Pending · radar overdue">
                    <PendingAnswerOverlay
                        preview={{ questions: [mockRadius(now - 6 * M)] }}
                    />
                </Cell>
                <Cell label="Pending · answered!">
                    <PendingAnswerOverlay
                        preview={{
                            questions: [mockRadius(now)],
                            forcePhase: "answered",
                        }}
                    />
                </Cell>

                {/* ── Pending · every question type ───────────── */}
                <Cell label="Pending · thermometer">
                    <PendingAnswerOverlay
                        preview={{
                            questions: [
                                mockPending(
                                    "thermometer",
                                    { distance: "1km" },
                                    999010,
                                    now,
                                ),
                            ],
                        }}
                    />
                </Cell>
                <Cell label="Pending · matching">
                    <PendingAnswerOverlay
                        preview={{
                            questions: [
                                mockPending(
                                    "matching",
                                    { type: "museum" },
                                    999011,
                                    now,
                                ),
                            ],
                        }}
                    />
                </Cell>
                <Cell label="Pending · measuring">
                    <PendingAnswerOverlay
                        preview={{
                            questions: [
                                mockPending(
                                    "measuring",
                                    { type: "aquarium" },
                                    999012,
                                    now,
                                ),
                            ],
                        }}
                    />
                </Cell>
                <Cell label="Pending · tentacles">
                    <PendingAnswerOverlay
                        preview={{
                            questions: [
                                mockPending(
                                    "tentacles",
                                    { locationType: "zoo", radius: 15, unit: "miles" },
                                    999013,
                                    now,
                                ),
                            ],
                        }}
                    />
                </Cell>
                <Cell label="Pending · photo">
                    <PendingAnswerOverlay
                        preview={{
                            questions: [
                                mockPending(
                                    "photo",
                                    { type: "tree" },
                                    999014,
                                    now,
                                ),
                            ],
                        }}
                    />
                </Cell>

                {/* ── Thermometer ─────────────────────────────── */}
                <Cell label="Thermometer · running pill">
                    <ThermometerOverlay
                        preview={{ questions: [mockThermometer(now)] }}
                    />
                </Cell>

                {/* ── Hider side ──────────────────────────────── */}
                <Cell label="Hider · unanswered pill">
                    <HiderUnansweredOverlay
                        preview={{
                            inbox: [mockInbox("radius", { radius: 5, unit: "kilometers" }, now)],
                        }}
                    />
                </Cell>
                <Cell label="Hider · unanswered (overdue)">
                    <HiderUnansweredOverlay
                        preview={{
                            inbox: [
                                {
                                    ...mockInbox(
                                        "matching",
                                        { type: "museum" },
                                        now,
                                    ),
                                    arrivedAt: now - 6 * M,
                                },
                            ],
                        }}
                    />
                </Cell>

                {/* ── Banners ─────────────────────────────────── */}
                <Cell label="Location · grace countdown">
                    <LocationPauseBanner preview={{ grace: now }} />
                </Cell>
                <Cell label="Location · paused">
                    <LocationPauseBanner preview={{ paused: now }} />
                </Cell>
                <Cell label="Seekers frozen (Move)">
                    <SeekerFrozenBanner
                        preview={{ frozenUntil: now + 45_000 }}
                    />
                </Cell>

                {/* ── Celebration ─────────────────────────────── */}
                <Cell label="Game start (Go, go, go)">
                    <GoGoGoOverlay
                        preview={{ at: now, endsAt: now + 30 * M }}
                    />
                </Cell>

                {/* ── Loading veil ────────────────────────────── */}
                <Cell label="Tiles loading">
                    <MapTilesVeil visible label="Loading map" />
                </Cell>
                <Cell label="Tiles slow (timed out)">
                    <MapTilesVeil
                        visible
                        timedOut
                        label="Map tiles are slow to load"
                        sublabel="Hang tight — still trying"
                    />
                </Cell>
            </div>
        </div>
    );
}

export default DebugOverlaysPage;
