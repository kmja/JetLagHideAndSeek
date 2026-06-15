import { useStore } from "@nanostores/react";
import { bbox } from "@turf/turf";
import {
    ArrowRight,
    Bus,
    Check,
    Clock,
    Copy,
    Footprints,
    Loader2,
    LogOut,
    MapPin,
    QrCode,
    Radio,
    RadioReceiver,
    Settings,
    Share2,
    Ship,
    Timer,
    TramFront,
    Train,
    TrainTrack,
    VenetianMask,
    X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import MapGL, { Layer, Source } from "react-map-gl/maplibre";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { appConfirm } from "@/lib/confirm";
import {
    mapGeoJSON,
    polyGeoJSON,
} from "@/lib/context";
import {
    allowedTransit,
    formatTimeRemaining,
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    pendingHidingDurationMin,
    playArea,
    setupCompleted,
    setupDialogOpen,
    TRANSIT_LABELS,
    type TransitMode,
    welcomeSeen,
} from "@/lib/gameSetup";
import { playerRole, rolePickerOpen, roundFoundAt } from "@/lib/hiderRole";
import { formatBytes, loadingPieces } from "@/lib/loadingProgress";
import {
    handleMapLibreError,
    pmtilesUrl,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { loadingProgress } from "@/lib/loadingProgress";
import {
    currentGameCode,
    displayName as displayNameAtom,
    lobbyManualOpen,
    multiplayerEnabled,
    multiplayerError,
    participants,
    seekerLocationSharing,
    selfParticipantId,
    transportStatus,
} from "@/lib/multiplayer/session";
import {
    createGame,
    hostPushSetup,
    joinAsHost,
    leaveGame,
    promoteCoHider,
} from "@/lib/multiplayer/store";
import { returnToLandingPage } from "@/lib/roundActions";
import { cn } from "@/lib/utils";

import {
    HideSeekMark,
    HideSeekWordmark,
    SizeBadge,
} from "./JetLagLogo";
import { NotificationsIconButton } from "./NotificationsToggle";
import { PreloadChoicesPanel } from "./PreloadChoicesPanel";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";

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
    const $allowedTransit = useStore(allowedTransit);
    const $code = useStore(currentGameCode);
    const $participants = useStore(participants);
    const $self = useStore(selfParticipantId);
    const $mp = useStore(multiplayerEnabled);
    const $transportStatus = useStore(transportStatus);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $pending = useStore(pendingHidingDurationMin);
    const $size = useStore(gameSize);
    const $loading = useStore(loadingProgress);
    const $pieces = useStore(loadingPieces);
    const $manualOpen = useStore(lobbyManualOpen);
    const $foundAt = useStore(roundFoundAt);
    const $seekerSharing = useStore(seekerLocationSharing);

    // Two open paths:
    //   1. Auto-open pre-game: standard wizard → lobby → start flow.
    //   2. Manual reopen mid-game: a player taps the "Lobby" button
    //      from the seeker's bottom-nav or the hider's home toolbar
    //      to revisit the roster, re-share the join code, or rotate
    //      roles. The manual flag wins regardless of $hidingEndsAt.
    const open =
        $manualOpen ||
        ($welcomeSeen &&
            $setupCompleted &&
            $hidingEndsAt === null &&
            $playerRole !== null);

    const mapReady = Boolean($mapGeoJSON || $polyGeoJSON);
    const isHiderRole =
        $playerRole === "hider" || $playerRole === "coHider";

    const [now, setNow] = useState(Date.now());
    const isMidGame = $manualOpen && $hidingEndsAt !== null;
    const midGameHidingActive = isMidGame && $hidingEndsAt !== null && $hidingEndsAt > now;
    useVisibleInterval(() => setNow(Date.now()), 1000, isMidGame);
    const midGameRemainingMs = $hidingEndsAt
        ? Math.max(0, $hidingEndsAt - Math.max(now, Date.now()))
        : 0;
    const midGameElapsedMs = $hidingEndsAt
        ? Math.max(0, ($foundAt ?? now) - $hidingEndsAt)
        : 0;

    // Self-heal autohost. If we land in the lobby with no game code
    // — e.g. the wizard's autohost attempt failed on a network blip,
    // or the user joined via Welcome → Join and the host got
    // disconnected — kick a new room here rather than leaving the
    // user stuck in a "Waiting for players…" state with no invite
    // section visible. Idempotent: re-runs only if $code clears.
    const [hostingState, setHostingState] = useState<
        "idle" | "creating" | "failed"
    >("idle");
    useEffect(() => {
        if (!open) return;
        // Note v167-fix: previously this short-circuited on
        // `isHiderRole` under the assumption hiders always join via
        // an invite link instead of hosting. That left a hider who
        // ran the setup wizard from a fresh session permanently
        // stranded — no room was ever created, no participants
        // appeared, and the lobby rendered as a chrome-only dialog
        // with a disabled "Waiting for players…" button. Hiders can
        // host just fine; the role-balance gate (needs ≥1 seeker AND
        // ≥1 hider) still keeps the game from STARTING until a
        // seeker joins, which is the actual rule.
        if (hostingState === "creating") return; // Already in flight.
        // Working room? Keep it. A persisted code that's currently
        // connecting/reconnecting counts as "in progress" — we
        // don't want to abandon it mid-handshake.
        if ($code && $mp) return;
        if (
            $code &&
            ($transportStatus === "connecting" ||
                $transportStatus === "reconnecting")
        ) {
            return;
        }
        // We're here with EITHER no code at all, OR a stale code
        // whose transport gave up (closed) and never came back as
        // $mp=true — abandon it and create a fresh room so the user
        // isn't stuck in a "waiting for players…" state with a dead
        // invite link. leaveGame() clears the stale code/session
        // first; createGame() then yields a working one.
        // Send the typed name, or empty so the server assigns a unique
        // Jet Lag cast name — no two players end up sharing one.
        const name = displayNameAtom.get()?.trim() || "";
        setHostingState("creating");
        multiplayerError.set(null);
        if ($code && !$mp) {
            // Clear the dead session bits before grabbing a new
            // code, otherwise joinAsHost would try to layer on top
            // of a closed transport.
            leaveGame();
        }
        createGame()
            .then((newCode) => {
                joinAsHost(newCode, name);
                hostPushSetup();
                setHostingState("idle");
            })
            .catch(() => {
                setHostingState("failed");
            });
    }, [open, isHiderRole, $code, $mp, $transportStatus, hostingState]);

    const seekers = $participants.filter(
        (p) => p.online && p.role === "seeker",
    );
    const hider = $participants.find(
        (p) => p.online && p.role === "hider",
    );
    const coHiders = $participants.filter(
        (p) => p.online && p.role === "coHider",
    );
    const hiders = [...(hider ? [hider] : []), ...coHiders];
    // Require a real room with at least one seeker AND one hider.
    // Solo "single device" play is not allowed — the wizard now
    // always auto-creates a multiplayer room on finish, so the only
    // way to be without $mp is an autohost network failure, which
    // shouldn't let the player start either.
    // Require a real room with at least one seeker AND one hider.
    // Solo "single device" play is not allowed — the wizard always
    // auto-creates a multiplayer room on finish, so the only way to
    // be without $mp is an autohost network failure, which shouldn't
    // let the player start either.
    const hasRoleBalance =
        $mp && seekers.length >= 1 && hiders.length >= 1;

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

    // Start gates on role balance + host status only — NOT on the
    // boundary load. The Overpass fetch for a big play area can
    // take 30-90 seconds in the wild, and blocking the social
    // setup (invite, share, "go go go") on it makes the host wait
    // around for nothing. The clock kicks off the moment Start is
    // pressed; the map keeps streaming in the background and lights
    // up under the dismissed celebration. Seekers can't ask
    // questions until the boundary is in (the MapLoadingOverlay
    // covers it), but the hiding-period clock is ticking — which
    // is what the host actually wants when they press Start.
    //
    // Role-independent: a hider host can start the same way a
    // seeker host can. The seeker-page boundary stream is for
    // seeker GAMEPLAY, not for the clock kickoff, so there's no
    // technical reason to bounce a hider host to /. The hiding
    // period countdown is identical on both routes.
    const canStart =
        hasRoleBalance && isHost && $playerRole !== null;
    // Tighter version that additionally requires the boundary
    // to be in for seeker hosts. Hider hosts skip the map-load
    // requirement because they have no boundary stream of their
    // own — they only ever gate on player count. The Start
    // button cycles through two animated disabled labels in
    // priority order ('Loading map…', 'Waiting for players…')
    // and only goes live when startReady is true.
    const startReady = canStart && (isHiderRole || mapReady);

    const minutes =
        $pending && $pending > 0
            ? $pending
            : HIDING_PERIOD_MINUTES[$size];

    const shareUrl = useMemo(() => {
        if (!$code || typeof window === "undefined") return "";
        return `${window.location.origin}/?join=${$code}`;
    }, [$code]);

    const [copied, setCopied] = useState(false);
    const [qrOpen, setQrOpen] = useState(false);
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
            onOpenChange={(o) => {
                // Pre-game the lobby is non-dismissible (forward path
                // is Start / Leave). Once the game is running we
                // entered via the manual reopen flag, so closing
                // simply clears that flag and drops the user back to
                // the live map.
                if (!o && $manualOpen) {
                    lobbyManualOpen.set(false);
                }
            }}
        >
            <DialogContent
                closeIcon={$manualOpen}
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col p-0 gap-0 sm:max-w-md",
                )}
            >
                {/* Minimal header — brand mark + wordmark on the
                    left, notifications icon button top-right. The
                    role chip and room-code chip both moved out:
                    role is carried by the roster icons, and the room
                    code lives in the share section below. A text
                    recap only appears while the map is still loading
                    — once the boundary is in, the mini-map below
                    carries the settings visually. */}
                <div className="px-5 pt-4 pb-3 shrink-0 border-b border-border">
                    <div className="flex items-center gap-2">
                        <HideSeekMark size={26} onDark />
                        <HideSeekWordmark />
                        <div className="ml-auto">
                            <NotificationsIconButton />
                        </div>
                    </div>
                    {$playArea && !mapReady && !isHiderRole && (
                        <div className="mt-2 text-xs text-muted-foreground leading-snug">
                            <span className="font-semibold text-white">
                                {$playArea.displayName.split(",")[0]}
                            </span>
                            <span className="text-muted-foreground/60">
                                {" · "}
                            </span>
                            {minutes}-min hide
                            {$allowedTransit.length > 0 && (
                                <>
                                    <span className="text-muted-foreground/60">
                                        {" · "}
                                    </span>
                                    {$allowedTransit
                                        .map((m) => TRANSIT_LABELS[m])
                                        .join(", ")}
                                </>
                            )}
                        </div>
                    )}
                </div>

                <div className="px-5 py-3 flex-1 overflow-y-auto space-y-3">
                    {/* For accessibility — visually hidden but read
                        out by screen readers. Replaces the deleted
                        on-screen 'Ready to play' title. */}
                    <DialogTitle className="sr-only">
                        Game lobby
                    </DialogTitle>

                    {/* Autohost status — only visible until we have
                        a room code. */}
                    {!$code && hostingState === "creating" && (
                        <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 flex items-center gap-2.5">
                            <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
                            <div className="text-xs">
                                Creating game room…
                            </div>
                        </div>
                    )}
                    {!$code && hostingState === "failed" && (
                        <div className="rounded-md border-2 border-destructive/60 bg-destructive/5 px-3 py-2 space-y-1.5">
                            <div className="text-xs font-medium text-destructive">
                                Couldn't create a game room.
                            </div>
                            <div className="text-[11px] text-muted-foreground leading-snug">
                                Check your connection — without a
                                room there's no way to invite players
                                or start the game.
                            </div>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setHostingState("idle")}
                                className="w-full"
                            >
                                Retry
                            </Button>
                        </div>
                    )}

                    {/* Share / room code row (v147): single-row
                        layout — eyebrow label + code on the left,
                        Copy / Share / QR icon on the right. The
                        inline QR image moved into a nested dialog
                        the QR icon opens (same pattern as the
                        pre-v99 detour, but smaller surface here
                        and the dialog QR is much bigger for easier
                        scanning across a room). "Copy link"
                        shortened to "Copy" since the row needs to
                        fit in the lobby's narrow width. */}
                    {$mp && $code && (
                        <div
                            className={cn(
                                "rounded-md border border-border bg-secondary/40",
                                "px-3 py-2 flex items-center gap-2",
                            )}
                        >
                            <div className="flex flex-col min-w-0 leading-none">
                                <span className="text-[9px] uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground">
                                    Room code
                                </span>
                                <span className="font-display font-black uppercase text-lg tabular-nums tracking-[0.08em] text-primary mt-0.5">
                                    {$code}
                                </span>
                            </div>
                            {/* Icon-only buttons keep the row narrow
                                enough to coexist with the room code
                                + label even on the dialog's tighter
                                width. Tooltips carry the verb. */}
                            <div className="ml-auto flex items-center gap-1.5">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={handleCopy}
                                    aria-label="Copy invite link"
                                    title={
                                        copied
                                            ? "Copied!"
                                            : "Copy invite link"
                                    }
                                    className="px-2"
                                >
                                    {copied ? (
                                        <Check className="w-3.5 h-3.5" />
                                    ) : (
                                        <Copy className="w-3.5 h-3.5" />
                                    )}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleShare}
                                    aria-label="Share invite link"
                                    title="Share invite link"
                                    className="px-2"
                                >
                                    <Share2 className="w-3.5 h-3.5" />
                                </Button>
                                {shareUrl && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setQrOpen(true)}
                                        aria-label="Show large QR code"
                                        title="Show large QR code"
                                        className="px-2"
                                    >
                                        <QrCode className="w-3.5 h-3.5" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Large QR for cross-room scanning, opened by
                        the QR icon button above. The lobby keeps the
                        row compact; this is the "lean in to scan"
                        affordance. */}
                    {$mp && $code && shareUrl && (
                        <Dialog open={qrOpen} onOpenChange={setQrOpen}>
                            <DialogContent
                                className={cn(
                                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                                    "sm:max-w-xs flex flex-col items-center p-6 gap-4",
                                )}
                            >
                                <DialogTitle className="font-display font-black uppercase text-base tracking-[0.10em]">
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
                                    <div className="text-[10px] uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground">
                                        Room code
                                    </div>
                                    <div className="font-display font-black uppercase text-2xl tabular-nums tracking-[0.10em] text-primary mt-1">
                                        {$code}
                                    </div>
                                </div>
                            </DialogContent>
                        </Dialog>
                    )}

                    {/* Map slot. NEW ORDER (v146): the map sits in
                        the middle of the body, between the sharing
                        card above and the player rosters below.
                        Full-width — the previous max-w-[260px] +
                        mx-auto kept it as a stamp-sized thumbnail;
                        with the map now centerpiece of the lobby,
                        let it stretch the dialog's content width
                        (still aspect-square for predictable
                        reflow). */}
                    {$playArea && (
                        <div className="aspect-square w-full rounded-md overflow-hidden border border-border bg-secondary/40 relative">
                            {isHiderRole ? (
                                <LobbyMiniMap
                                    boundary={null}
                                    areaName={
                                        $playArea.displayName.split(
                                            ",",
                                        )[0]
                                    }
                                    minutes={minutes}
                                    transits={$allowedTransit}
                                    centerFallback={{
                                        lat: $playArea.lat,
                                        lng: $playArea.lng,
                                    }}
                                />
                            ) : mapReady ? (
                                <LobbyMiniMap
                                    boundary={
                                        $mapGeoJSON || $polyGeoJSON
                                    }
                                    areaName={
                                        $playArea.displayName.split(
                                            ",",
                                        )[0]
                                    }
                                    minutes={minutes}
                                    transits={$allowedTransit}
                                />
                            ) : (
                                <div className="absolute inset-0 flex flex-col px-3 py-2.5 gap-2 overflow-hidden">
                                    <div className="flex items-center gap-2">
                                        <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
                                        <div className="text-xs truncate flex-1">
                                            {$loading?.phase ??
                                                "Fetching boundary…"}
                                        </div>
                                    </div>
                                    {$pieces.length > 0 && (
                                        <ul className="flex flex-col gap-0.5 overflow-y-auto pt-1 border-t border-border/50 flex-1 min-h-0">
                                            {$pieces.map((p) => (
                                                <li
                                                    key={p.id}
                                                    className="flex items-center justify-between gap-2 text-[11px]"
                                                >
                                                    <span className="flex items-center gap-1.5 min-w-0">
                                                        <PieceIcon
                                                            state={p.state}
                                                        />
                                                        <span
                                                            className={cn(
                                                                "truncate",
                                                                p.state ===
                                                                    "done" &&
                                                                    "text-muted-foreground line-through decoration-muted-foreground/40",
                                                                p.state ===
                                                                    "failed" &&
                                                                    "text-destructive",
                                                            )}
                                                        >
                                                            {p.label}
                                                        </span>
                                                    </span>
                                                    <span className="tabular-nums text-muted-foreground shrink-0">
                                                        {pieceStatusLabel(p)}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Players moved here (below the map) in v146.
                        The map is the visual centrepiece; rosters
                        are secondary context. */}
                    {$mp && $participants.length > 0 && (
                        <div className="grid grid-cols-2 gap-2">
                            <RosterCard
                                label={`Seekers · ${seekers.length}`}
                                tone="seeker"
                                participants={seekers}
                                selfId={$self}
                                hostId={hostId}
                                selfRole={$playerRole}
                                onSwitchRole={() =>
                                    rolePickerOpen.set(true)
                                }
                            />
                            <RosterCard
                                label={`Hiders · ${(hider ? 1 : 0) + coHiders.length}`}
                                tone="hider"
                                participants={[
                                    ...(hider ? [hider] : []),
                                    ...coHiders,
                                ]}
                                mainHiderId={hider?.id ?? null}
                                selfId={$self}
                                hostId={hostId}
                                selfRole={$playerRole}
                                onSwitchRole={() =>
                                    rolePickerOpen.set(true)
                                }
                                showPromote={
                                    $playerRole === "hider" &&
                                    !!hider &&
                                    hider.id === $self
                                }
                                onPromote={(id) => promoteCoHider(id)}
                            />
                        </div>
                    )}
                    {$mp && !hasRoleBalance && $participants.length > 0 && !isMidGame && (
                        <p className="text-[11px] text-muted-foreground leading-snug">
                            Need at least one <b>seeker</b> and one{" "}
                            <b>hider</b> before the game can start.
                            Share the invite to bring more in.
                        </p>
                    )}

                    {/* Mid-game info section — shown only when
                        manually reopened during an active game. */}
                    {isMidGame && (
                        <MidGameInfoSection
                            hidingActive={midGameHidingActive}
                            remainingMs={midGameRemainingMs}
                            elapsedMs={midGameElapsedMs}
                            playArea={$playArea}
                            transit={$allowedTransit}
                            size={$size}
                            isHiderRole={isHiderRole}
                            mp={$mp}
                            sharing={$seekerSharing}
                            foundAt={$foundAt}
                            onEditSettings={() => {
                                lobbyManualOpen.set(false);
                                setupDialogOpen.set(true);
                            }}
                            onToggleSharing={() =>
                                seekerLocationSharing.set(!$seekerSharing)
                            }
                        />
                    )}
                </div>

                {/* Footer — Start/Leave for pre-game; Close/Leave for
                    mid-game manual reopen. */}
                <div className="px-6 pt-3 pb-6 border-t border-border space-y-2">
                    {isMidGame ? (
                        <>
                            <Button
                                size="lg"
                                className="w-full"
                                onClick={() => lobbyManualOpen.set(false)}
                            >
                                Close
                            </Button>
                            {$mp && $code && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={async () => {
                                        const ok = await appConfirm({
                                            title: "Leave this online game?",
                                            description:
                                                "You'll exit the room — the others can keep playing without you.",
                                            confirmLabel: "Leave game",
                                            destructive: true,
                                        });
                                        if (!ok) return;
                                        returnToLandingPage();
                                    }}
                                    className="w-full gap-1.5 text-muted-foreground"
                                >
                                    <LogOut className="w-3.5 h-3.5" />
                                    Leave game
                                </Button>
                            )}
                        </>
                    ) : isHost ? (
                        <>
                            <Button
                                size="lg"
                                className={cn(
                                    "w-full flex flex-col items-center justify-center gap-0.5",
                                    "font-display uppercase",
                                    startReady ? "h-16" : "h-11",
                                )}
                                onClick={handleStartGame}
                                disabled={!startReady}
                            >
                                <span
                                    className="text-base font-extrabold leading-none"
                                    style={{ letterSpacing: "0.02em" }}
                                >
                                    {!isHiderRole && !mapReady ? (
                                        <>
                                            Loading map
                                            <AnimatedEllipsis />
                                        </>
                                    ) : !hasRoleBalance ? (
                                        <>
                                            Waiting for players
                                            <AnimatedEllipsis />
                                        </>
                                    ) : (
                                        "Start game"
                                    )}
                                </span>
                                {startReady && (
                                    <span
                                        className="text-[10px] font-semibold opacity-80 leading-none mt-1"
                                        style={{ letterSpacing: "0.14em" }}
                                    >
                                        {minutes}-min hiding period
                                    </span>
                                )}
                            </Button>
                            {isHiderRole && startReady && (
                                <p className="text-[11px] text-muted-foreground leading-snug text-center">
                                    Pick your hiding spot in the meantime.
                                </p>
                            )}
                        </>
                    ) : (
                        <div className="text-center py-3 space-y-1">
                            <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
                            <div className="text-sm text-current/80">
                                Waiting for the host to start the game…
                            </div>
                            {isHiderRole && (
                                <div className="text-xs text-muted-foreground">
                                    Pick your hiding spot in the meantime.
                                </div>
                            )}
                        </div>
                    )}
                    {/* Switch role moved inline into the roster row
                        next to '(you)' — see RosterCard's SwitchRoleButton.
                        Keeps the lobby's footer clean and the affordance
                        co-located with the user's own name. */}
                    {!isMidGame && $mp && $code && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                                const ok = await appConfirm({
                                    title: "Leave this online game?",
                                    description:
                                        "You'll exit the room — the others can keep playing without you.",
                                    confirmLabel: "Leave game",
                                    destructive: true,
                                });
                                if (!ok) return;
                                returnToLandingPage();
                            }}
                            className="w-full gap-1.5 text-muted-foreground"
                        >
                            <LogOut className="w-3.5 h-3.5" />
                            Leave game
                        </Button>
                    )}
                </div>
            </DialogContent>

            {/* QR-only nested dialog deleted in v99 — the QR
                now lives inline in the room-code card so opening
                a sub-dialog to see it would be a regression. */}
        </Dialog>
    );
}

/** Mini play-area preview shown in the lobby once the boundary
 *  is loaded. The map itself is the home for the rest of the
 *  game settings (location name top-left, hide-duration top-
 *  right, transit chips along the bottom) — replaces the
 *  separate text recap above. Non-interactive: dragging /
 *  zooming would only confuse the lobby state. */
function LobbyMiniMap({
    boundary,
    areaName,
    minutes,
    transits,
    centerFallback,
}: {
    boundary: GeoJSON.FeatureCollection | null;
    areaName: string;
    minutes: number;
    transits: import("@/lib/gameSetup").TransitMode[];
    /** Used when the boundary isn't loaded (e.g. hider's device).
     *  Shows the map centered on the play area's coordinates. */
    centerFallback?: { lat: number; lng: number };
}) {
    // v228: follow the OS / app theme — dark filter on in dark mode,
    // off in light mode.
    const $theme = useStore(resolvedTheme);
    const darkTiles = $theme === "dark";
    // v241: rebuild style when the resolved PMTiles URL flips.
    const $pmtilesUrl = useStore(pmtilesUrl);
    const mapStyle = useMemo(
        () => protomapsMapLibreStyle(darkTiles ? "dark" : "light"),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [darkTiles, $pmtilesUrl],
    );
    const bounds = useMemo(() => {
        if (!boundary || !boundary.features?.length) return null;
        try {
            const b = bbox(boundary);
            // bbox returns [minLng, minLat, maxLng, maxLat]. Pad
            // a few percent so the polygon outline isn't pressed
            // against the edges.
            const padLng = (b[2] - b[0]) * 0.08;
            const padLat = (b[3] - b[1]) * 0.08;
            return {
                minLng: b[0] - padLng,
                minLat: b[1] - padLat,
                maxLng: b[2] + padLng,
                maxLat: b[3] + padLat,
            };
        } catch {
            return null;
        }
    }, [boundary]);

    const hasBounds = bounds !== null;
    const hasFallback = centerFallback !== undefined;
    if (!hasBounds && !hasFallback) return null;

    return (
        // No outer wrapper — the parent map-slot already provides
        // fixed-size, border, rounded, overflow. We just fill it.
        <div className="absolute inset-0">
            {(hasBounds || hasFallback) && (
                <MapGL
                    initialViewState={
                        hasBounds
                            ? {
                                  bounds: [
                                      [bounds!.minLng, bounds!.minLat],
                                      [bounds!.maxLng, bounds!.maxLat],
                                  ],
                                  fitBoundsOptions: { padding: 8 },
                              }
                            : {
                                  longitude: centerFallback!.lng,
                                  latitude: centerFallback!.lat,
                                  zoom: 10,
                              }
                    }
                    style={{ width: "100%", height: "100%" }}
                    interactive={false}
                    attributionControl={false}
                    dragRotate={false}
                    pitchWithRotate={false}
                    mapStyle={mapStyle}
                    onError={handleMapLibreError}
                >
                    {boundary && (
                        <Source
                            id="lobby-boundary"
                            type="geojson"
                            data={boundary}
                        >
                            <Layer
                                id="lobby-boundary-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(2, 70%, 54%)",
                                    "fill-opacity": 0.14,
                                }}
                            />
                            <Layer
                                id="lobby-boundary-line"
                                type="line"
                                paint={{
                                    "line-color": "hsl(2, 70%, 54%)",
                                    "line-width": 2,
                                    "line-opacity": 0.9,
                                }}
                            />
                        </Source>
                    )}
                </MapGL>
            )}
            {/* Setting chips, overlaid on the map. Each pill has
                its own translucent dark background so it stays
                legible regardless of what tiles are under it. */}
            <div className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-[3px] bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] uppercase tracking-[0.10em] font-display font-extrabold text-white leading-none">
                <MapPin className="w-2.5 h-2.5 shrink-0" />
                <span className="truncate max-w-[140px]">
                    {areaName}
                </span>
            </div>
            <div className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-[3px] bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] uppercase tracking-[0.10em] font-display font-extrabold text-white leading-none">
                <Clock className="w-2.5 h-2.5 shrink-0" />
                <span>{minutes}-min hide</span>
            </div>
            {transits.length > 0 && (
                <div className="absolute bottom-1.5 left-1.5 right-1.5 flex flex-wrap gap-1">
                    {transits.map((m) => (
                        <span
                            key={m}
                            className="rounded-[3px] bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] uppercase tracking-[0.10em] font-display font-extrabold text-white leading-none"
                        >
                            {TRANSIT_LABELS[m]}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Three-dot ellipsis with a left-to-right fade animation. Used
 *  in disabled Start-button labels so 'Loading map…' /
 *  'Waiting for players…' read as active-but-waiting rather
 *  than 'stuck'. CSS lives in globals.css under .animated-ellipsis. */
function AnimatedEllipsis() {
    return (
        <span className="animated-ellipsis inline-block ml-0.5">
            <span>.</span>
            <span>.</span>
            <span>.</span>
        </span>
    );
}

function PieceIcon({
    state,
}: {
    state: "waiting" | "streaming" | "done" | "failed";
}) {
    if (state === "done")
        return <Check className="w-3 h-3 text-primary shrink-0" />;
    if (state === "failed")
        return <X className="w-3 h-3 text-destructive shrink-0" />;
    if (state === "streaming")
        return (
            <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
        );
    return (
        <span className="w-3 h-3 rounded-full border border-muted-foreground/40 shrink-0" />
    );
}

function pieceStatusLabel(p: {
    state: "waiting" | "streaming" | "done" | "failed";
    downloaded: number;
    total: number | null;
}): string {
    if (p.state === "waiting") return "queued";
    if (p.state === "failed") return "failed";
    if (p.state === "done") {
        return p.downloaded > 0 ? formatBytes(p.downloaded) : "done";
    }
    if (p.downloaded <= 0) return "starting…";
    if (p.total !== null && p.total > 0) {
        return `${formatBytes(p.downloaded)} / ~${formatBytes(p.total)}`;
    }
    return formatBytes(p.downloaded);
}

function RosterCard({
    label,
    tone,
    participants: rows,
    selfId,
    hostId,
    mainHiderId,
    selfRole,
    onSwitchRole,
    showPromote = false,
    onPromote,
}: {
    label: string;
    tone: "seeker" | "hider";
    participants: {
        id: string;
        displayName: string;
        role: "seeker" | "hider" | "coHider" | null;
        online: boolean;
    }[];
    selfId: string | null;
    hostId: string | null;
    /** When set, the row matching this id wears the MAIN badge. */
    mainHiderId?: string | null;
    /** The local player's current role — used by the inline
     *  switch-role affordance to decide what the button means
     *  (only shown on the row that IS the local player). */
    selfRole?: "seeker" | "hider" | "coHider" | null;
    /** Open the role picker. Wired so the switch-role button can
     *  live inline next to the local player's own name. */
    onSwitchRole?: () => void;
    /** Show a "Promote" button next to co-hiders (gated on the
     *  caller already confirming the local player can act). */
    showPromote?: boolean;
    onPromote?: (id: string) => void;
}) {
    // Identity is carried by icon + (for hiders) a subtle dim,
    // not a brand-coloured dot — the role colors were colliding
    // with the question-category palette downstream. Seeker gets
    // footprints (tracking the hider's trail through transit
    // stations — the original Search/magnifying glass read as a
    // generic "search field" icon, too confusing); hider gets a
    // venetian half-mask, dimmer to read as 'in the shadows'.
    const RoleIcon = tone === "seeker" ? Footprints : VenetianMask;
    const cardCls =
        tone === "seeker"
            ? "bg-secondary/40 border-border"
            : "bg-secondary/20 border-border/70";
    const iconCls =
        tone === "seeker"
            ? "text-muted-foreground"
            : "text-muted-foreground/60";
    return (
        <div
            className={cn(
                "rounded-md border px-3 py-2 space-y-1.5",
                cardCls,
            )}
        >
            <div className="flex items-center gap-1.5">
                <RoleIcon
                    className={cn("w-3.5 h-3.5 shrink-0", iconCls)}
                    aria-hidden
                />
                <span
                    className={cn(
                        "text-[10px] uppercase tracking-[0.12em] font-display font-extrabold",
                        tone === "seeker"
                            ? "text-muted-foreground"
                            : "text-muted-foreground/80",
                    )}
                >
                    {label}
                </span>
            </div>
            {rows.length === 0 ? (
                <div className="text-[11px] text-muted-foreground italic leading-snug pl-3.5">
                    {tone === "seeker"
                        ? "No seekers yet."
                        : "No hiders yet — the seat is open."}
                </div>
            ) : (
                <ul className="space-y-1 pl-3.5">
                    {rows.map((p) => {
                        const isMe = p.id === selfId;
                        const isHost = p.id === hostId;
                        const isMain =
                            mainHiderId !== undefined &&
                            mainHiderId === p.id;
                        const isCoHider = p.role === "coHider";
                        return (
                            <li
                                key={p.id}
                                className="flex items-center gap-2 text-sm"
                            >
                                <span
                                    className={cn(
                                        "flex-1 truncate flex items-center gap-1.5",
                                        !p.online && "opacity-50",
                                    )}
                                >
                                    <span>
                                        {p.displayName || "Anonymous"}
                                    </span>
                                    {isMain && (
                                        <span
                                            className={cn(
                                                "text-[9px] font-display font-extrabold uppercase tracking-[0.10em]",
                                                "rounded-[3px] px-1 py-[1px] leading-none",
                                                "bg-[hsl(var(--accent-yellow))] text-[hsl(var(--sidebar-background))]",
                                            )}
                                            title="Main hider — answers questions and plays the deck."
                                        >
                                            MAIN
                                        </span>
                                    )}
                                    {isHost && (
                                        <span className="text-[10px] uppercase tracking-[0.10em] font-display font-extrabold text-muted-foreground">
                                            Host
                                        </span>
                                    )}
                                    {isMe && (
                                        <span className="text-xs text-muted-foreground">
                                            (you)
                                        </span>
                                    )}
                                    {/* Inline switch-role affordance.
                                        Only on the local player's
                                        row. The label hints the
                                        destination team, the arrow
                                        sells it as 'jump across'. */}
                                    {isMe &&
                                        onSwitchRole &&
                                        (() => {
                                            const goingToHider =
                                                selfRole === "seeker";
                                            const DestIcon = goingToHider
                                                ? VenetianMask
                                                : Footprints;
                                            const destLabel = goingToHider
                                                ? "Hiders"
                                                : "Seekers";
                                            return (
                                                <button
                                                    type="button"
                                                    onClick={onSwitchRole}
                                                    className={cn(
                                                        "ml-1 inline-flex items-center gap-1 rounded-[3px]",
                                                        "px-1.5 py-[1px] text-[10px] uppercase tracking-[0.1em]",
                                                        "font-display font-extrabold leading-none",
                                                        "text-muted-foreground hover:text-white",
                                                        "border border-border/60 hover:border-border",
                                                        "transition-colors",
                                                    )}
                                                    title={`Switch to ${destLabel}`}
                                                >
                                                    <ArrowRight className="w-2.5 h-2.5" />
                                                    <DestIcon className="w-2.5 h-2.5" />
                                                </button>
                                            );
                                        })()}
                                </span>
                                {showPromote &&
                                    isCoHider &&
                                    p.online &&
                                    onPromote && (
                                        <button
                                            type="button"
                                            onClick={() => onPromote(p.id)}
                                            className={cn(
                                                "text-[10px] uppercase tracking-[0.08em] font-display font-extrabold",
                                                "rounded-[3px] px-2 py-1 leading-none",
                                                "bg-[hsl(var(--accent-yellow)/0.15)] text-[hsl(var(--accent-yellow))]",
                                                "border border-[hsl(var(--accent-yellow))/0.4]",
                                                "hover:bg-[hsl(var(--accent-yellow)/0.25)]",
                                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--accent-yellow))]",
                                            )}
                                            title="Promote to main hider (you become a co-hider)"
                                        >
                                            Promote
                                        </button>
                                    )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

const TRANSIT_ICONS: Record<TransitMode, React.ComponentType<{ className?: string }>> = {
    bus: Bus,
    tram: TramFront,
    train: Train,
    subway: TrainTrack,
    ferry: Ship,
};

function MidGameInfoSection({
    hidingActive,
    remainingMs,
    elapsedMs,
    playArea,
    transit,
    size,
    isHiderRole,
    mp,
    sharing,
    foundAt,
    onEditSettings,
    onToggleSharing,
}: {
    hidingActive: boolean;
    remainingMs: number;
    elapsedMs: number;
    playArea: { displayName: string } | null;
    transit: TransitMode[];
    size: import("@/lib/gameSetup").GameSize;
    isHiderRole: boolean;
    mp: boolean;
    sharing: boolean;
    foundAt: number | null;
    onEditSettings: () => void;
    onToggleSharing: () => void;
}) {
    return (
        <div className="border-t border-border pt-3 space-y-3">
            {/* Timer status */}
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2.5 flex items-center gap-3">
                <Timer
                    className={cn(
                        "w-4 h-4 shrink-0",
                        hidingActive ? "text-primary" : "text-muted-foreground",
                    )}
                />
                <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                        {foundAt !== null
                            ? "Round over"
                            : hidingActive
                              ? "Hiding period"
                              : "Seeking"}
                    </div>
                    <div
                        className={cn(
                            "font-poppins font-black tabular-nums text-2xl leading-none",
                            hidingActive ? "text-primary" : "text-foreground",
                        )}
                    >
                        {formatTimeRemaining(
                            hidingActive ? remainingMs : elapsedMs,
                        )}
                    </div>
                </div>
            </div>

            {/* Play area + transit + size */}
            {playArea && (
                <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground shrink-0">
                            Play area
                        </span>
                        <span className="font-medium truncate min-w-0 text-right">
                            {(() => {
                                const parts = playArea.displayName
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean);
                                if (parts.length <= 1) return playArea.displayName;
                                return `${parts[0]}, ${parts[parts.length - 1]}`;
                            })()}
                        </span>
                    </div>
                    <div className="flex justify-between items-center gap-2">
                        <span className="text-muted-foreground shrink-0">
                            Size
                        </span>
                        <SizeBadge size={size} />
                    </div>
                    <div className="flex justify-between items-start gap-2">
                        <span className="text-muted-foreground shrink-0 pt-1">
                            Transit
                        </span>
                        <span className="flex flex-wrap gap-1 justify-end min-w-0">
                            {transit.length === 0 ? (
                                <span className="text-xs text-muted-foreground italic">
                                    Walking only
                                </span>
                            ) : (
                                transit.map((m) => {
                                    const Icon = TRANSIT_ICONS[m];
                                    return (
                                        <span
                                            key={m}
                                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-secondary border border-border text-xs"
                                        >
                                            <Icon className="w-3 h-3" />
                                            <span>{TRANSIT_LABELS[m]}</span>
                                        </span>
                                    );
                                })
                            )}
                        </span>
                    </div>
                </div>
            )}

            {/* GPS sharing toggle (seeker only, multiplayer, not found) */}
            {!isHiderRole && mp && foundAt === null && (
                <button
                    type="button"
                    onClick={onToggleSharing}
                    className={cn(
                        "w-full flex items-center gap-2.5",
                        "rounded-md border-2 px-3 py-2.5 text-left transition-colors",
                        sharing
                            ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-300"
                            : "border-border bg-secondary/40 text-muted-foreground",
                    )}
                >
                    {sharing ? (
                        <Radio className="w-4 h-4 shrink-0 text-emerald-400" />
                    ) : (
                        <RadioReceiver className="w-4 h-4 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="text-[9px] uppercase tracking-[0.18em] font-poppins font-bold">
                            {sharing ? "Sharing GPS with hider" : "GPS sharing off"}
                        </div>
                        <div className="text-[11px] leading-snug text-muted-foreground">
                            {sharing
                                ? "The hider sees your live position. Tap to pause."
                                : "Tap to resume sharing your position."}
                        </div>
                    </div>
                </button>
            )}

            {/* Preload choices (seeker only) */}
            {!isHiderRole && (
                <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground mb-2">
                        Preload during hiding
                    </div>
                    <PreloadChoicesPanel runImmediatelyOnEnable />
                </div>
            )}

            {/* Edit settings */}
            {!isHiderRole && (
                <button
                    type="button"
                    onClick={onEditSettings}
                    className={cn(
                        "w-full flex items-center justify-center gap-2",
                        "px-3 py-2 rounded-md border border-border",
                        "bg-secondary/40 hover:bg-secondary/70 transition-colors",
                        "text-sm font-semibold text-foreground",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <Settings className="w-4 h-4" />
                    Edit game settings
                </button>
            )}
        </div>
    );
}

export default GameLobbyDialog;
