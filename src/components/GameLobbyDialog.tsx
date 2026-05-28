import { useStore } from "@nanostores/react";
import {
    Check,
    Copy,
    Eye,
    Loader2,
    LogOut,
    MapPin,
    Rocket,
    Share2,
    Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
    mapGeoJSON,
    polyGeoJSON,
} from "@/lib/context";
import {
    HIDING_PERIOD_MINUTES,
    gameSize,
    hidingPeriodEndsAt,
    pendingHidingDurationMin,
    playArea,
    setupCompleted,
    welcomeSeen,
} from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import {
    currentGameCode,
    multiplayerEnabled,
    participants,
    selfParticipantId,
} from "@/lib/multiplayer/session";
import { hostPushSetup, leaveGame } from "@/lib/multiplayer/store";
import { loadingProgress } from "@/lib/loadingProgress";
import { cn } from "@/lib/utils";

import { HideSeekMark, HideSeekWordmark, RoleChip } from "./JetLagLogo";

/**
 * Pre-game lobby. Sits between the setup wizard and the hiding-period
 * clock, replacing the older "auto-start once map loads" flow.
 *
 * Shown when:
 *   - welcomeSeen
 *   - setupCompleted
 *   - hidingPeriodEndsAt === null (game not running yet)
 *   - playerRole !== null         (RolePicker handled the role first)
 *
 * Inside, the user sees their role, the room code + share link, the
 * participant list, and the map-loading progress — all on one screen
 * so they understand *why* the game can't start yet. The "Start
 * game" button gates on:
 *   - Map boundary loaded
 *   - In multiplayer: at least one online seeker AND at least one
 *     online hider/coHider (otherwise the game can't actually be
 *     played). Solo play skips the role-balance check.
 *   - In multiplayer: the local player is the host (only one device
 *     should own the clock kickoff).
 *
 * Tapping Start sets hidingPeriodEndsAt — that transition is picked
 * up by GameStartWatcher which opens the GoGoGoOverlay celebration
 * on both host and guest devices.
 */
