import { useStore } from "@nanostores/react";
import {
    ArrowLeftRight,
    Check,
    ChevronDown,
    Copy,
    Loader2,
    LogOut,
    Pencil,
    Plus,
    QrCode,
    Share2,
    Shield,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { Drawer as VaulDrawer } from "vaul";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { appConfirm } from "@/lib/confirm";
import { additionalMapGeoLocations, mapGeoLocation } from "@/lib/context";
import { commitPlayAreaChange } from "@/lib/playAreaCommit";
import type { OpenStreetMap } from "@/maps/api";
import {
    allowedTransit,
    type GameSize,
    gameSize,
    gameStartCelebrationAt,
    gameStartOverLobby,
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
import { appNavigate } from "@/lib/appNavigate";
import { playerRole, roundLog } from "@/lib/hiderRole";
import {
    currentGameCode,
    displayName as displayNameAtom,
    localIsHost,
    lobbyManualOpen,
    multiplayerEnabled,
    multiplayerError,
    participants,
    selfParticipantId,
    transportStatus,
} from "@/lib/multiplayer/session";
import {
    createGame,
    hostPushSetup,
    joinAsHost,
    leaveGame,
    setOnlineName,
    setOnlineRole,
} from "@/lib/multiplayer/store";
import { preloadDuringHidingPeriod } from "@/lib/preload";
import { returnToLandingPage } from "@/lib/roundActions";
import { fetchTilePackBytes } from "@/lib/tilePack";
import { cn } from "@/lib/utils";

import { PlayAreaStep, TransitStep } from "./GameSetupDialog";
import { HouseRulesSection } from "./HouseRulesSection";
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
    const $overLobby = useStore(gameStartOverLobby);
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
            ($welcomeSeen &&
                $setupCompleted &&
                // v814: stay open through the game-start flourish (the
                // clock is armed but the GO-GO-GO overlay is playing OVER
                // the lobby) so the lobby fades behind the explosion
                // rather than snapping shut before it.
                ($hidingEndsAt === null || $overLobby)));

    const isHiderRole = $playerRole === "hider";

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
        // v815: a FAILED create must NOT auto-retry. The effect re-runs on
        // its own `hostingState` change, so without this guard a persistent
        // failure (most often the Worker's per-IP room-creation rate limit
        // — HTTP 429 — after a lot of quick new-games) span create → fail →
        // create in a tight loop that pegged the main thread and froze the
        // lobby / role picker. Wait for the user's explicit Retry button
        // (which resets hostingState to "idle") instead.
        if (hostingState === "failed") return;
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
    // v829: the hide team is a flat list of equal `hider`s (no main/co
    // distinction). `hider` = the first for any single-hider display bits.
    const hiders = $participants.filter(
        (p) => p.online && p.role === "hider",
    );
    const hider = hiders[0];
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
    const setSize = (s: GameSize) => {
        gameSize.set(s);
        hostPushSetup();
    };
    // v838: the play area gets its OWN focused "Edit play area" dialog
    // (matching the compact transit/size editors), instead of opening the
    // whole tabbed Game-Settings wizard. Draft is seeded from the current
    // area on open; Save commits it live (+ pushes to peers) only when it
    // actually changed.
    const openAreaEditor = () => {
        setPlayAreaEditOpen(true);
    };
    const handleSavePlayArea = () => {
        const current = mapGeoLocation.get();
        const changed =
            draftArea != null &&
            draftArea.properties.osm_id !==
                (current?.properties.osm_id ?? null);
        if (changed) {
            commitPlayAreaChange(draftArea);
            hostPushSetup();
        }
        setPlayAreaEditOpen(false);
    };

    // v447: pick / switch team from the lobby roster zero-state. Mirrors
    // Welcome.handlePickRole — sets the local role, pushes it to the
    // server, and routes hiders to /h, seekers back to / if they were on
    // the hider page. v829: any number of players can be hiders.
    const joinTeam = (role: "seeker" | "hider") => {
        playerRole.set(role);
        setOnlineRole(role);
        if (typeof window === "undefined") return;
        // v756: SOFT-navigate (SPA) instead of window.location.assign — a full
        // reload here tore down the live WS + let the reconnect snapshot
        // clobber the wizard's transit/size settings (the "lobby reloads when
        // I pick hider" bug). The presence echo's reconcileLocalRoleFromPresence
        // also soft-navigates now, so this is just the immediate, responsive
        // move; falls back to a hard nav only if the router bridge is absent.
        const onHiderPage = window.location.pathname.startsWith("/h");
        if (role === "hider") {
            if (!onHiderPage && !appNavigate("/h", { replace: true }))
                window.location.assign("/h");
        } else if (onHiderPage) {
            if (!appNavigate("/", { replace: true }))
                window.location.assign("/");
        }
    };

    // Preload (moved from the wizard, v444). On an unmetered link we just
    // preload silently; only a positively-metered link gets the opt-in
    // checkbox. `metered` is sampled once at mount.
    const $preload = useStore(preloadChoices);
    const [metered] = useState(() => isMeteredConnection());
    // Real tile-pack size for the current city, fetched (HEAD) only when
    // the preload checkbox is actually shown (metered link). null while
    // unknown / no pack → estimatePreloadMB falls back to the area model.
    const [packBytes, setPackBytes] = useState<number | null>(null);
    const $additional = useStore(additionalMapGeoLocations);
    // Stable key of the added-adjacent osm ids so the effect re-runs when
    // neighbours are folded in/out — each added area is a SEPARATE tile
    // pack to download, so the estimate must sum them with the primary.
    const addedPackKey = useMemo(
        () =>
            $additional
                .filter((e) => e.added && e.location)
                .map(
                    (e) =>
                        (e.location.properties as {
                            osm_id?: number;
                            osm_type?: string;
                        }),
                )
                .filter((p) => p?.osm_type === "R" && p?.osm_id)
                .map((p) => p!.osm_id)
                .sort((a, b) => (a ?? 0) - (b ?? 0))
                .join(","),
        [$additional],
    );
    useEffect(() => {
        if (isMidGame || !metered) return;
        const ids: number[] = [];
        const primary = $mapGeoLocation?.properties as
            | { osm_id?: number; osm_type?: string }
            | undefined;
        if (primary?.osm_type === "R" && primary?.osm_id) {
            ids.push(Number(primary.osm_id));
        }
        if (addedPackKey) {
            for (const s of addedPackKey.split(",")) ids.push(Number(s));
        }
        if (ids.length === 0) {
            setPackBytes(null);
            return;
        }
        const ctrl = new AbortController();
        setPackBytes(null);
        // Sum the packs that exist (404s → null → contribute nothing, and
        // their map data warms via the range walk, which the area term of
        // the estimate covers). Resolve to null only if NONE has a pack.
        Promise.all(
            ids.map((id) => fetchTilePackBytes(id, ctrl.signal)),
        ).then((sizes) => {
            if (ctrl.signal.aborted) return;
            const total = sizes.reduce<number>((a, b) => a + (b ?? 0), 0);
            setPackBytes(total > 0 ? total : null);
        });
        return () => ctrl.abort();
    }, [$mapGeoLocation?.properties, addedPackKey, isMidGame, metered]);
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
    // Transit-mode editor (host). Opens the wizard's transit step in a
    // dialog; changes apply live via commitTransit (and push to peers).
    const [transitEditOpen, setTransitEditOpen] = useState(false);
    // v838: dedicated "Edit play area" dialog (draft seeded from the current
    // area on open). Kept out of the whole Game-Settings wizard.
    const [playAreaEditOpen, setPlayAreaEditOpen] = useState(false);
    const [draftArea, setDraftArea] = useState<OpenStreetMap | null>(null);
    useEffect(() => {
        if (playAreaEditOpen) setDraftArea(mapGeoLocation.get());
    }, [playAreaEditOpen]);
    // Change-display-name dialog (v834), opened from the roster row's inline
    // pencil next to "(you)". Seeds from the current name on open.
    const [nameEditOpen, setNameEditOpen] = useState(false);
    const [draftName, setDraftName] = useState("");
    useEffect(() => {
        if (nameEditOpen) setDraftName(displayNameAtom.get() || "");
    }, [nameEditOpen]);
    const commitName = () => {
        const trimmed = draftName.trim();
        if (trimmed) setOnlineName(trimmed);
        setNameEditOpen(false);
    };
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
        // v820: harden `minutes` against a corrupt gameSize. If `$size` is
        // ever an off-enum value, `HIDING_PERIOD_MINUTES[$size]` is undefined
        // → `minutes` undefined → `Date.now() + undefined*60_000` = NaN, and a
        // NaN clock sends both round-beat watchers into an infinite GO-GO-GO /
        // SEEK re-fire loop (thrash + frozen map). Fall back to a sane 60 min.
        const safeMinutes =
            Number.isFinite(minutes) && (minutes as number) > 0
                ? (minutes as number)
                : HIDING_PERIOD_MINUTES.medium;
        // Arm the clock (correct timing + guest sync via the push below)…
        hidingPeriodEndsAt.set(Date.now() + safeMinutes * 60_000);
        pendingHidingDurationMin.set(null);
        // …but play the 3-2-1 + GO-GO-GO flourish OVER the lobby first:
        // set both flags SYNCHRONOUSLY so the pre-game branch never swaps
        // to the map for a frame (no seeker-view flash), and the lobby
        // stays open behind the countdown (v814). The GoGoGo card's
        // dismiss clears both, revealing the map.
        gameStartOverLobby.set(true);
        gameStartCelebrationAt.set(Date.now());
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
            // v810: pre-game the lobby is NON-MODAL. It's a modal vaul
            // drawer by default (focus trap + body scroll-lock), but the
            // RolePicker Dialog that layers OVER it (host, role-not-yet-
            // picked) portals its autofocused name input to document.body —
            // OUTSIDE the drawer's DOM subtree. vaul's focus trap then yanks
            // focus back into the drawer on every focus attempt, so the
            // input can't hold focus (you type but nothing lands) and the
            // focus-bounce pegs the UI — the "role picker freezes, keyboard
            // opens but the field won't change" bug. Pre-game there is no
            // seeker/hider shell mounted behind the lobby, so nothing needs
            // the focus trap; the RolePicker (a proper Radix modal with its
            // own z-[1060] overlay) owns focus cleanly. Mid-game manual
            // reopen stays modal (it sits over the live game shell).
            modal={isMidGame}
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
                            : // v784: the pre-game full-screen lobby FADES in
                              // instead of vaul's slide-up. Picking the hider
                              // role navigates to /h, which mounts a fresh
                              // lobby drawer — the slide-up read as a janky
                              // "reload" vs. the seeker path (same route, the
                              // picker just fades to reveal the already-open
                              // lobby). `!transform-none` kills vaul's translate;
                              // the fade matches the picker/overlay dismissal.
                              "inset-0 h-full pt-[env(safe-area-inset-top)] !transform-none animate-in fade-in duration-200",
                        "bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
                        "pb-[env(safe-area-inset-bottom)] sm:max-w-md sm:mx-auto",
                    )}
                >
                    {$manualOpen && (
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                    )}
                {/* Header (v857): the ROOM CODE is the lobby's identity — this
                    page is about the game ROOM itself, so the code + the Share /
                    Copy / QR actions sit at the very top. Fixed (never scrolls);
                    the Game settings / Players / House rules sections follow in
                    the scroll area below. A pulsing skeleton holds the slot
                    while the room is still being created. */}
                <div className="px-5 pt-5 pb-4 shrink-0 space-y-3 border-b border-border">
                    <VaulDrawer.Title className="sr-only">
                        {$code ? `Game lobby — room ${$code}` : "Game lobby"}
                    </VaulDrawer.Title>
                    <VaulDrawer.Description className="sr-only">
                        {$allowedTransit.length > 0
                            ? `Allowed transit: ${$allowedTransit
                                  .map((m) => TRANSIT_LABELS[m])
                                  .join(", ")}`
                            : "Walking only"}
                    </VaulDrawer.Description>

                    {$mp && $code ? (
                        <div className="flex items-center gap-2">
                            <div className="flex flex-col min-w-0 leading-none">
                                <span className="text-[10px] uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground">
                                    Room code
                                </span>
                                <span className="font-display font-black uppercase text-2xl tabular-nums tracking-[0.08em] text-primary mt-0.5">
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
                    ) : (
                        <div
                            className="flex items-center gap-2 min-h-[3rem]"
                            role="status"
                            aria-live="polite"
                            aria-label="Creating game room"
                        >
                            <div className="flex flex-col min-w-0 leading-none gap-1.5">
                                <span className="text-[10px] uppercase tracking-[0.14em] font-display font-extrabold text-muted-foreground">
                                    {hostingState === "failed"
                                        ? "Room code"
                                        : "Creating room…"}
                                </span>
                                <div className="h-6 w-28 rounded-sm bg-primary/20 animate-pulse" />
                            </div>
                            <div className="ml-auto flex items-center gap-1.5">
                                <div className="h-8 w-[4.5rem] rounded-md bg-secondary animate-pulse" />
                                <div className="h-8 w-9 rounded-md bg-secondary animate-pulse [animation-delay:150ms]" />
                                <div className="h-8 w-9 rounded-md bg-secondary animate-pulse [animation-delay:300ms]" />
                            </div>
                        </div>
                    )}
                </div>

                <div className="px-5 py-3 flex-1 min-h-0 overflow-y-auto space-y-3">
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


                    {/* Transit-mode editor — the wizard's transit step in
                        a dialog. Changes apply live (commitTransit pushes
                        to peers). Mirrors the QR dialog's portal pattern
                        so it renders above the lobby drawer. */}
                    {isHost && (
                        <Dialog
                            open={transitEditOpen}
                            onOpenChange={setTransitEditOpen}
                        >
                            <DialogContent
                                // Raise above the lobby drawer (content
                                // z-[1055]) — the default dialog z-[1050]
                                // would open BEHIND it (see CLAUDE.md
                                // z-index ladder).
                                className={cn(
                                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                                    "sm:max-w-md z-[1060]",
                                )}
                                overlayClassName="z-[1060]"
                            >
                                <DialogTitle className="font-display font-black uppercase text-base tracking-[0.10em]">
                                    Transit modes
                                </DialogTitle>
                                <TransitStep
                                    value={$allowedTransit}
                                    onChange={commitTransit}
                                />
                                {/* Changes apply live (commitTransit pushes to
                                    peers); Save just closes the editor. */}
                                <Button
                                    onClick={() => setTransitEditOpen(false)}
                                    className="w-full mt-2"
                                >
                                    <Check className="w-4 h-4 mr-1.5" />
                                    Save
                                </Button>
                            </DialogContent>
                        </Dialog>
                    )}

                    {/* Edit play area (v838) — a focused dialog (search + map
                        picker + adjacent areas), matching the compact transit/
                        size editors instead of the whole tabbed Game-Settings
                        wizard. Host only; only reachable pre-game (the preview
                        Edit button lives in the !isMidGame block). */}
                    {isHost && (
                        <Dialog
                            open={playAreaEditOpen}
                            onOpenChange={setPlayAreaEditOpen}
                        >
                            <DialogContent
                                className={cn(
                                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                                    "sm:max-w-lg z-[1060] flex max-h-[88vh] flex-col",
                                )}
                                overlayClassName="z-[1060]"
                            >
                                <DialogTitle className="font-display font-black uppercase text-base tracking-[0.10em] shrink-0">
                                    Edit play area
                                </DialogTitle>
                                <div className="flex-1 overflow-y-auto -mx-1 px-1">
                                    <PlayAreaStep
                                        value={draftArea}
                                        onChange={setDraftArea}
                                    />
                                </div>
                                <div className="shrink-0 flex gap-2 pt-1">
                                    <Button
                                        variant="outline"
                                        onClick={() =>
                                            setPlayAreaEditOpen(false)
                                        }
                                        className="flex-1"
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        onClick={handleSavePlayArea}
                                        disabled={!draftArea}
                                        className="flex-1"
                                    >
                                        <Check className="w-4 h-4 mr-1.5" />
                                        Save
                                    </Button>
                                </div>
                            </DialogContent>
                        </Dialog>
                    )}

                    {/* Change display name (v834) — opened from the roster
                        row's pencil next to "(you)". Applies to the local
                        player + syncs to the room via setOnlineName. */}
                    <Dialog open={nameEditOpen} onOpenChange={setNameEditOpen}>
                        <DialogContent
                            className={cn(
                                "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                                "sm:max-w-xs z-[1060]",
                            )}
                            overlayClassName="z-[1060]"
                        >
                            <DialogTitle className="font-display font-black uppercase text-base tracking-[0.10em]">
                                Your display name
                            </DialogTitle>
                            <Input
                                autoFocus
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") commitName();
                                }}
                                placeholder="What others see"
                                maxLength={24}
                            />
                            <Button
                                onClick={commitName}
                                disabled={!draftName.trim()}
                                className="w-full"
                            >
                                <Check className="w-4 h-4 mr-1.5" />
                                Save
                            </Button>
                        </DialogContent>
                    </Dialog>

                    {/* Section 1 — GAME SETTINGS (v857): size + allowed transit
                        + the play-area map. Scrolls with the rest now that the
                        ROOM CODE owns the fixed header. Pre-game only (mid-game
                        manual reopen is about the roster / round-end). */}
                    {!isMidGame && (
                        <>
                            <h3 className="text-[11px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                Game settings
                            </h3>

                            {/* Game size + allowed-transit (icon-only,
                                map-overlay sized) + an Edit button that opens
                                the wizard's transit step — all on one row. */}
                            <div className="flex items-center gap-2 flex-wrap">
                                {/* Size pill — chevron lives INSIDE the coloured
                                    pill so it reads as one unit. Host taps to
                                    change; dropdown rows show the same badge. */}
                                {isHost ? (
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <button
                                                type="button"
                                                aria-label="Change game size"
                                                className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                <SizeBadge
                                                    size={$size}
                                                    className="text-sm px-2.5 py-1.5"
                                                    trailing={
                                                        <ChevronDown className="w-4 h-4 opacity-80" />
                                                    }
                                                />
                                            </button>
                                        </PopoverTrigger>
                                        <PopoverContent
                                            align="start"
                                            container={drawerEl}
                                            className="z-[1060] w-48 p-1"
                                        >
                                            {SIZE_OPTIONS.map((o) => (
                                                <button
                                                    key={o.value}
                                                    type="button"
                                                    onClick={() =>
                                                        setSize(o.value)
                                                    }
                                                    aria-label={o.label}
                                                    className="flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent transition-colors"
                                                >
                                                    <SizeBadge
                                                        size={o.value}
                                                        className="text-sm px-2.5 py-1"
                                                    />
                                                    {o.value === $size && (
                                                        <Check className="w-4 h-4 text-primary ml-auto" />
                                                    )}
                                                </button>
                                            ))}
                                        </PopoverContent>
                                    </Popover>
                                ) : (
                                    <SizeBadge
                                        size={$size}
                                        className="text-sm px-2.5 py-1.5"
                                    />
                                )}

                                {/* Allowed transit — icon-only pills. */}
                                {$allowedTransit.length === 0 ? (
                                    <span className="text-xs text-muted-foreground italic">
                                        Walking only
                                    </span>
                                ) : (
                                    <div className="flex items-center gap-1.5">
                                        {$allowedTransit.map((m) => {
                                            const Icon = TRANSIT_ICONS[m];
                                            return (
                                                <span
                                                    key={m}
                                                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border-2 border-border bg-background"
                                                    title={TRANSIT_LABELS[m]}
                                                    aria-label={TRANSIT_LABELS[m]}
                                                >
                                                    <Icon className="w-4 h-4" />
                                                </span>
                                            );
                                        })}
                                    </div>
                                )}

                                {/* Edit transit — opens the wizard's transit
                                    step in a dialog. When ALL modes are on the
                                    row is full, so drop the "Edit" label to
                                    icon-only so the pencil still fits. */}
                                {isHost &&
                                    (() => {
                                        const allTransitOn =
                                            $allowedTransit.length ===
                                            ALL_TRANSIT_MODES.length;
                                        return (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setTransitEditOpen(true)
                                                }
                                                aria-label="Edit transit modes"
                                                title="Edit transit modes"
                                                className={cn(
                                                    "inline-flex h-9 items-center gap-1.5 rounded-md border-2 border-dashed border-border text-xs font-poppins font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                                    allTransitOn
                                                        ? "w-9 justify-center px-0"
                                                        : "px-2.5",
                                                )}
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                                {!allTransitOn && "Edit"}
                                            </button>
                                        );
                                    })()}
                            </div>

                            {/* Play-area map. The 180-px slot is reserved
                                unconditionally so the content doesn't jump when
                                a guest's host-pushed setup arrives a beat after
                                the lobby opens; a skeleton fills the box until
                                the boundary is in. */}
                            {($mapGeoLocation?.properties?.osm_id ?? 0) > 0 ? (
                                <div className="relative">
                                    <PlayAreaPreviewMap
                                        value={$mapGeoLocation!}
                                        height="h-[180px]"
                                        preferCombinedBoundary
                                        deferReveal
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
                            )}
                        </>
                    )}

                    {/* Section 2 — PLAYERS (v856). */}
                    {$mp && ($participants.length > 0 || !isMidGame) && (
                        <h3 className="text-[11px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Players
                        </h3>
                    )}

                    {/* Players roster + team zero-state. v447: each card
                        carries a "join this team" button (unless the
                        local player is already on it) so picking / switching
                        a role happens here instead of a popup. Hidden
                        mid-game (no role-swapping once the clock runs). */}
                    {$mp && ($participants.length > 0 || !isMidGame) && (
                        <div className="flex flex-col gap-2 animate-in fade-in duration-200">
                            <RosterCard
                                label={`Seekers · ${seekers.length}`}
                                tone="seeker"
                                participants={seekers}
                                selfId={$self}
                                hostId={hostId}
                                onJoin={
                                    !isMidGame && $playerRole === null
                                        ? () => joinTeam("seeker")
                                        : undefined
                                }
                                joinLabel="Join seekers"
                                onSwitchTeam={
                                    !isMidGame && $playerRole === "seeker"
                                        ? () => joinTeam("hider")
                                        : undefined
                                }
                                onEditName={
                                    !isMidGame
                                        ? () => setNameEditOpen(true)
                                        : undefined
                                }
                            />
                            <RosterCard
                                label={`Hiders · ${hiders.length}`}
                                tone="hider"
                                participants={hiders}
                                selfId={$self}
                                hostId={hostId}
                                onJoin={
                                    !isMidGame && $playerRole === null
                                        ? () => joinTeam("hider")
                                        : undefined
                                }
                                joinLabel="Join hiders"
                                onSwitchTeam={
                                    !isMidGame && $playerRole === "hider"
                                        ? () => joinTeam("seeker")
                                        : undefined
                                }
                                onEditName={
                                    !isMidGame
                                        ? () => setNameEditOpen(true)
                                        : undefined
                                }
                            />
                        </div>
                    )}
                    {$mp && !isMidGame && $playerRole === null && (
                        <p className="text-sm text-muted-foreground leading-snug animate-in fade-in duration-200">
                            Pick your team above to continue.
                        </p>
                    )}

                    {/* (Share moved to the fixed header — the ROOM CODE IS the
                        lobby header now, v857.) */}

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
                                    (~
                                    {estimatePreloadMB(
                                        $mapGeoLocation,
                                        $size,
                                        packBytes,
                                    )}
                                    MB)
                                </span>
                            </span>
                        </label>
                    )}

                    {/* House rules — table-wide deviations from the
                        printed rulebook. Host-authoritative: a toggle
                        writes the local atom and pushes the whole setup
                        to peers (hostPushSetup), and incoming setups
                        mirror the values back, so every device plays by
                        the same rules. Guests see them read-only. Moved
                        here from the per-device Settings drawer in v601
                        because they govern the whole game, not one
                        device. */}
                    <HouseRulesSection
                        readOnly={!isHost}
                        onAfterChange={hostPushSetup}
                    />

                    {/* v318: leaderboard — surfaces the rolling
                        round results once at least one round has
                        finished. Shown anywhere in the lobby (pre-
                        round, mid-game, between rounds) so the
                        next-round host can see the current "time
                        to beat" before pressing Start round. */}
                    <LeaderboardSection />

                    {/* Mid-game round-end section — shown only when
                        manually reopened during an active game. v834: the
                        GPS-sharing toggle moved to the map (a small status
                        chip by the follow-me control), so it's no longer
                        buried in the manually-reopened lobby. */}
                    {isMidGame && <RoundEndSection />}
                </div>

                {/* Footer — Start for pre-game host, then a Leave
                    button below it. v453: Leave moved back here from
                    the header. v455: the share section moved to the
                    bottom of the roster block. Mid-game manual reopens
                    still dismiss via swipe-down; the Leave button
                    stays available there too. */}
                <div className="px-6 pt-2 pb-3 border-t border-border space-y-1.5">
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
                        </>
                    ) : (
                        <div className="text-center py-3 space-y-1">
                            <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
                            <div className="text-sm text-current/80">
                                Waiting for the host to start the game…
                            </div>
                        </div>
                    )}
                    {/* Leave game — below Start (v453). Switch role
                        lives inline in the roster row next to '(you)'. */}
                    {$mp && ($code || hostingState === "failed") && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleLeaveGame}
                            className="w-full h-8 gap-2 text-xs text-foreground/70 hover:text-foreground hover:bg-accent"
                        >
                            <LogOut className="w-3.5 h-3.5" />
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
    onJoin,
    joinLabel,
    onSwitchTeam,
    onEditName,
}: {
    label: string;
    tone: "seeker" | "hider";
    participants: {
        id: string;
        displayName: string;
        role: "seeker" | "hider" | null;
        online: boolean;
    }[];
    selfId: string | null;
    hostId: string | null;
    /** When set, render a "join this team" button — only in the zero-state
     *  (the local player hasn't picked a role yet). */
    onJoin?: () => void;
    joinLabel?: string;
    /** When set (on the card that holds the local player), the "(you)" row
     *  gets a switch-teams button. */
    onSwitchTeam?: () => void;
    /** When set, the "(you)" row gets a change-name button. */
    onEditName?: () => void;
}) {
    const cardCls =
        tone === "seeker"
            ? "bg-secondary/40 border-border"
            : "bg-secondary/20 border-border/70";
    return (
        <div className={cn("rounded-md border px-3.5 py-3 space-y-2", cardCls)}>
            {/* v834: header label is bigger and carries no role icon. */}
            <span
                className={cn(
                    "text-sm uppercase tracking-[0.12em] font-display font-extrabold",
                    tone === "seeker"
                        ? "text-muted-foreground"
                        : "text-muted-foreground/80",
                )}
            >
                {label}
            </span>
            {rows.length === 0 ? (
                <div className="text-sm text-muted-foreground italic leading-snug">
                    {tone === "seeker"
                        ? "No seekers yet."
                        : "No hiders yet."}
                </div>
            ) : (
                <ul className="space-y-1.5">
                    {rows.map((p) => {
                        const isMe = p.id === selfId;
                        const isHost = p.id === hostId;
                        return (
                            <li
                                key={p.id}
                                className="flex items-center gap-2 text-base"
                            >
                                <span
                                    className={cn(
                                        // v856: NOT flex-1 — the row stays
                                        // content-width so the switch/rename
                                        // buttons sit right beside the name
                                        // instead of pushed to the far right.
                                        "min-w-0 truncate flex items-center gap-1.5 font-medium",
                                        !p.online && "opacity-50",
                                    )}
                                >
                                    <span className="truncate">
                                        {p.displayName || "Anonymous"}
                                    </span>
                                    {isHost && (
                                        <span
                                            className="shrink-0 inline-flex"
                                            title="Host"
                                            aria-label="Host"
                                        >
                                            <Shield className="w-3.5 h-3.5 text-amber-500" />
                                        </span>
                                    )}
                                    {isMe && (
                                        <span className="text-sm text-muted-foreground shrink-0">
                                            (you)
                                        </span>
                                    )}
                                </span>
                                {/* My own row: inline switch-teams + rename,
                                    right beside the name (v856). */}
                                {isMe && (onSwitchTeam || onEditName) && (
                                    <span className="flex items-center gap-1 shrink-0">
                                        {onSwitchTeam && (
                                            <button
                                                type="button"
                                                onClick={onSwitchTeam}
                                                aria-label="Switch teams"
                                                title="Switch teams"
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                <ArrowLeftRight className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                        {onEditName && (
                                            <button
                                                type="button"
                                                onClick={onEditName}
                                                aria-label="Change your name"
                                                title="Change your name"
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </span>
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
                        "mt-1.5 w-full inline-flex items-center justify-center gap-1.5",
                        "rounded-sm px-2 py-2",
                        "text-xs uppercase tracking-[0.08em] font-display font-extrabold",
                        "border border-dashed border-border text-foreground/80",
                        "hover:bg-accent hover:text-foreground hover:border-solid",
                        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <Plus className="w-4 h-4" />
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

/**
 * Rough estimate of the preload download size for the current play area,
 * in MB. The old label was a flat "~15MB" regardless of city; this scales
 * with the actual play-area extent (the vector tile pack dominates and
 * grows with area) plus a per-size base for the Overpass reference/transit
 * warm-up. It's deliberately coarse — the label is prefixed "~" — but a
 * Tokyo-sized area no longer reads the same as a small town.
 */
function estimatePreloadMB(
    geo: { properties?: { extent?: number[] } } | null,
    size: GameSize,
    packBytes: number | null,
): number {
    // Per-size base: the Overpass references + transit warm-up. Small/
    // medium also pull the heavier "-full" reference sets, large skips
    // them but covers more ground, so they land in the same ballpark.
    const base = size === "small" ? 4 : 5;

    // Best case: this city has a curated tile pack, so the map bucket is
    // exactly that one download. Use its real size + the warm-up base
    // instead of guessing from area.
    if (packBytes != null && packBytes > 0) {
        return Math.max(1, Math.round(packBytes / 1_000_000) + base);
    }

    const ext = geo?.properties?.extent;
    let areaKm2: number | null = null;
    if (Array.isArray(ext) && ext.length === 4) {
        // Photon extent order: [minLng, maxLat, maxLng, minLat]. We take
        // absolute spans so a differently-ordered bbox still measures the
        // same rectangle.
        const [w, n, e, s] = ext;
        const midLat = (n + s) / 2;
        const lngKm =
            Math.abs(e - w) * 111.32 * Math.cos((midLat * Math.PI) / 180);
        const latKm = Math.abs(n - s) * 110.57;
        const a = lngKm * latKm;
        if (Number.isFinite(a) && a > 0) areaKm2 = a;
    }
    if (areaKm2 === null) {
        // No extent yet — fall back to a size-band guess.
        return size === "small" ? 6 : size === "large" ? 40 : 15;
    }
    // No pack: the map warms via a z11-15 range walk, very roughly
    // ~0.03 MB/km² over the bbox.
    const est = base + areaKm2 * 0.03;
    return Math.max(3, Math.min(150, Math.round(est)));
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
