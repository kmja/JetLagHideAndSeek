import { useStore } from "@nanostores/react";
import {
    AlertTriangle,
    Inbox,
    Lock,
    MapPin,
    Timer,
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
import {
    hiderHand,
    hiderHandLimit,
    hiderInbox,
    hidingZone,
    playerRole,
    radiusForGameSize,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";
import { CATEGORIES, type CategoryId } from "@/lib/categories";

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
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $gameSize = useStore(gameSize);
    const $inbox = useStore(hiderInbox);
    const $hand = useStore(hiderHand);
    const $handLimit = useStore(hiderHandLimit);

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
    const hiddenElapsedMs = $hidingEndsAt
        ? Math.max(0, now - $hidingEndsAt)
        : 0;

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

            {/* ───── 2. Phase badge ───── */}
            {$hidingEndsAt ? (
                <section
                    className={cn(
                        "rounded-md border-2 px-4 py-3 mb-4 flex items-center gap-3",
                        inHidingPeriod
                            ? "border-primary bg-primary/5"
                            : "border-yellow-500/60 bg-yellow-500/5",
                    )}
                >
                    <Timer
                        className={cn(
                            "w-5 h-5 shrink-0",
                            inHidingPeriod
                                ? "text-primary"
                                : "text-yellow-500",
                        )}
                    />
                    <div className="flex flex-col leading-none gap-1">
                        <span className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.18em] text-muted-foreground">
                            {inHidingPeriod ? "Hiding period" : "Hidden for"}
                        </span>
                        <span className="font-inter-tight italic font-black tabular-nums text-2xl text-primary leading-none">
                            {inHidingPeriod
                                ? formatTimeRemaining(remainingMs)
                                : formatElapsed(hiddenElapsedMs)}
                            {inHidingPeriod && (
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

            {/* ───── 5. Hand (placeholder until deck mechanics land) ───── */}
            <section className="mt-5">
                <div className="flex items-center gap-2 mb-2">
                    <SectionPill>Hand</SectionPill>
                    <span className="text-[10px] text-muted-foreground tabular-nums ml-auto">
                        {$hand.length} / {$handLimit}
                    </span>
                </div>
                {$hand.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic px-1">
                        You'll draw cards from the hider deck as the seeker
                        answers questions. The deck mechanics aren't
                        wired up in the app yet — for now, track time
                        bonuses + powerups + curses with the physical
                        cards from the box.
                    </p>
                ) : (
                    <ul className="space-y-1.5">
                        {$hand.map((card) => (
                            <li
                                key={card.id}
                                className={cn(
                                    "rounded-sm border border-border px-3 py-2",
                                    "bg-secondary/40 text-sm",
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <SectionPill
                                        tone={
                                            card.subtype === "curse"
                                                ? "dark"
                                                : "light"
                                        }
                                    >
                                        {card.subtype.replace("-", " ")}
                                    </SectionPill>
                                    <span className="font-inter-tight font-bold uppercase tracking-wide text-xs">
                                        {card.name}
                                    </span>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1 leading-snug">
                                    {card.description}
                                </p>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

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
