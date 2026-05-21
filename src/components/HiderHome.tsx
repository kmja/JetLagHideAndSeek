import { useStore } from "@nanostores/react";
import {
    AlertTriangle,
    Crosshair,
    Inbox,
    Lock,
    LockOpen,
    MapPin,
    Timer,
    Trophy,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    formatTimeRemaining,
    gameSize,
    hidingPeriodEndsAt,
    HIDING_PERIOD_MINUTES,
} from "@/lib/gameSetup";
import { tallyTimeBonusMinutes } from "@/lib/hiderDeck";
import {
    hiderHand,
    hiderInbox,
    hidingSpot,
    hidingZone,
    playerRole,
    radiusForGameSize,
    roundFoundAt,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";
import { CATEGORIES, type CategoryId } from "@/lib/categories";

import { DrawPickerDialog } from "./DrawPickerDialog";
import { HiderHandPanel } from "./HiderHandPanel";
import {
    HideSeekMark,
    HideSeekWordmark,
    SectionPill,
    SizeBadge,
} from "./JetLagLogo";

// Lazy-load the inline picker — leaflet must stay out of the SSR graph.
const InlineLocationPicker = lazy(() => import("./InlineLocationPicker"));

/**
 * Persistent hider home. Visible at `/h` when no `?q=` query param is
 * present — the existing single-question HiderView handles `?q=` for
 * backward compatibility with answer-link flows already in the wild.
 *
 * Sections:
 *   1. Header (brand + role chip)
 *   2. Phase badge: hiding-period countdown or hidden-elapsed timer
 *   3. Hiding zone — pick a transit station, see your 500m/1km circle
 *   4. Question inbox — questions the seeker has sent, with reply state
 *   5. Hand — placeholder card UI (deck mechanics land in a later pass)
 *   6. Footer with "Switch role" / rulebook link
 */
export function HiderHome() {
    const $role = useStore(playerRole);
    const $hidingZone = useStore(hidingZone);
    const $hidingSpot = useStore(hidingSpot);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $gameSize = useStore(gameSize);
    const $inbox = useStore(hiderInbox);
    const $hand = useStore(hiderHand);
    const $foundAt = useStore(roundFoundAt);

    // 1-Hz tick — drives both the hiding-period countdown and the
    // hidden-for elapsed reading.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!$hidingEndsAt) return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [$hidingEndsAt]);

    const inHidingPeriod = $hidingEndsAt !== null && now < $hidingEndsAt;
    const remainingMs = $hidingEndsAt
        ? Math.max(0, $hidingEndsAt - now)
        : 0;
    // Once the round has ended (`roundFoundAt` set) the elapsed timer
    // freezes at that timestamp — it's the value used to compute the
    // seek-time numerator in the final score.
    const elapsedAnchor = $foundAt ?? now;
    const hiddenElapsedMs = $hidingEndsAt
        ? Math.max(0, elapsedAnchor - $hidingEndsAt)
        : 0;
    const roundOver = $foundAt !== null;
    const timeBonusMinutes = useMemo(
        () => tallyTimeBonusMinutes($hand, $gameSize),
        [$hand, $gameSize],
    );

    // Sort inbox newest-first for display.
    const inboxSorted = useMemo(
        () => [...$inbox].sort((a, b) => b.arrivedAt - a.arrivedAt),
        [$inbox],
    );

    return (
        <div className="min-h-screen flex flex-col p-4 max-w-2xl mx-auto pb-12 bg-background text-foreground">
            {/* ───── 1. Header ───── */}
            <header className="mb-4">
                <div className="flex items-center gap-3">
                    <HideSeekMark size={36} onDark={false} />
                    <HideSeekWordmark />
                    <SectionPill className="ml-auto">Hider</SectionPill>
                </div>
            </header>

            {/* ───── 2a. Final score banner (when round is over) ───── */}
            {roundOver && $hidingEndsAt && (
                <FinalScoreBanner
                    foundAt={$foundAt!}
                    hidingEndsAt={$hidingEndsAt}
                    timeBonusMinutes={timeBonusMinutes}
                />
            )}

            {/* ───── 2. Phase badge ───── */}
            {$hidingEndsAt ? (
                <section
                    className={cn(
                        "rounded-md border-2 px-4 py-3 mb-4 flex items-center gap-3",
                        roundOver
                            ? "border-muted/40 bg-secondary/30 opacity-70"
                            : inHidingPeriod
                              ? "border-primary bg-primary/5"
                              : "border-yellow-500/60 bg-yellow-500/5",
                    )}
                >
                    <Timer
                        className={cn(
                            "w-5 h-5 shrink-0",
                            roundOver
                                ? "text-muted-foreground"
                                : inHidingPeriod
                                  ? "text-primary"
                                  : "text-yellow-500",
                        )}
                    />
                    <div className="flex flex-col leading-none gap-1">
                        <span className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.18em] text-muted-foreground">
                            {roundOver
                                ? "Hidden for (final)"
                                : inHidingPeriod
                                  ? "Hiding period"
                                  : "Hidden for"}
                        </span>
                        <span className="font-inter-tight italic font-black tabular-nums text-2xl text-primary leading-none">
                            {inHidingPeriod && !roundOver
                                ? formatTimeRemaining(remainingMs)
                                : formatElapsed(hiddenElapsedMs)}
                            {inHidingPeriod && !roundOver && (
                                <span className="ml-1.5 text-[9px] not-italic font-bold tracking-wider text-muted-foreground">
                                    / {HIDING_PERIOD_MINUTES[$gameSize]}m
                                </span>
                            )}
                        </span>
                    </div>
                    <SizeBadge size={$gameSize} className="ml-auto" />
                </section>
            ) : (
                <section className="rounded-md border border-dashed border-border px-4 py-3 mb-4 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 shrink-0 text-yellow-500" />
                    <p className="text-sm text-muted-foreground leading-snug">
                        No hiding period set yet on this device. Once the
                        seeker starts the game, your timer will appear here.
                    </p>
                </section>
            )}

            {/* ───── 3. Hiding zone ───── */}
            <HidingZoneSection
                zone={$hidingZone}
                radiusMeters={radiusForGameSize($gameSize)}
                disabled={false}
            />

            {/* ───── 3b. Hiding spot lockdown ─────
                Only meaningful once the hiding period has ended — that's
                rulebook p43 timing, when the hider commits to a final spot
                and can no longer move. Hidden during hiding period; offered
                as a "lock down" CTA when seeking starts; shown locked
                afterward. */}
            {$hidingEndsAt !== null && !inHidingPeriod && (
                <HidingSpotSection
                    spot={$hidingSpot}
                    roundOver={roundOver}
                />
            )}

            {/* ───── 4. Inbox ───── */}
            <section className="mt-5">
                <div className="flex items-center gap-2 mb-2">
                    <Inbox className="w-4 h-4 text-muted-foreground" />
                    <SectionPill>Inbox</SectionPill>
                    {$inbox.length > 0 && (
                        <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                            {$inbox.length} received ·{" "}
                            {$inbox.filter((e) => !e.repliedAt).length}{" "}
                            unanswered
                        </span>
                    )}
                </div>
                {inboxSorted.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic px-1">
                        Questions the seeker sends you will land here.
                        They share links via SMS — opening them adds the
                        question to this inbox automatically.
                    </p>
                ) : (
                    <ul className="space-y-2">
                        {inboxSorted.map((entry) => {
                            const meta = CATEGORIES[entry.id as CategoryId];
                            const Icon = meta?.icon;
                            const ago = formatRelativeAgo(
                                entry.arrivedAt,
                                now,
                            );
                            return (
                                <li
                                    key={entry.key}
                                    className={cn(
                                        "rounded-sm border border-border border-t-[5px]",
                                        "px-3 py-2 bg-secondary/40",
                                        "flex items-start gap-2",
                                    )}
                                    style={{
                                        borderTopColor:
                                            meta?.color ?? "#999",
                                    }}
                                >
                                    {Icon && (
                                        <span
                                            className="inline-flex items-center justify-center w-6 h-6 rounded shrink-0 mt-0.5"
                                            style={{
                                                backgroundColor:
                                                    meta!.color,
                                            }}
                                        >
                                            <Icon
                                                size={13}
                                                strokeWidth={2.5}
                                                className="text-white"
                                            />
                                        </span>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="font-inter-tight font-black uppercase text-xs tracking-[0.12em]">
                                                {meta?.label ?? entry.id}
                                            </span>
                                            <span className="text-[10px] text-muted-foreground tabular-nums">
                                                {ago}
                                            </span>
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                                            {entry.repliedAt
                                                ? "Answered."
                                                : "Awaiting your answer."}
                                        </p>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            {/* ───── 5. Hand (real deck engine) ───── */}
            <HiderHandPanel />

            {/* "Draw N keep K" modal — fires whenever an answer triggers
                a reward draw that has more cards than the keep budget
                (matching/measuring 3→1, radar/thermometer 2→1, tentacle
                4→2). Photo's 1→1 auto-resolves and never opens the
                modal. */}
            <DrawPickerDialog />

            {/* ───── 6. Footer ───── */}
            <footer className="mt-auto pt-6 flex flex-col gap-2 text-center">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        if (
                            confirm(
                                "Switch back to the seeker side? Hider-side state (hiding zone, inbox, hand) stays saved on this device.",
                            )
                        ) {
                            playerRole.set("seeker");
                            window.location.assign("/");
                        }
                    }}
                >
                    Switch to seeker
                </Button>
                <p className="text-[10px] text-muted-foreground">
                    Jet Lag Hide and Seek · hider home ·{" "}
                    {$role === "hider" ? "active" : "guest"}
                </p>
            </footer>

        </div>
    );
}

/* ────────────────── Hiding zone section ────────────────── */

function HidingZoneSection({
    zone,
    radiusMeters,
    disabled,
}: {
    zone: ReturnType<typeof hidingZone.get>;
    radiusMeters: number;
    disabled?: boolean;
}) {
    const [editing, setEditing] = useState(zone === null);
    const [draftLat, setDraftLat] = useState<number>(zone?.stationLat ?? 0);
    const [draftLng, setDraftLng] = useState<number>(zone?.stationLng ?? 0);
    const [draftName, setDraftName] = useState<string>(zone?.stationName ?? "");

    useEffect(() => {
        // Sync drafts when the persisted zone changes externally.
        if (zone) {
            setDraftLat(zone.stationLat);
            setDraftLng(zone.stationLng);
            setDraftName(zone.stationName);
        }
    }, [zone]);

    const commitZone = () => {
        if (!Number.isFinite(draftLat) || !Number.isFinite(draftLng)) {
            toast.error("Pin a location for your station first.");
            return;
        }
        hidingZone.set({
            stationName: draftName || "Hiding zone",
            stationLat: draftLat,
            stationLng: draftLng,
            radiusMeters,
            committedAt: Date.now(),
        });
        setEditing(false);
        toast.success("Hiding zone committed.", { autoClose: 2000 });
    };

    return (
        <section className="mt-1">
            <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-4 h-4 text-muted-foreground" />
                <SectionPill>Hiding zone</SectionPill>
                {zone && !editing && (
                    <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                        {(radiusMeters / 1000).toFixed(
                            radiusMeters >= 1000 ? 1 : 2,
                        )}{" "}
                        km radius
                    </span>
                )}
            </div>
            {zone && !editing ? (
                <div className="rounded-sm border border-border bg-secondary/40 p-3 flex items-start gap-3">
                    <Lock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                        <div className="font-inter-tight font-bold uppercase tracking-wide text-sm">
                            {zone.stationName}
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                            {zone.stationLat.toFixed(5)},{" "}
                            {zone.stationLng.toFixed(5)}
                        </div>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(true)}
                        disabled={disabled}
                    >
                        Change
                    </Button>
                </div>
            ) : (
                <div className="space-y-3">
                    <p className="text-xs text-muted-foreground leading-snug px-1">
                        Pick the transit station your hiding zone is
                        centered on. The {(radiusMeters / 1000).toFixed(
                            radiusMeters >= 1000 ? 1 : 2,
                        )}{" "}
                        km circle is the area you can move within for
                        this round (rulebook p41).
                    </p>
                    <Suspense
                        fallback={
                            <div className="w-full h-[40vh] rounded-md border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground">
                                Loading map…
                            </div>
                        }
                    >
                        <InlineLocationPicker
                            latitude={draftLat}
                            longitude={draftLng}
                            onChange={(la, ln) => {
                                if (la !== null) setDraftLat(la);
                                if (ln !== null) setDraftLng(ln);
                            }}
                            radiusMeters={radiusMeters}
                        />
                    </Suspense>
                    <input
                        type="text"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        placeholder="Station name (e.g. Mariatorget)"
                        className={cn(
                            "w-full px-3 py-2 rounded-md border border-border",
                            "bg-secondary/40 text-sm",
                            "focus:outline-none focus:ring-2 focus:ring-ring",
                        )}
                    />
                    <div className="flex justify-end gap-2">
                        {zone && (
                            <Button
                                variant="outline"
                                onClick={() => setEditing(false)}
                            >
                                Cancel
                            </Button>
                        )}
                        <Button onClick={commitZone} disabled={disabled}>
                            <Lock className="w-3.5 h-3.5 mr-1" />
                            Commit zone
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}

/* ────────────────── Final score banner ────────────────── */

/**
 * Big "round ended" banner pinned to the top of HiderHome once
 * `roundFoundAt` is set. Shows seek-time (numerator) minus the hider's
 * accumulated time-bonus minutes (denominator), and a single combined
 * "final score" line — the value the table compares across rounds.
 *
 * The hider can also tap "Mark round ended manually" if the seeker
 * forgot to share the round-end link.
 */
function FinalScoreBanner({
    foundAt,
    hidingEndsAt,
    timeBonusMinutes,
}: {
    foundAt: number;
    hidingEndsAt: number;
    timeBonusMinutes: number;
}) {
    const seekMs = Math.max(0, foundAt - hidingEndsAt);
    const finalMs = Math.max(0, seekMs - timeBonusMinutes * 60_000);

    return (
        <section className="rounded-md border-2 border-primary bg-primary/10 px-4 py-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
                <Trophy className="w-5 h-5 text-primary" />
                <span className="font-inter-tight font-black uppercase text-sm tracking-[0.16em] text-primary">
                    Round ended · final score
                </span>
            </div>
            <div className="flex items-center justify-center">
                <div className="text-center">
                    <div className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.18em] text-muted-foreground mb-1">
                        Final
                    </div>
                    <div className="font-inter-tight italic font-black tabular-nums text-4xl text-primary leading-none">
                        {formatElapsed(finalMs)}
                    </div>
                </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
                <div className="rounded-sm bg-background/40 border border-border py-2 px-1">
                    <div className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                        Seek time
                    </div>
                    <div className="font-inter-tight font-bold tabular-nums text-base mt-0.5">
                        {formatElapsed(seekMs)}
                    </div>
                </div>
                <div className="rounded-sm bg-background/40 border border-border py-2 px-1">
                    <div className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                        Bonus minutes
                    </div>
                    <div className="font-inter-tight font-bold tabular-nums text-base mt-0.5">
                        −{timeBonusMinutes}m
                    </div>
                </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-3 text-center leading-snug">
                Lower is better for the seeker; higher is better for the hider.
                Carry to the next round for cumulative scoring.
            </p>
        </section>
    );
}

/* ────────────────── Hiding spot lockdown section ────────────────── */

/**
 * Lockdown UI for the hider's final committed spot. Becomes available
 * the moment the hiding period ends — the hider should pin themselves
 * to a spot once they're done moving.
 *
 * Rulebook p43: must be publicly accessible during all game hours and
 * within 3m of a marked path/road. We don't validate that geometrically
 * yet (planned), but capture an optional freeform description so the
 * hider can record landmarks ("bench by the library entrance") for
 * later verification.
 */
function HidingSpotSection({
    spot,
    roundOver,
}: {
    spot: ReturnType<typeof hidingSpot.get>;
    roundOver: boolean;
}) {
    const [editing, setEditing] = useState(spot === null);
    const [draftDesc, setDraftDesc] = useState(spot?.description ?? "");
    const [draftLat, setDraftLat] = useState<number>(spot?.lat ?? 0);
    const [draftLng, setDraftLng] = useState<number>(spot?.lng ?? 0);
    const [locating, setLocating] = useState(false);

    useEffect(() => {
        if (spot) {
            setDraftDesc(spot.description ?? "");
            setDraftLat(spot.lat);
            setDraftLng(spot.lng);
        }
    }, [spot]);

    const useMyGps = () => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            toast.error("Geolocation isn't available on this device.");
            return;
        }
        setLocating(true);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setDraftLat(pos.coords.latitude);
                setDraftLng(pos.coords.longitude);
                setLocating(false);
                toast.success("Pinned to your current GPS.", {
                    autoClose: 1500,
                });
            },
            (err) => {
                setLocating(false);
                toast.error(
                    err.code === err.PERMISSION_DENIED
                        ? "Location permission denied."
                        : "Couldn't get your GPS location.",
                );
            },
            { enableHighAccuracy: true, timeout: 8000 },
        );
    };

    const commitSpot = () => {
        if (!Number.isFinite(draftLat) || !Number.isFinite(draftLng)) {
            toast.error("Set your spot's GPS first.");
            return;
        }
        hidingSpot.set({
            lat: draftLat,
            lng: draftLng,
            description: draftDesc.trim() || undefined,
            lockedAt: Date.now(),
        });
        setEditing(false);
        toast.success("Hiding spot locked.", { autoClose: 2000 });
    };

    return (
        <section className="mt-5">
            <div className="flex items-center gap-2 mb-2">
                <Crosshair className="w-4 h-4 text-muted-foreground" />
                <SectionPill>Hiding spot</SectionPill>
                {spot && !editing && (
                    <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                        locked
                    </span>
                )}
            </div>
            {spot && !editing ? (
                <div className="rounded-sm border border-border bg-secondary/40 p-3 flex items-start gap-3">
                    <Lock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                        {spot.description && (
                            <div className="font-inter-tight font-bold uppercase tracking-wide text-sm leading-tight">
                                {spot.description}
                            </div>
                        )}
                        <div className="text-xs text-muted-foreground tabular-nums">
                            {spot.lat.toFixed(5)}, {spot.lng.toFixed(5)}
                        </div>
                    </div>
                    {!roundOver && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditing(true)}
                        >
                            <LockOpen className="w-3.5 h-3.5 mr-1" />
                            Move
                        </Button>
                    )}
                </div>
            ) : (
                <div className="space-y-3">
                    <p className="text-xs text-muted-foreground leading-snug px-1">
                        Hiding period is over. Pin your spot and stay there
                        — the seeker can't ask new questions if you keep
                        moving (rulebook p43).
                    </p>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={useMyGps}
                            disabled={locating}
                            className="gap-1.5"
                        >
                            <MapPin className="w-3.5 h-3.5" />
                            {locating ? "Locating…" : "Use my GPS"}
                        </Button>
                        {Number.isFinite(draftLat) &&
                            Number.isFinite(draftLng) &&
                            (draftLat !== 0 || draftLng !== 0) && (
                                <span className="self-center text-[11px] text-muted-foreground tabular-nums">
                                    {draftLat.toFixed(5)},{" "}
                                    {draftLng.toFixed(5)}
                                </span>
                            )}
                    </div>
                    <input
                        type="text"
                        value={draftDesc}
                        onChange={(e) => setDraftDesc(e.target.value)}
                        placeholder="Optional: a short description (bench by the library)"
                        className={cn(
                            "w-full px-3 py-2 rounded-md border border-border",
                            "bg-secondary/40 text-sm",
                            "focus:outline-none focus:ring-2 focus:ring-ring",
                        )}
                    />
                    <div className="flex justify-end gap-2">
                        {spot && (
                            <Button
                                variant="outline"
                                onClick={() => setEditing(false)}
                            >
                                Cancel
                            </Button>
                        )}
                        <Button
                            onClick={commitSpot}
                            disabled={
                                !Number.isFinite(draftLat) ||
                                !Number.isFinite(draftLng) ||
                                (draftLat === 0 && draftLng === 0)
                            }
                        >
                            <Lock className="w-3.5 h-3.5 mr-1" />
                            Lock spot
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}

/* ────────────────── tiny formatters ────────────────── */

function formatElapsed(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
}

function formatRelativeAgo(timestamp: number, now: number): string {
    const diffSec = Math.floor((now - timestamp) / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
}

export default HiderHome;
