import { useStore } from "@nanostores/react";
import {
    Copy,
    Footprints,
    LogOut,
    Radio,
    Share2,
    Users,
    VenetianMask,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useMemo, useState } from "react";
import { toast } from "react-toastify";
import { COPY_FAILED, SHARE_FAILED } from "@/lib/toastMessages";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { appConfirm } from "@/lib/confirm";
import {
    currentGameCode,
    displayName as displayNameAtom,
    participants,
    seekerLocations,
    transportStatus,
} from "@/lib/multiplayer/session";
import type { Participant } from "@/lib/multiplayer/types";
import { returnToLandingPage } from "@/lib/roundActions";
import { cn } from "@/lib/utils";

/**
 * Inline "your game code" panel — small enough to embed inside the
 * BottomNav's "More" sheet without its own modal. Shows the active
 * code, a copy/share row, the participant roster, and a "leave"
 * affordance.
 *
 * Roster sort + role icons follow the rolebook convention used by
 * RolePicker.tsx:
 *
 *     Footprints   — seeker
 *     VenetianMask — hider (main)
 *     Users        — co-hider
 *
 * Order: the hider team first (main hider, then co-hiders), seekers
 * after — mirrors how players actually talk about the round ("the
 * hider and their crew") and groups teammates visually. Self is
 * marked with a "(you)" suffix but stays in its natural team slot
 * so the roster reflects the game, not the device.
 */