export function GameLobbyDialog() {
    const $setupCompleted = useStore(setupCompleted);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $welcomeSeen = useStore(welcomeSeen);
    const $playerRole = useStore(playerRole);
    const $playArea = useStore(playArea);
    const $code = useStore(currentGameCode);
    const $participants = useStore(participants);
    const $self = useStore(selfParticipantId);
    const $mp = useStore(multiplayerEnabled);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $pending = useStore(pendingHidingDurationMin);
    const $size = useStore(gameSize);
    const $loading = useStore(loadingProgress);

    const open =
        $welcomeSeen &&
        $setupCompleted &&
        $hidingEndsAt === null &&
        $playerRole !== null;

    const mapReady = Boolean($mapGeoJSON || $polyGeoJSON);
    const seekers = $participants.filter(
        (p) => p.online && p.role === "seeker",
    );
    const hiders = $participants.filter(
        (p) =>
            p.online && (p.role === "hider" || p.role === "coHider"),
    );
    const hasRoleBalance = $mp
        ? seekers.length >= 1 && hiders.length >= 1
        : true;

    // Identify the host. In a multiplayer room the host owns the
    // clock kickoff; guests see a "waiting for host to start"
    // message instead of an active button. We treat the first
    // participant (joinedAt asc) as the host — that's also how the
    // server tracks ownership for setup pushes.
    const sorted = [...$participants].sort(
        (a, b) => a.joinedAt - b.joinedAt,
    );
    const hostId = sorted[0]?.id ?? null;
    const isHost = !$mp || hostId === null || hostId === $self;

    const canStart =
        mapReady && hasRoleBalance && isHost && $playerRole !== null;

    const minutes =
        $pending && $pending > 0
            ? $pending
            : HIDING_PERIOD_MINUTES[$size];

    const shareUrl = useMemo(() => {
        if (!$code || typeof window === "undefined") return "";
        return `${window.location.origin}/?join=${$code}`;
    }, [$code]);

    const [copied, setCopied] = useState(false);
    const handleCopy = async () => {
        if (!shareUrl) return;
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopied(true);
            toast.success("Invite link copied.", { autoClose: 1500 });
            setTimeout(() => setCopied(false), 1500);
        } catch {
            toast.error("Couldn't copy. Long-press the link instead.");
        }
    };
    const handleShare = async () => {
        if (!shareUrl) return;
        if (typeof navigator !== "undefined" && "share" in navigator) {
            try {
                await (navigator as Navigator).share({
                    title: "Join my Hide+Seek game",
                    text: `Game code ${$code}`,
                    url: shareUrl,
                });
                return;
            } catch {
                /* user cancelled — fall through to copy */
            }
        }
        await handleCopy();
    };

    const handleStartGame = () => {
        if (!canStart) return;
        hidingPeriodEndsAt.set(Date.now() + minutes * 60_000);
        pendingHidingDurationMin.set(null);
        // Mirror to peers — the setup atoms are the source of truth.
        hostPushSetup();
    };

    if (!open) return null;

    return (
        <Dialog
            open={open}
            onOpenChange={() => {
                /* The lobby is non-dismissible. Path forward is
                   Start (host) or wait (guest); path backward is
                   "Leave game" which clears the room. */
            }}
        >
            <DialogContent
                closeIcon={false}
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0 max-h-[92vh] sm:max-w-md",
                )}
            >
                {/* Hero: wordmark + role chip */}
                <div className="px-6 pt-6 pb-4 flex flex-col items-center text-center gap-3">
                    <HideSeekMark size={56} onDark />
                    <HideSeekWordmark boxLayout size="lg" />
                    <DialogTitle className="sr-only">
                        Game lobby — waiting to start
                    </DialogTitle>
                    {$playerRole && (
                        <div className="pt-1">
                            <RoleChip
                                role={$playerRole}
                                tag={$code ?? undefined}
                            />
                        </div>
                    )}
                </div>

                <div className="px-6 pb-2 flex-1 overflow-y-auto space-y-5">
                    {/* Play area */}
                    {$playArea && (
                        <div className="text-center text-sm text-slate-300">
                            Playing in{" "}
                            <span className="font-semibold text-white">
                                {$playArea.displayName.split(",")[0]}
                            </span>{" "}
                            · {minutes}-min hiding period
                        </div>
                    )}

                    {/* Invite + share */}
                    {$mp && $code && (
                        <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-2.5">
                            <div className="flex items-center justify-between gap-2">
                                <div>
                                    <div className="text-[10px] uppercase tracking-[0.16em] font-display font-extrabold text-muted-foreground">
                                        Room code
                                    </div>
                                    <div className="font-display font-black uppercase text-2xl tabular-nums tracking-[0.04em] leading-none mt-0.5">
                                        {$code}
                                    </div>
                                </div>
                                <div className="flex gap-1.5">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={handleCopy}
                                        className="gap-1.5"
                                    >
                                        {copied ? (
                                            <Check className="w-3.5 h-3.5" />
                                        ) : (
                                            <Copy className="w-3.5 h-3.5" />
                                        )}
                                        Copy link
                                    </Button>
                                    <Button
                                        size="sm"
                                        onClick={handleShare}
                                        className="gap-1.5"
                                    >
                                        <Share2 className="w-3.5 h-3.5" />
                                        Share
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Participants */}
                    {$mp && $participants.length > 0 && (
                        <div className="space-y-1.5">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-display font-extrabold text-muted-foreground">
                                Who's in
                            </div>
                            <ul className="rounded-md border border-border bg-secondary/40 divide-y divide-border/70">
                                {sorted.map((p) => {
                                    const isMe = p.id === $self;
                                    const isThisHost = p.id === hostId;
                                    return (
                                        <li
                                            key={p.id}
                                            className="flex items-center gap-2 px-3 py-2 text-sm"
                                        >
                                            <RoleDot role={p.role} />
                                            <span
                                                className={cn(
                                                    "flex-1 truncate",
                                                    !p.online && "opacity-50",
                                                )}
                                            >
                                                {p.displayName || "Anonymous"}
                                                {isMe && (
                                                    <span className="ml-1.5 text-xs text-muted-foreground">
                                                        (you)
                                                    </span>
                                                )}
                                            </span>
                                            {isThisHost && (
                                                <span className="text-[10px] uppercase tracking-[0.10em] font-display font-extrabold text-muted-foreground">
                                                    Host
                                                </span>
                                            )}
                                            <RoleTag role={p.role} />
                                        </li>
                                    );
                                })}
                            </ul>
                            {!hasRoleBalance && (
                                <p className="text-xs text-muted-foreground leading-snug pt-1">
                                    Need at least one <b>seeker</b> and one{" "}
                                    <b>hider</b> in the room before the game
                                    can start. Share the link above to invite
                                    friends.
                                </p>
                            )}
                        </div>
                    )}

                    {/* Map loading status */}
                    <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-[0.16em] font-display font-extrabold text-muted-foreground">
                            Map
                        </div>
                        <div className="rounded-md border border-border bg-secondary/40 px-3 py-2.5 flex items-center gap-3">
                            {mapReady ? (
                                <>
                                    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary/15 text-primary shrink-0">
                                        <Check className="w-4 h-4" />
                                    </span>
                                    <div className="text-sm">
                                        Play area ready
                                    </div>
                                </>
                            ) : (
                                <>
                                    <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
                                    <div className="text-sm min-w-0 flex-1">
                                        <div className="truncate">
                                            {$loading?.title ??
                                                "Loading play area"}
                                        </div>
                                        <div className="text-xs text-muted-foreground truncate">
                                            {$loading?.phase ??
                                                "Fetching boundary…"}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* Start button */}
                <div className="px-6 pt-3 pb-6 border-t border-border space-y-2">
                    {isHost ? (
                        <Button
                            size="lg"
                            className={cn(
                                "w-full h-14 gap-2 text-base",
                                "font-display font-extrabold uppercase tracking-[0.02em]",
                            )}
                            onClick={handleStartGame}
                            disabled={!canStart}
                        >
                            <Rocket className="w-5 h-5" />
                            {canStart
                                ? `Start game · ${minutes}-min hiding period`
                                : !mapReady
                                  ? "Preparing map…"
                                  : !hasRoleBalance
                                    ? "Waiting for players…"
                                    : "Start game"}
                        </Button>
                    ) : (
                        <div className="text-center text-sm text-slate-300 py-2">
                            Waiting for the host to start the game…
                        </div>
                    )}
                    {$mp && $code && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                if (
                                    typeof window === "undefined" ||
                                    window.confirm(
                                        "Leave this online game? You'll exit the room — the others can keep playing without you.",
                                    )
                                ) {
                                    leaveGame();
                                }
                            }}
                            className="w-full gap-1.5 text-muted-foreground"
                        >
                            <LogOut className="w-3.5 h-3.5" />
                            Leave game
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function RoleDot({ role }: { role: "seeker" | "hider" | "coHider" | null }) {
    const cls =
        role === "seeker"
            ? "bg-primary"
            : role === "hider"
              ? "bg-[hsl(var(--accent-yellow))]"
              : role === "coHider"
                ? "bg-[hsl(var(--accent-orange))]"
                : "bg-muted";
    return (
        <span
            className={cn("inline-block w-2.5 h-2.5 rounded-full shrink-0", cls)}
            aria-hidden
        />
    );
}

function RoleTag({ role }: { role: "seeker" | "hider" | "coHider" | null }) {
    if (!role) {
        return (
            <span className="text-[10px] uppercase tracking-[0.10em] font-display font-extrabold text-muted-foreground">
                Picking…
            </span>
        );
    }
    const icon =
        role === "seeker" ? (
            <Eye className="w-3 h-3" />
        ) : role === "hider" ? (
            <MapPin className="w-3 h-3" />
        ) : (
            <Users className="w-3 h-3" />
        );
    const label =
        role === "seeker" ? "Seeker" : role === "hider" ? "Hider" : "Co-hider";
    return (
        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.10em] font-display font-extrabold text-muted-foreground">
            {icon}
            {label}
        </span>
    );
}

export default GameLobbyDialog;
