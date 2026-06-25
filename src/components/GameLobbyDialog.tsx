import { useStore } from "@nanostores/react";
import {
    Check,
    ChevronDown,
    Copy,
    Footprints,
    Loader2,
    LogOut,
    Pencil,
    Plus,
    QrCode,
    Radio,
    RadioReceiver,
    Share2,
    VenetianMask,
    X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { Drawer as VaulDrawer } from "vaul";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { appConfirm } from "@/lib/confirm";
import { mapGeoLocation } from "@/lib/context";
import {
    allowedTransit,
    type GameSize,
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    pendingHidingDurationMin,
    playArea,
    preloadChoices,
    setupCompleted,
    setupDialogOpen,
    TRANSIT_ICONS,
    TRANSIT_LABELS,
    type TransitMode,
    welcomeSeen,
} from "@/lib/gameSetup";
import {
    playerRole,
    roundFoundAt,
    roundLog,
} from "@/lib/hiderRole";
import {
    currentGameCode,
    displayName as displayNameAtom,
    localIsHost,
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
    setOnlineRole,
} from "@/lib/multiplayer/store";
import { preloadDuringHidingPeriod } from "@/lib/preload";
import { returnToLandingPage } from "@/lib/roundActions";
import { cn } from "@/lib/utils";

import { SizeBadge } from "./JetLagLogo";
import { PlayAreaPreviewMap } from "./PlayAreaPreviewMap";
import { RoundEndSection } from "./RoundEndSection";

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
    const $localIsHost = useStore(localIsHost);
    const $mp = useStore(multiplayerEnabled);
    const $transportStatus = useStore(transportStatus);
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $pending = useStore(pendingHidingDurationMin);
    const $size = useStore(gameSize);
    const $manualOpen = useStore(lobbyManualOpen);
    const $foundAt = useStore(roundFoundAt);
    const $seekerSharing = useStore(seekerLocationSharing);
    // v442: the setup/area editor is a Radix Dialog that would otherwise
    // open BEHIND this drawer (the drawer content sits at z-[1055], above
    // the dialog's z-[1050]). So whenever the editor is open we close the
    // lobby; it auto-reopens when the editor closes. This is what makes
    // the map's "Edit" button actually reach the play-area picker.
    const $setupOpen = useStore(setupDialogOpen);

    // Two open paths:
    //   1. Auto-open pre-game: standard wizard → lobby → start flow.
    //   2. Manual reopen mid-game: a player taps the "Lobby" button
    //      from the seeker's bottom-nav or the hider's home toolbar
    //      to revisit the roster, re-share the join code, or rotate
    //      roles. The manual flag wins regardless of $hidingEndsAt.
    // v447: no longer gated on a role being picked — the lobby is now
    // where the host (and anyone role-less) picks their team via the
    // roster zero-state, so it must render with $playerRole === null.
    const open =
        !$setupOpen &&
        ($manualOpen ||
            ($welcomeSeen && $setupCompleted && $hidingEndsAt === null));

    const isHiderRole =
        $playerRole === "hider" || $playerRole === "coHider";

    const isMidGame = $manualOpen && $hidingEndsAt !== null;

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
    // Settings-edit authority. Grant on EITHER signal: the roster
    // inference (earliest-joined participant is me) OR the device-local
    // "I hosted this room" flag. The flag is the robust fallback for
    // when a server-side reconnect/re-host mints a fresh participant id
    // for the host — `$self` then stops matching `hostId` and the real
    // host would otherwise lose editing entirely. See `localIsHost`.
    const isHost =
        !$mp || $localIsHost || hostId === null || hostId === $self;

    // Inline settings editing (host only). Writes the same atoms the
    // setup wizard's edit mode does and pushes to peers via the same
    // `hostPushSetup`, so a lobby tweak propagates exactly like a
    // "Save edits" would. Transit + size apply live with no hiding-
    // period restart, matching GameSetupDialog.handleSaveEdits.
    const commitTransit = (next: TransitMode[]) => {
        // Keep canonical mode order so the chip row + cache keys stay
        // stable regardless of click order.
        allowedTransit.set(ALL_TRANSIT_MODES.filter((m) => next.includes(m)));
        hostPushSetup();
    };
    const removeMode = (m: TransitMode) =>
        commitTransit($allowedTransit.filter((x) => x !== m));
    const addMode = (m: TransitMode) =>
        commitTransit([...$allowedTransit, m]);
    const addableModes = ALL_TRANSIT_MODES.filter(
        (m) => !$allowedTransit.includes(m),
    );
    const setSize = (s: GameSize) => {
        gameSize.set(s);
        hostPushSetup();
    };
    const openAreaEditor = () => {
        // Changing the play area needs the search + map picker, so it
        // opens the setup dialog focused on the area step (edit mode).
        lobbyManualOpen.set(false);
        setupDialogOpen.set(true);
    };

    // v447: pick / switch team from the lobby roster zero-state. Mirrors
    // Welcome.handlePickRole — sets the local role, pushes it to the
    // server (coHider is client-only), and routes hiders to /h, seekers
    // back to / if they were on the hider page.
    const joinTeam = (role: "seeker" | "hider" | "coHider") => {
        playerRole.set(role);
        if (role !== "coHider") setOnlineRole(role);
        if (typeof window === "undefined") return;
        const onHiderPage = window.location.pathname.startsWith("/h");
        if (role === "hider" || role === "coHider") {
            if (!onHiderPage) window.location.assign("/h");
        } else if (onHiderPage) {
            window.location.assign("/");
        }
    };

    // Preload (moved from the wizard, v444). On an unmetered link we just
    // preload silently; only a positively-metered link gets the opt-in
    // checkbox. `metered` is sampled once at mount.
    const $preload = useStore(preloadChoices);
    const [metered] = useState(() => isMeteredConnection());
    const preloadOn = $preload.map || $preload.references || $preload.transit;
    const setPreloadOn = (on: boolean) =>
        preloadChoices.set({ map: on, references: on, transit: on });
    useEffect(() => {
        if (isMidGame || metered) return;
        const c = preloadChoices.get();
        if (!(c.map && c.references && c.transit)) {
            preloadChoices.set({ map: true, references: true, transit: true });
        }
    }, [isMidGame, metered]);

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
    // v297: the seeker shell + main map no longer mount pre-game,
    // so the mapReady gate is gone. The host can start the moment
    // role balance + setup conditions are satisfied; the boundary
    // load happens during the hiding period (which is what the
    // preload kickoff covers).
    const startReady = canStart;

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
    // v455: the lobby is a MODAL vaul drawer (Radix Dialog under the
    // hood), so anything portaled to document.body — like the size /
    // add-transit Popovers — renders inert (pointer-events: none).
    // Portal those popovers into the drawer content instead, captured
    // here via a callback ref so they inherit pointer-events: auto and
    // their option clicks actually fire.
    const [drawerEl, setDrawerEl] = useState<HTMLElement | null>(null);
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

    const handleLeaveGame = async () => {
        const ok = await appConfirm({
            title: "Leave this online game?",
            description:
                "You'll exit the room — the others can keep playing without you.",
            confirmLabel: "Leave game",
            destructive: true,
        });
        if (!ok) return;
        returnToLandingPage();
    };

    // Eager preload during the roster-wait window. v272 first kicked
    // this off the moment the lobby opened, but for cold cities
    // (Uppsala, mid-size metros not in the prewarm list) the boundary
    // v297: dropped the mapReady gate now that the seeker shell
    // doesn't mount pre-game (so the boundary stream wouldn't fire
    // here at all). Preload kicks off as soon as the lobby is open
    // with a play area committed. Each bucket dedupes on in-flight
    // + warmed state internally, so re-fires on render are
    // harmless; the v295 boundary dedup keeps any Overpass overlap
    // from racing the preview map. Hiders preload too now — they
    // also benefit from a warm reference cache once they're on the
    // hider shell.
    useEffect(() => {
        if (!open || isMidGame || !$playArea) return;
        preloadDuringHidingPeriod();
    }, [open, isMidGame, $playArea]);

    if (!open) return null;

    return (
        <VaulDrawer.Root
            open={open}
            // Pre-game the lobby is non-dismissible (forward path is
            // Start / Leave); mid-game manual reopen is dismissible by
            // swipe / handle.
            dismissible={$manualOpen}
            onOpenChange={(o) => {
                if (!o && $manualOpen) {
                    lobbyManualOpen.set(false);
                }
            }}
            shouldScaleBackground={false}
        >
            <VaulDrawer.Portal>
                <VaulDrawer.Overlay className="fixed inset-0 z-[1050] bg-black/60" />
                <VaulDrawer.Content
                    ref={setDrawerEl}
                    className={cn(
                        "fixed inset-x-0 z-[1055] flex flex-col",
                        // v297: pre-game (no manual reopen, no hiding
                        // clock running) the lobby IS the page —
                        // there's no seeker/hider shell behind it
                        // anymore. Fill the screen instead of sliding
                        // up as a 90vh sheet. Mid-game manual reopens
                        // stay as the familiar bottom drawer.
                        isMidGame
                            ? "bottom-0 mt-24 h-auto max-h-[90vh] rounded-t-[10px] border"
                            : "inset-0 h-full pt-[env(safe-area-inset-top)]",
                        "bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
                        "pb-[env(safe-area-inset-bottom)] sm:max-w-md sm:mx-auto",
                    )}
                >
                    {$manualOpen && (
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted" />
                    )}
                {/* Minimal header — brand mark + wordmark on the
                    left, notifications icon button top-right. The
                    role chip and room-code chip both moved out:
                    role is carried by the roster icons, and the room
                    code lives in the share section below. A text
                    recap only appears while the map is still loading
                    — once the boundary is in, the mini-map below
                    carries the settings visually. */}
                {/* v296: title collapses the play area + size into
                    one line ("Medium game in Stockholm"); the
                    subheader carries the allowed transit. Edit
                    settings (host only) drops directly under the
                    subheader so the action sits where the eye
                    already is, rather than buried in the mid-game
                    info block further down. Leave button picks up
                    a "Leave" label so the destructive action is
                    spelled out rather than icon-only. */}
                {(() => {
                    const cityLabel =
                        $playArea?.displayName.split(",")[0]?.trim() ?? "";
                    return (
                        // v318: header gets a touch more vertical room
                        // (pt-5/pb-4) so the bigger title + the spaced
                        // transit pills breathe. Inside, content stacks
                        // with a wider gap.
                        <div className="px-5 pt-5 pb-4 shrink-0 border-b border-border space-y-2.5">
                            <div className="flex items-start gap-3">
                                <div className="flex-1 min-w-0 space-y-2">
                                    {/* v442: title is just the play area;
                                        the size pill sits under it. Transit
                                        chips are a full-width row below
                                        (outside this column) so they aren't
                                        clipped by the Leave button. */}
                                    <VaulDrawer.Title className="text-xl font-bold leading-tight tracking-tight truncate min-w-0">
                                        {cityLabel || "Lobby"}
                                    </VaulDrawer.Title>
                                    <VaulDrawer.Description className="sr-only">
                                        {$allowedTransit.length > 0
                                            ? `Allowed transit: ${$allowedTransit.map((m) => TRANSIT_LABELS[m]).join(", ")}`
                                            : "Walking only"}
                                    </VaulDrawer.Description>

                                    {/* Size pill — host taps to change. */}
                                    {cityLabel && (
                                        <div className="flex">
                                            {isHost ? (
                                                <Popover>
                                                    <PopoverTrigger asChild>
                                                        <button
                                                            type="button"
                                                            aria-label="Change game size"
                                                            className="inline-flex items-center gap-1 rounded-md pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                        >
                                                            <SizeBadge
                                                                size={$size}
                                                                className="text-sm px-2.5 py-1"
                                                            />
                                                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                                        </button>
                                                    </PopoverTrigger>
                                                    <PopoverContent
                                                        align="start"
                                                        container={drawerEl}
                                                        className="z-[1060] w-44 p-1"
                                                    >
                                                        {SIZE_OPTIONS.map(
                                                            (o) => (
                                                                <button
                                                                    key={o.value}
                                                                    type="button"
                                                                    onClick={() =>
                                                                        setSize(
                                                                            o.value,
                                                                        )
                                                                    }
                                                                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent transition-colors"
                                                                >
                                                                    <SizeBadge
                                                                        size={
                                                                            o.value
                                                                        }
                                                                    />
                                                                    <span className="flex-1">
                                                                        {o.label}
                                                                    </span>
                                                                    {o.value ===
                                                                        $size && (
                                                                        <Check className="w-4 h-4 text-primary" />
                                                                    )}
                                                                </button>
                                                            ),
                                                        )}
                                                    </PopoverContent>
                                                </Popover>
                                            ) : (
                                                <SizeBadge
                                                    size={$size}
                                                    className="text-sm px-2.5 py-1"
                                                />
                                            )}
                                        </div>
                                    )}
                                </div>
                                {/* v461: a single Share button in the
                                    header corner for quick access — the
                                    full room-code + Share/Copy/QR card
                                    still lives in the scroll body below.
                                    Uses the Web Share API, falling back
                                    to copying the invite link. */}
                                {$mp && $code && (
                                    <Button
                                        size="sm"
                                        onClick={handleShare}
                                        aria-label="Share invite link"
                                        title="Share invite link"
                                        className="shrink-0 gap-1.5"
                                    >
                                        <Share2 className="w-3.5 h-3.5" />
                                        Share
                                    </Button>
                                )}
                            </div>

                            {/* Transit chips — FULL-WIDTH row (own line, not
                                squeezed beside the Leave button). Runs the
                                width of the drawer and scrolls horizontally
                                if the chips overflow. Host: x to remove a
                                mode, + to add one. */}
                            <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto">
                                {$allowedTransit.length === 0 ? (
                                    <span className="text-xs text-muted-foreground italic">
                                        Walking only
                                    </span>
                                ) : (
                                    $allowedTransit.map((m) => {
                                        const Icon = TRANSIT_ICONS[m];
                                        return (
                                            <span
                                                key={m}
                                                className={cn(
                                                    "inline-flex shrink-0 items-center gap-1.5 py-1 rounded-sm bg-secondary border border-border text-xs",
                                                    isHost
                                                        ? "pl-2 pr-1"
                                                        : "px-2",
                                                )}
                                            >
                                                <Icon className="w-3.5 h-3.5" />
                                                <span>{TRANSIT_LABELS[m]}</span>
                                                {isHost && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            removeMode(m)
                                                        }
                                                        aria-label={`Remove ${TRANSIT_LABELS[m]}`}
                                                        className="ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:bg-background/70 hover:text-foreground transition-colors"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                )}
                                            </span>
                                        );
                                    })
                                )}
                                {isHost && addableModes.length > 0 && (
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <button
                                                type="button"
                                                aria-label="Add transit mode"
                                                className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-sm border border-dashed border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                <Plus className="w-4 h-4" />
                                            </button>
                                        </PopoverTrigger>
                                        <PopoverContent
                                            align="start"
                                            container={drawerEl}
                                            className="z-[1060] w-44 p-1"
                                        >
                                            {addableModes.map((m) => {
                                                const Icon = TRANSIT_ICONS[m];
                                                return (
                                                    <button
                                                        key={m}
                                                        type="button"
                                                        onClick={() => addMode(m)}
                                                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent transition-colors"
                                                    >
                                                        <Icon className="w-4 h-4" />
                                                        {TRANSIT_LABELS[m]}
                                                    </button>
                                                );
                                            })}
                                        </PopoverContent>
                                    </Popover>
                                )}
                            </div>
                        </div>
                    );
                })()}

                <div className="px-5 py-3 flex-1 overflow-y-auto space-y-3">
                    {/* Autohost failure recovery. The "creating" skeleton
                        and the room-code card both moved to the header's
                        compact share cluster (v453); only the failure
                        surface stays in the scroll body because it carries
                        its own retry button. */}
                    {!$code && hostingState === "failed" && (
                        <div className="rounded-md border-2 border-destructive/60 bg-destructive/5 px-3 py-2 space-y-1.5 min-h-[3.5rem] animate-in fade-in duration-200">
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


                    {/* Pre-game play-area map. Restored in v260; v275
                        moved BELOW the room-code card so the share
                        affordance is the first actionable thing in the
                        scroll area (per user feedback — getting friends
                        in is what the lobby is for). Deliberately NOT
                        shown mid-game.

                        v273: the 180-px slot is reserved unconditionally
                        so the content below doesn't jump when a guest's
                        host-pushed setup arrives a beat after the lobby
                        opens. When mapGeoLocation isn't valid yet, a
                        skeleton placeholder fills the same box. The
                        PlayAreaPreviewMap carries its own MapTilesVeil
                        once it does mount, so the visual handoff is
                        seamless. */}
                    {!isMidGame &&
                        (($mapGeoLocation?.properties?.osm_id ?? 0) > 0 ? (
                            <div className="relative">
                                <PlayAreaPreviewMap
                                    value={$mapGeoLocation!}
                                    height="h-[180px]"
                                />
                                {isHost && (
                                    <button
                                        type="button"
                                        onClick={openAreaEditor}
                                        aria-label="Change play area"
                                        title="Change the play area"
                                        className={cn(
                                            "absolute top-2 right-2 z-[5]",
                                            "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md",
                                            "bg-background/90 backdrop-blur-sm border border-border shadow-sm",
                                            "text-xs font-semibold text-foreground",
                                            "hover:bg-background transition-colors",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        )}
                                    >
                                        <Pencil className="w-3.5 h-3.5" />
                                        Edit
                                    </button>
                                )}
                            </div>
                        ) : (
                            <div
                                className="relative w-full h-[180px] rounded-md overflow-hidden border border-border bg-secondary/30 flex flex-col items-center justify-center gap-2 text-muted-foreground animate-in fade-in duration-200"
                                role="status"
                                aria-live="polite"
                                aria-label="Waiting for play area"
                            >
                                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                                <div className="text-xs">
                                    Waiting for the host's play area…
                                </div>
                            </div>
                        ))}

                    {/* Players roster + team zero-state. v447: each card
                        carries a "join this team" button (unless the
                        local player is already on it) so picking / switching
                        a role happens here instead of a popup. Hidden
                        mid-game (no role-swapping once the clock runs). */}
                    {$mp && ($participants.length > 0 || !isMidGame) && (
                        <div className="grid grid-cols-2 gap-2 animate-in fade-in duration-200">
                            <RosterCard
                                label={`Seekers · ${seekers.length}`}
                                tone="seeker"
                                participants={seekers}
                                selfId={$self}
                                hostId={hostId}
                                onJoin={
                                    !isMidGame && $playerRole !== "seeker"
                                        ? () => joinTeam("seeker")
                                        : undefined
                                }
                                joinLabel="Join seekers"
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
                                onJoin={(() => {
                                    if (isMidGame) return undefined;
                                    const seatOpen =
                                        !hider || hider.id === $self;
                                    if (seatOpen) {
                                        // No main hider yet (or it's me) →
                                        // take the seat. Already main hider
                                        // → no join button.
                                        return $playerRole === "hider"
                                            ? undefined
                                            : () => joinTeam("hider");
                                    }
                                    // Seat held by someone else → co-hide.
                                    return $playerRole === "coHider"
                                        ? undefined
                                        : () => joinTeam("coHider");
                                })()}
                                joinLabel={
                                    !hider || hider.id === $self
                                        ? "Join hiders"
                                        : "Join as co-hider"
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
                    {$mp &&
                        !isMidGame &&
                        ($playerRole === null || !hasRoleBalance) && (
                            <p className="text-[11px] text-muted-foreground leading-snug animate-in fade-in duration-200">
                                {$playerRole === null ? (
                                    <>
                                        Pick your team above to continue.
                                    </>
                                ) : (
                                    <>
                                        Need at least one <b>seeker</b> and
                                        one <b>hider</b> before the game can
                                        start. Share the invite to bring
                                        more in.
                                    </>
                                )}
                            </p>
                        )}

                    {/* Share / room code section (v455): the full-width
                        card is back, positioned here at the bottom of the
                        roster block (below the "need a seeker + hider"
                        hint). Eyebrow label + code on the left, Share /
                        Copy / QR on the right. A pulsing skeleton holds
                        the slot while the room is still being created. */}
                    {$mp && !isMidGame && hostingState === "creating" && !$code && (
                        <div
                            className="rounded-md border border-border bg-secondary/40 px-3 py-2 flex items-center gap-2 min-h-[3.5rem] animate-in fade-in duration-200"
                            role="status"
                            aria-live="polite"
                            aria-label="Creating game room"
                        >
                            <div className="flex flex-col min-w-0 leading-none gap-1.5">
                                <span className="text-[9px] uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground">
                                    Creating room…
                                </span>
                                <div className="h-[1.125rem] w-28 rounded-sm bg-primary/20 animate-pulse" />
                            </div>
                            <div className="ml-auto flex items-center gap-1.5">
                                <div className="h-8 w-[4.5rem] rounded-md bg-secondary animate-pulse" />
                                <div className="h-8 w-9 rounded-md bg-secondary animate-pulse [animation-delay:150ms]" />
                                <div className="h-8 w-9 rounded-md bg-secondary animate-pulse [animation-delay:300ms]" />
                            </div>
                        </div>
                    )}
                    {$mp && !isMidGame && $code && (
                        <div
                            className={cn(
                                "rounded-md border border-border bg-secondary/40",
                                "px-3 py-2 flex items-center gap-2 min-h-[3.5rem]",
                                "animate-in fade-in duration-200",
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
                            <div className="ml-auto flex items-center gap-1.5">
                                <Button
                                    size="sm"
                                    onClick={handleShare}
                                    aria-label="Share invite link"
                                    title="Share invite link"
                                    className="gap-1.5"
                                >
                                    <Share2 className="w-3.5 h-3.5" />
                                    Share
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={handleCopy}
                                    aria-label="Copy invite link"
                                    title={
                                        copied ? "Copied!" : "Copy invite link"
                                    }
                                    className="px-2"
                                >
                                    {copied ? (
                                        <Check className="w-3.5 h-3.5" />
                                    ) : (
                                        <Copy className="w-3.5 h-3.5" />
                                    )}
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

                    {/* Preload opt-in — only on a metered link. On wifi
                        the lobby preloads silently (see the effect), so
                        this checkbox doesn't render at all. */}
                    {!isMidGame && metered && (
                        <label className="flex items-center gap-3 p-3 rounded-md border border-border bg-secondary/30 cursor-pointer animate-in fade-in duration-200">
                            <Checkbox
                                checked={preloadOn}
                                onCheckedChange={(c) =>
                                    setPreloadOn(c === true)
                                }
                                aria-label="Preload game data"
                            />
                            <span className="flex-1 text-sm font-medium text-foreground">
                                Preload game data{" "}
                                <span className="text-muted-foreground tabular-nums">
                                    (~15MB)
                                </span>
                            </span>
                        </label>
                    )}

                    {/* v318: leaderboard — surfaces the rolling
                        round results once at least one round has
                        finished. Shown anywhere in the lobby (pre-
                        round, mid-game, between rounds) so the
                        next-round host can see the current "time
                        to beat" before pressing Start round. */}
                    <LeaderboardSection />

                    {/* Mid-game info section — shown only when
                        manually reopened during an active game. */}
                    {isMidGame && (
                        <>
                            <RoundEndSection />
                            <MidGameInfoSection
                                isHiderRole={isHiderRole}
                                mp={$mp}
                                sharing={$seekerSharing}
                                foundAt={$foundAt}
                                onToggleSharing={() =>
                                    seekerLocationSharing.set(!$seekerSharing)
                                }
                            />
                        </>
                    )}
                </div>

                {/* Footer — Start for pre-game host, then a Leave
                    button below it. v453: Leave moved back here from
                    the header. v455: the share section moved to the
                    bottom of the roster block. Mid-game manual reopens
                    still dismiss via swipe-down; the Leave button
                    stays available there too. */}
                <div className="px-6 pt-3 pb-6 border-t border-border space-y-2">
                    {isMidGame ? null : isHost ? (
                        <>
                            {/* v297: subtitle slot is conditionally
                                rendered now — the prior opacity-0
                                placeholder kept the main label off-
                                centre. Layout pops once when the
                                button flips to "Start game" + the
                                subtitle joins; that single shift is
                                a one-time event when host is ready
                                to start, fine in practice. */}
                            <Button
                                size="lg"
                                className={cn(
                                    "w-full h-16 flex flex-col items-center justify-center gap-0.5",
                                    "font-display uppercase",
                                )}
                                onClick={handleStartGame}
                                disabled={!startReady}
                            >
                                <span
                                    className="text-base font-extrabold leading-none"
                                    style={{ letterSpacing: "0.02em" }}
                                >
                                    {!hasRoleBalance ? (
                                        <>
                                            Waiting for players
                                            <AnimatedEllipsis />
                                        </>
                                    ) : (
                                        "Start round"
                                    )}
                                </span>
                                {startReady && (
                                    <span
                                        className="text-[10px] font-semibold leading-none mt-1 opacity-80"
                                        style={{ letterSpacing: "0.14em" }}
                                    >
                                        {minutes}-min hiding period
                                    </span>
                                )}
                            </Button>
                            {/* Always-rendered footnote slot. The hint
                                only reads when actually meaningful
                                (hider, ready) but the line stays so
                                the footer height doesn't bounce. */}
                            <p
                                className={cn(
                                    "text-[11px] leading-snug text-center",
                                    "transition-colors duration-200",
                                    isHiderRole && startReady
                                        ? "text-muted-foreground"
                                        : "text-transparent select-none",
                                )}
                                aria-hidden={!(isHiderRole && startReady)}
                            >
                                Pick your hiding spot in the meantime.
                            </p>
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
                    {/* Leave game — below Start (v453). Switch role
                        lives inline in the roster row next to '(you)'. */}
                    {$mp && ($code || hostingState === "failed") && (
                        <Button
                            variant="ghost"
                            onClick={handleLeaveGame}
                            className="w-full gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                        >
                            <LogOut className="w-4 h-4" />
                            Leave game
                        </Button>
                    )}
                </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

/** Three-dot ellipsis with a left-to-right fade animation. Used
 *  in disabled Start-button labels so 'Loading map…' /
 *  'Waiting for players…' read as active-but-waiting rather
 *  than 'stuck'. CSS lives in globals.css under .animated-ellipsis.
 *  v275: the inner spans live on a single line — the previous
 *  multi-line JSX inserted whitespace text-nodes between the dots,
 *  which `display: inline-block` rendered as visible gaps and
 *  threw off the visual centering of the parent button label. */
function AnimatedEllipsis() {
    return (
        // prettier-ignore
        <span className="animated-ellipsis inline-block ml-0.5"><span>.</span><span>.</span><span>.</span></span>
    );
}

function RosterCard({
    label,
    tone,
    participants: rows,
    selfId,
    hostId,
    mainHiderId,
    onJoin,
    joinLabel,
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
    /** When set, render a "join this team" button (zero-state pick +
     *  inline switch). The parent decides whether to pass it based on
     *  the local player's current role + seat availability. */
    onJoin?: () => void;
    joinLabel?: string;
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
            {onJoin && (
                <button
                    type="button"
                    onClick={onJoin}
                    className={cn(
                        "mt-1 w-full inline-flex items-center justify-center gap-1.5",
                        "rounded-sm px-2 py-1.5",
                        "text-[11px] uppercase tracking-[0.08em] font-display font-extrabold",
                        "border border-dashed border-border text-foreground/80",
                        "hover:bg-accent hover:text-foreground hover:border-solid",
                        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <Plus className="w-3.5 h-3.5" />
                    {joinLabel}
                </button>
            )}
        </div>
    );
}


/**
 * Best-effort "is this a metered (cellular / data-saver / slow) link?"
 * check via the Network Information API. Returns false when we can't
 * tell (desktop, iOS Safari — no API), which we treat as unmetered:
 * the lobby then preloads silently. Only a positively-detected metered
 * link surfaces the opt-in checkbox so the user can skip the ~15 MB.
 */
function isMeteredConnection(): boolean {
    if (typeof navigator === "undefined") return false;
    const c = (
        navigator as Navigator & {
            connection?: {
                type?: string;
                effectiveType?: string;
                saveData?: boolean;
            };
            mozConnection?: unknown;
            webkitConnection?: unknown;
        }
    ).connection;
    if (!c) return false;
    if (c.saveData) return true;
    if (c.type === "cellular") return true;
    if (
        c.effectiveType &&
        ["slow-2g", "2g", "3g"].includes(c.effectiveType)
    ) {
        return true;
    }
    return false;
}

/** Canonical mode order for the editable chip row + add menu. */
const ALL_TRANSIT_MODES: TransitMode[] = [
    "bus",
    "tram",
    "train",
    "subway",
    "ferry",
];

/** Size options for the inline size dropdown. */
const SIZE_OPTIONS: { value: GameSize; label: string }[] = [
    { value: "small", label: "Small" },
    { value: "medium", label: "Medium" },
    { value: "large", label: "Large" },
];

function MidGameInfoSection({
    isHiderRole,
    mp,
    sharing,
    foundAt,
    onToggleSharing,
}: {
    isHiderRole: boolean;
    mp: boolean;
    sharing: boolean;
    foundAt: number | null;
    onToggleSharing: () => void;
}) {
    return (
        <div className="border-t border-border pt-3 space-y-3 animate-in fade-in duration-200">
            {/* v308: dropped the Play area / Size / Transit summary
                block — the lobby header now carries the same
                information ("Medium game in Stockholm" + the transit
                icon pills) so duplicating it here was redundant.
                v296 had already moved the Edit Settings button out;
                this completes the cleanup so the mid-game section is
                purely the GPS-sharing toggle. */}

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
        </div>
    );
}

/**
 * v318: leaderboard of completed rounds in the current game. Each
 * row carries the round number, the hider's name at the time, and
 * the wall-clock the hider stayed hidden after the hiding period
 * ended (the rulebook's scoring metric). Sorted longest-hide-first
 * so the current "time to beat" sits at the top.
 *
 * Hidden entirely when the log is empty — first round of a new
 * game has nothing to show.
 */
function LeaderboardSection() {
    const $log = useStore(roundLog);
    if ($log.length === 0) return null;
    const sorted = [...$log].sort((a, b) => b.hidingMs - a.hidingMs);
    return (
        <div className="border-t border-border pt-3 space-y-2 animate-in fade-in duration-200">
            <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                    Leaderboard
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                    {sorted.length}{" "}
                    {sorted.length === 1 ? "round" : "rounds"}
                </span>
            </div>
            <ol className="space-y-1">
                {sorted.map((row, idx) => (
                    <li
                        key={`${row.roundNumber}-${row.foundAt}`}
                        className={cn(
                            "flex items-center gap-2 px-2.5 py-1.5 rounded-sm",
                            "border border-border bg-secondary/40",
                            idx === 0 && "border-primary/50 bg-primary/10",
                        )}
                    >
                        <span
                            className={cn(
                                "shrink-0 inline-flex items-center justify-center",
                                "w-5 h-5 rounded-full text-[10px] font-bold tabular-nums",
                                idx === 0
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-secondary text-muted-foreground",
                            )}
                            aria-label={`Position ${idx + 1}`}
                        >
                            {idx + 1}
                        </span>
                        <span className="text-xs font-medium truncate min-w-0 flex-1">
                            {row.hiderName}
                        </span>
                        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                            Round {row.roundNumber}
                        </span>
                        <span className="text-xs font-poppins font-bold tabular-nums shrink-0">
                            {formatHiddenDuration(row.hidingMs)}
                        </span>
                    </li>
                ))}
            </ol>
        </div>
    );
}

function formatHiddenDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}:${String(s).padStart(2, "0")}`;
}

export default GameLobbyDialog;