export function InvitePanel() {
    const $code = useStore(currentGameCode);
    const $participants = useStore(participants);
    const $status = useStore(transportStatus);
    const $displayName = useStore(displayNameAtom);
    const [qrOpen, setQrOpen] = useState(false);

    const shareUrl = useMemo(() => {
        if (!$code || typeof window === "undefined") return "";
        return `${window.location.origin}/?join=${$code}`;
    }, [$code]);

    if (!$code) {
        return (
            <p className="text-xs text-muted-foreground italic">
                Not in an online game. Use &quot;Play online&quot; to host
                or join one.
            </p>
        );
    }

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText($code);
            toast.success(`Code "${$code}" copied.`, { autoClose: 1500 });
        } catch {
            toast.error(COPY_FAILED);
        }
    };

    const handleShare = async () => {
        const text = `Join my Jet Lag Hide and Seek game. Code: ${$code}`;
        if (
            typeof navigator !== "undefined" &&
            typeof navigator.share === "function"
        ) {
            try {
                await navigator.share({
                    title: "Hide and Seek invite",
                    text,
                    url: shareUrl,
                });
                return;
            } catch {
                /* fall through to clipboard */
            }
        }
        try {
            await navigator.clipboard.writeText(`${text}\n${shareUrl}`);
            toast.success("Invite copied to clipboard.", { autoClose: 1500 });
        } catch {
            toast.error(SHARE_FAILED);
        }
    };

    const handleLeave = async () => {
        const ok = await appConfirm({
            title: "Leave the online game?",
            description:
                "You'll go back to the start screen. Local progress on this device is cleared.",
            confirmLabel: "Leave game",
            destructive: true,
        });
        if (!ok) return;
        // Single shared cleanup that disconnects, wipes round state,
        // and routes the user back to the landing surface — the
        // previous flow only ran `leaveGame()`, leaving the seeker
        // map / hider timer still in view with the lobby gone.
        returnToLandingPage();
    };

    const sorted = sortRoster($participants);

    return (
        <div className="space-y-3">
            {/* Game code + QR side by side. The QR is a 64px inline
                preview that doubles as the "show large" trigger —
                visible affordance for in-room scanning AND a fast
                tap target to open the readable version. */}
            <div className="rounded-md border-2 border-primary bg-primary/5 px-4 py-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                    <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                        Game code
                    </div>
                    <div className="mt-1 font-mono font-black tracking-[0.25em] text-2xl text-primary truncate">
                        {$code}
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-wider font-poppins font-semibold text-muted-foreground">
                        {$status === "open"
                            ? "Connected"
                            : $status === "reconnecting"
                              ? "Reconnecting…"
                              : $status === "connecting"
                                ? "Connecting…"
                                : "Offline"}
                    </div>
                </div>
                {shareUrl && (
                    <button
                        type="button"
                        onClick={() => setQrOpen(true)}
                        className={cn(
                            "shrink-0 bg-white rounded-md p-1.5 cursor-pointer",
                            "hover:ring-2 hover:ring-primary/60 transition-shadow",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                        )}
                        aria-label="Show large QR code"
                        title="Tap for a scannable QR code"
                    >
                        <QRCodeSVG
                            value={shareUrl}
                            size={64}
                            level="M"
                            marginSize={0}
                            bgColor="#ffffff"
                            fgColor="#0f172a"
                        />
                    </button>
                )}
            </div>

            <div className="flex gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopy}
                    className="flex-1 gap-1.5"
                >
                    <Copy className="w-3.5 h-3.5" />
                    Copy code
                </Button>
                <Button
                    size="sm"
                    onClick={handleShare}
                    className="flex-1 gap-1.5"
                >
                    <Share2 className="w-3.5 h-3.5" />
                    Share invite
                </Button>
            </div>

            {sorted.length > 0 && (
                <TeamRoster
                    participants={sorted}
                    selfDisplayName={$displayName}
                />
            )}

            <Button
                variant="outline"
                size="sm"
                onClick={handleLeave}
                className="w-full gap-1.5"
            >
                <LogOut className="w-3.5 h-3.5" />
                Leave online game
            </Button>

            {shareUrl && (
                <Dialog open={qrOpen} onOpenChange={setQrOpen}>
                    <DialogContent
                        // InviteSheet renders INSIDE the lobby drawer (vaul,
                        // z-[1055]). A plain Radix Dialog defaults to z-[1050],
                        // so this opened BEHIND the lobby — invisible, but its
                        // DismissableLayer still froze the page (body
                        // pointer-events:none) with no reachable way to dismiss
                        // it. Lift content + overlay above the lobby, matching
                        // RotateHiderDialog (the same launched-from-lobby case).
                        className={cn(
                            "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                            "sm:max-w-xs flex flex-col items-center p-6 gap-4",
                            "z-[1060]",
                        )}
                        overlayClassName="z-[1060]"
                    >
                        <DialogTitle className="font-poppins font-bold uppercase text-base tracking-[0.10em]">
                            Scan to join
                        </DialogTitle>
                        <div
                            className="bg-white rounded-md p-3"
                            aria-label="Scan to join this game"
                        >
                            <QRCodeSVG
                                value={shareUrl}
                                size={240}
                                level="M"
                                marginSize={0}
                                bgColor="#ffffff"
                                fgColor="#0f172a"
                            />
                        </div>
                        <div className="text-center">
                            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                                Room code
                            </div>
                            <div className="font-mono font-black tracking-[0.25em] text-xl text-primary mt-1">
                                {$code}
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}

/**
 * Split the roster into Hiders + Seekers sections (each with a small
 * count subheader), then render the seekers section with a per-row
 * "GPS Xs ago" subline so the hider can see at a glance whose
 * position is fresh. Updates every second while the panel is
 * visible — `useVisibleInterval` pauses on tab hidden so a stale
 * lobby doesn't burn battery.
 */
function TeamRoster({
    participants,
    selfDisplayName,
}: {
    participants: Participant[];
    selfDisplayName: string | null;
}) {
    const hiders = participants.filter((p) => p.role === "hider");
    const seekers = participants.filter((p) => p.role === "seeker");
    const unassigned = participants.filter((p) => !p.role);
    const $locations = useStore(seekerLocations);

    // 1 Hz tick so the "Ns ago" subline counts forward even when no
    // new location event has arrived. The component already
    // re-renders on $locations changes, so this just covers the
    // between-update intervals.
    const [, setTick] = useState(0);
    useVisibleInterval(
        () => setTick((n) => (n + 1) & 0xffff),
        1000,
        seekers.length > 0,
    );

    return (
        <div className="space-y-3">
            {hiders.length > 0 && (
                <RosterSection
                    label="Hiders"
                    count={hiders.length}
                    rows={hiders.map((p) => (
                        <ParticipantRow
                            key={p.id}
                            p={p}
                            isSelf={p.displayName === selfDisplayName}
                        />
                    ))}
                />
            )}
            {seekers.length > 0 && (
                <RosterSection
                    label="Seekers"
                    count={seekers.length}
                    rows={seekers.map((p) => (
                        <ParticipantRow
                            key={p.id}
                            p={p}
                            isSelf={p.displayName === selfDisplayName}
                            gpsAt={$locations[p.id]?.ts}
                        />
                    ))}
                />
            )}
            {unassigned.length > 0 && (
                <RosterSection
                    label="No role yet"
                    count={unassigned.length}
                    rows={unassigned.map((p) => (
                        <ParticipantRow
                            key={p.id}
                            p={p}
                            isSelf={p.displayName === selfDisplayName}
                        />
                    ))}
                />
            )}
        </div>
    );
}

function RosterSection({
    label,
    count,
    rows,
}: {
    label: string;
    count: number;
    rows: React.ReactNode;
}) {
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                {label} ({count})
            </div>
            <ul className="space-y-1">{rows}</ul>
        </div>
    );
}

function ParticipantRow({
    p,
    isSelf,
    gpsAt,
}: {
    p: Participant;
    isSelf: boolean;
    /** Last GPS-update timestamp for this participant. Only meaningful
     *  for seekers; passing undefined hides the freshness subline. */
    gpsAt?: number;
}) {
    const meta = roleMeta(p.role);
    const Icon = meta.icon;
    return (
        <li
            className={cn(
                "flex flex-col gap-0.5 px-2.5 py-1.5 rounded-sm",
                "bg-secondary/40 border border-border",
                "text-xs",
            )}
        >
            <div className="flex items-center gap-2">
                <span
                    className={cn(
                        "w-2 h-2 rounded-full shrink-0",
                        p.online ? "bg-success" : "bg-muted-foreground/40",
                    )}
                    aria-hidden="true"
                />
                <Icon
                    className={cn("w-3.5 h-3.5 shrink-0", meta.iconCls)}
                    aria-hidden="true"
                />
                <span className="font-poppins font-semibold truncate flex-1">
                    {p.displayName || "(no name)"}
                </span>
                {p.role && (
                    <span
                        className={cn(
                            "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm font-bold",
                            meta.chipCls,
                        )}
                    >
                        {meta.label}
                    </span>
                )}
                {isSelf && (
                    <span className="text-[10px] text-muted-foreground">
                        (you)
                    </span>
                )}
            </div>
            {p.role === "seeker" && (
                <div className="flex items-center gap-1.5 pl-4 text-[10px] text-muted-foreground">
                    <Radio
                        className={cn(
                            "w-3 h-3",
                            gpsAt
                                ? "text-success"
                                : "text-muted-foreground/60",
                        )}
                        aria-hidden="true"
                    />
                    <span>
                        {gpsAt
                            ? `GPS ${formatFreshness(gpsAt)}`
                            : "No GPS yet"}
                    </span>
                </div>
            )}
        </li>
    );
}

/** "3s ago" / "1m ago" / "12m ago" — abbreviated for tight roster row.
 *  Stale (>10 min) shows the human-readable timestamp instead so a
 *  fresh-looking "9m ago" can't hide a multi-hour gap. */
function formatFreshness(ts: number): string {
    const ageMs = Math.max(0, Date.now() - ts);
    const sec = Math.floor(ageMs / 1000);
    if (sec < 5) return "now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 10) return `${min}m ago`;
    if (min < 60) return `${min}m ago (stale)`;
    const hr = Math.floor(min / 60);
    return `${hr}h ago (stale)`;
}

/** Order: hiders → seekers. Within a team, alphabetic on the display
 *  name for stable rendering across re-renders. */
function sortRoster(list: Participant[]): Participant[] {
    const order: Record<string, number> = {
        hider: 0,
        seeker: 1,
    };
    return [...list].sort((a, b) => {
        const ra = a.role ? (order[a.role] ?? 9) : 9;
        const rb = b.role ? (order[b.role] ?? 9) : 9;
        if (ra !== rb) return ra - rb;
        return (a.displayName ?? "").localeCompare(b.displayName ?? "");
    });
}

function roleMeta(role: Participant["role"]) {
    if (role === "hider") {
        return {
            label: "Hider",
            icon: VenetianMask,
            iconCls: "text-purple-300",
            chipCls: "bg-purple-500/20 text-purple-300",
        };
    }
    if (role === "seeker") {
        return {
            label: "Seeker",
            icon: Footprints,
            iconCls: "text-primary",
            chipCls: "bg-primary/15 text-primary",
        };
    }
    return {
        label: "—",
        icon: Footprints,
        iconCls: "text-muted-foreground",
        chipCls: "bg-secondary/40 text-muted-foreground",
    };
}

export default InvitePanel;
