import { useStore } from "@nanostores/react";
import { Eye, Loader2, MapPin, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setupCompleted, welcomeSeen } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import {
    currentGameCode,
    displayName as displayNameAtom,
    multiplayerError,
    participants as participantsAtom,
    pickRandomCastName,
    transportStatus,
} from "@/lib/multiplayer/session";
import {
    joinAsGuest,
    leaveGame,
    setOnlineRole,
} from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

import { InstallAppButton } from "./InstallAppButton";
import { HideSeekMark, HideSeekScene, HideSeekWordmark } from "./JetLagLogo";

/**
 * First-load welcome screen. v267: was a dialog overlaid on the
 * seeker view; now its own fullsize page mounted at `/welcome` so
 * the seeker shell (sidebars, map, top + bottom nav, drawers) never
 * loads on first launch. The seeker / hider route guards redirect
 * unseen users here; this component reverse-redirects to / or /h
 * once a role is picked.
 *
 * Two paths out:
 *
 *  - "Start new game"  → flips `welcomeSeen=true` and navigates to
 *    /setup so the wizard takes over.
 *  - "Join a game"     → inline display-name + code form; on join we
 *    flip `welcomeSeen=true` and `setupCompleted=true` so the wizard
 *    doesn't open for the guest (the host pushes setup via the
 *    multiplayer transport instead).
 *
 * Renders as a full-screen panel: no overlay, no escape hatch.
 * First-loaders MUST pick a path.
 */
export function Welcome() {
    const $welcomeSeen = useStore(welcomeSeen);
    const $status = useStore(transportStatus);
    const $error = useStore(multiplayerError);
    const $code = useStore(currentGameCode);
    const $participants = useStore(participantsAtom);
    const navigate = useNavigate();

    // Three-phase join:
    //   intro     — pick "Start new game" or "Join a game"
    //   join-form — enter name + code, click Continue
    //   join-lobby — connected to room with role=null, pick role
    //                from informed options (sees who's already in,
    //                knows whether the hider seat is taken)
    const [mode, setMode] = useState<"intro" | "join-form" | "join-lobby">(
        "intro",
    );
    const [name, setName] = useState(displayNameAtom.get() || "");
    const [code, setCode] = useState("");
    const [castPlaceholder] = useState(() => pickRandomCastName());

    // v267: the welcome screen is now its own /welcome route, not a
    // dialog overlay. If a returning user (welcomeSeen=true) somehow
    // lands here, redirect away on mount so they don't see the
    // first-load screen again.
    useEffect(() => {
        if ($welcomeSeen) navigate("/", { replace: true });
    }, [$welcomeSeen, navigate]);

    const trimmedName = name.trim();
    const trimmedCode = code.trim().toUpperCase();
    const validCode = /^[A-Z]{4,8}$/.test(trimmedCode);
    const canContinue = trimmedName.length > 0 && validCode;

    // Group participants by role so the picker can show
    // "Seekers (3) — Alice, Bob, Carol" / "Hider (1) — Dana"
    // and disable the Hider tile when one already holds the seat.
    const seekers = $participants.filter((p) => p.role === "seeker");
    const hider = $participants.find((p) => p.role === "hider");
    // v829: the hide team is a flat list of equal hiders (no co-hider role).
    const hiders = $participants.filter((p) => p.role === "hider");

    const handleStartNew = () => {
        welcomeSeen.set(true);
        // v252: wizard is its own route now. Navigate explicitly so
        // we land on /setup even before the SeekerPage's route guard
        // would catch the (welcomeSeen=true, !setupCompleted) state.
        if (!setupCompleted.get()) navigate("/setup");
    };

    // Step 1 of join: connect with role=null so the participant
    // appears in the roster but doesn't claim the hider seat
    // prematurely. Transition to the lobby preview where the user
    // sees who's in and picks their role with full context.
    const handleContinueToLobby = () => {
        if (!canContinue) return;
        displayNameAtom.set(trimmedName);
        multiplayerError.set(null);
        // Clear any stale local role so the server's null
        // assignment for fresh joiners isn't overridden by a
        // persisted role from a previous session.
        playerRole.set(null);
        joinAsGuest(trimmedCode, trimmedName);
        setMode("join-lobby");
        toast.info(`Joining game ${trimmedCode}…`, { autoClose: 2500 });
    };

    // Step 2 of join: user picked a role from the informed
    // options. Persist it + push to server, then close Welcome
    // and let the lobby / hider home take over.
    const handlePickRole = (role: "seeker" | "hider") => {
        playerRole.set(role);
        setOnlineRole(role);
        welcomeSeen.set(true);
        setupCompleted.set(true);
        // SOFT-navigate for BOTH roles (v755). The hider used to HARD-navigate
        // (`window.location.assign("/h")`) as a bundle-size micro-opt, but a
        // full page reload tore down the live multiplayer WebSocket mid-flight
        // — including the host's just-sent `hostPushSetup` (transit modes /
        // game size) — then reconnected and let `applySnapshot` overwrite the
        // local wizard atoms with the server's now-STALE/default setup. That's
        // the "settings don't carry over + the whole UI reloads" bug. Staying
        // on the SPA keeps the connection (and the wizard values) intact; the
        // route guard mounts HiderPage/SeekerPage by role (HiderPage is
        // lazy-loaded, so the welcome chunk isn't meaningfully co-bundled).
        navigate(role === "hider" ? "/h" : "/", {
            replace: true,
        });
    };

    // Abort the join from the lobby preview — disconnect, clear
    // the role/session/code bits, return to intro so the user can
    // pick a different code or start fresh.
    const handleAbortJoin = () => {
        leaveGame();
        playerRole.set(null);
        setMode("intro");
    };

    return (
        <div
            className={cn(
                // v472: force dark on the landing regardless of the app
                // theme — the box / rulebook art is dark navy, so the
                // first screen should always match it. `dark` scopes the
                // dark CSS vars to this subtree (Tailwind darkMode:class).
                "dark",
                "fixed inset-0 z-0 flex justify-center",
                "bg-jetlag text-[hsl(var(--sidebar-foreground))]",
                "overflow-y-auto",
                "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
            )}
            role="dialog"
            aria-modal="true"
            aria-label="Welcome to Hide+Seek"
        >
            {/* Box-cover backdrop — the sun/mountain scene fixed to the
                whole viewport (intro only), sized per the box spec: sun Ø
                = a third of the width, the mountain's apex at the sun's
                centre, its base the full bottom edge. Sits behind the
                content; the footer text rides on top of the mountain. */}
            {mode === "intro" && (
                <HideSeekScene className="pointer-events-none fixed inset-0 z-0" />
            )}
            <div className="relative z-10 w-full sm:max-w-md flex flex-col p-0 gap-0">
                {/* Hero — echoes the box-face cover: the official Jet Lag:
                    The Game lockup with the Hide+Seek wordmark stacked
                    tightly beneath it (as on the box). In intro mode only
                    the blurb + buttons drop into the centred band below;
                    the join/lobby modes also show the compact mark here. */}
                <div
                    className={cn(
                        "px-6 pt-8 flex flex-col items-center text-center gap-8 shrink-0",
                        mode === "intro" ? "pb-0" : "pb-6",
                    )}
                >
                    <img
                        src="/jetlag-logo.svg"
                        alt="Jet Lag: The Game"
                        /* The plane badge sits left of the SVG's
                           geometric centre because the "THE GAME" tag adds
                           width on the right. Nudge right (3% — tuned by
                           eye) so the plane — not the bounding box — is
                           centred over the Hide+Seek mark below it. */
                        className="h-12 w-auto max-w-[70%] translate-x-[3%]"
                    />
                    {mode !== "intro" && <HideSeekMark size={64} />}
                    <HideSeekWordmark boxLayout size="2xl" />
                </div>

                {mode === "intro" ? (
                    <>
                        {/* Blurb + CTAs sit just under the wordmark with
                            reasonable spacing; the sun reserve below uses
                            mt-auto to stay pinned at the bottom. */}
                        <div className="px-6 pt-8 flex flex-col items-center text-center gap-6">
                            <p className="text-sm leading-relaxed text-current/85">
                                A real-time companion app for playing Jet Lag:
                                The Game's Hide+Seek in your own city — on your
                                phones, across your local transit network.
                            </p>
                            <div className="w-full flex flex-col gap-2">
                                <Button
                                    size="lg"
                                    className="w-full font-display font-extrabold uppercase tracking-[0.02em]"
                                    onClick={handleStartNew}
                                >
                                    Create game
                                </Button>
                                <Button
                                    size="lg"
                                    variant="outline"
                                    className="w-full font-display font-extrabold uppercase tracking-[0.02em]"
                                    onClick={() => setMode("join-form")}
                                >
                                    Join a game
                                </Button>
                                {/* Renders only when installable (Android /
                                    desktop Chrome) or on iOS Safari; hidden
                                    once installed. */}
                                <InstallAppButton />
                            </div>
                        </div>
                    </>
                ) : mode === "join-form" ? (
                    <>
                        <div className="px-6 pb-5 text-sm leading-relaxed text-current/85 space-y-1">
                            <p>
                                Got a code from a friend? Pick a display name
                                so the rest of the game knows who you are,
                                then enter the 6-character code.
                            </p>
                        </div>

                        <div className="px-6 pb-2 space-y-3">
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase tracking-[0.16em] font-inter-tight font-bold text-muted-foreground">
                                    Display name
                                </label>
                                <Input
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={`What others see (e.g. ${castPlaceholder})`}
                                    maxLength={24}
                                    autoFocus
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase tracking-[0.16em] font-inter-tight font-bold text-muted-foreground">
                                    Game code
                                </label>
                                <Input
                                    value={code}
                                    onChange={(e) => setCode(e.target.value)}
                                    placeholder="6 characters"
                                    maxLength={8}
                                    autoCapitalize="characters"
                                    spellCheck={false}
                                    className="font-mono uppercase tracking-[0.2em]"
                                    onKeyDown={(e) => {
                                        if (
                                            e.key === "Enter" &&
                                            canContinue
                                        ) {
                                            e.preventDefault();
                                            handleContinueToLobby();
                                        }
                                    }}
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    Letters and digits only. Case-insensitive.
                                </p>
                            </div>
                        </div>

                        <div className="px-6 pb-7 pt-4 flex gap-2">
                            <Button
                                variant="ghost"
                                className="flex-1"
                                onClick={() => setMode("intro")}
                            >
                                Back
                            </Button>
                            <Button
                                className="flex-1 font-display font-extrabold uppercase tracking-[0.02em]"
                                onClick={handleContinueToLobby}
                                disabled={!canContinue}
                            >
                                Continue
                            </Button>
                        </div>
                    </>
                ) : (
                    /* mode === "join-lobby" — connected with role=null,
                       roster has populated, user picks role from the
                       informed set of available options. */
                    <>
                        <div className="px-6 pb-3 text-sm leading-relaxed text-current/85 space-y-1">
                            <p>
                                <span className="font-semibold text-white">
                                    {$code ?? trimmedCode}
                                </span>{" "}
                                — pick the role you want. The Hider seat
                                only holds one player; everyone else
                                joins as a Seeker or Co-hider.
                            </p>
                        </div>

                        {/* Connecting / error states. We render the
                            roster underneath as soon as the snapshot
                            arrives even before transport flips to
                            "open" (participants atom populates from
                            the snapshot/presence push). */}
                        {$status !== "open" && (
                            <div className="px-6 pb-3 flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>
                                    {$status === "connecting"
                                        ? "Connecting…"
                                        : $status === "reconnecting"
                                          ? "Reconnecting…"
                                          : $status === "closed"
                                            ? "Disconnected."
                                            : "Working…"}
                                </span>
                            </div>
                        )}
                        {$error && (
                            <div className="mx-6 mb-3 rounded-sm border-2 border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                                {$error.message}
                            </div>
                        )}

                        {/* Roster — participants grouped by role.
                            Surfaces "Hider — Dana" so the joiner
                            knows whose hide they'd be helping if
                            they pick co-hider. */}
                        <div className="px-6 pb-4 space-y-2">
                            <RosterGroup
                                label={`Seekers · ${seekers.length}`}
                                tone="seeker"
                                entries={seekers.map((p) => ({
                                    name:
                                        p.displayName || "Anonymous",
                                }))}
                                emptyHint="No seekers yet."
                            />
                            <RosterGroup
                                label={`Team Hiders · ${hiders.length}`}
                                tone="hider"
                                entries={hiders.map((p) => ({
                                    name: p.displayName || "Anonymous",
                                }))}
                                emptyHint="No hiders yet."
                            />
                        </div>

                        {/* Role tiles. v829: any number of players can
                            hide together — no exclusive seat, no co-hider. */}
                        <div className="px-6 pb-2 space-y-2">
                            <label className="text-[10px] uppercase tracking-[0.16em] font-inter-tight font-bold text-muted-foreground block">
                                Your role
                            </label>
                            <button
                                type="button"
                                onClick={() => handlePickRole("seeker")}
                                disabled={$status !== "open"}
                                className={cn(
                                    "w-full flex items-start gap-3 p-3 rounded-sm border-2 text-left",
                                    "bg-secondary border-border",
                                    "transition-colors",
                                    "hover:bg-accent hover:border-primary/50",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    "disabled:opacity-50 disabled:cursor-not-allowed",
                                )}
                            >
                                <Eye className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
                                <div className="flex-1 min-w-0">
                                    <div className="font-display font-extrabold uppercase tracking-[0.06em] text-sm">
                                        Seeker
                                    </div>
                                    <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                                        Asks questions, eliminates regions
                                        on the map, closes in on the hider.
                                    </div>
                                </div>
                            </button>
                            <button
                                type="button"
                                onClick={() => handlePickRole("hider")}
                                disabled={$status !== "open"}
                                className={cn(
                                    "w-full flex items-start gap-3 p-3 rounded-sm border-2 text-left",
                                    "bg-secondary border-border",
                                    "transition-colors",
                                    "hover:bg-accent hover:border-[hsl(var(--accent-yellow))/0.5]",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    "disabled:opacity-50 disabled:cursor-not-allowed",
                                )}
                            >
                                <MapPin
                                    className="w-5 h-5 shrink-0 mt-0.5"
                                    style={{
                                        color: "hsl(var(--accent-yellow))",
                                    }}
                                />
                                <div className="flex-1 min-w-0">
                                    <div className="font-display font-extrabold uppercase tracking-[0.06em] text-sm">
                                        Hider
                                    </div>
                                    <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                                        Answers the seekers' questions and
                                        plays the deck of hider cards. Team
                                        up — multiple players can hide
                                        together.
                                    </div>
                                </div>
                            </button>
                        </div>

                        <div className="px-6 pb-7 pt-2 flex gap-2">
                            <Button
                                variant="ghost"
                                className="flex-1"
                                onClick={handleAbortJoin}
                            >
                                Leave room
                            </Button>
                        </div>
                    </>
                )}

                {/* Footer — a single link supporting the real game (the
                    fan-made disclaimer was removed in v560). In intro mode
                    it sits inside a bottom RESERVE whose height matches the
                    sun band, so the centred middle above stops exactly at
                    the sun's top edge and the link rides on the mountain;
                    the join / lobby modes keep the opaque sticky panel so
                    it reads over scrolling content.

                    Reserve height mirrors HideSeekScene's geometry: apex
                    height D = (ew/2)/tan(40°) plus sun radius r =
                    (ew/6)·1.25 ≈ 0.804·ew, ew = min(100vw, 560px). Keep
                    this factor in sync with HideSeekScene. */}
                {mode === "intro" ? (
                    <div
                        className="relative shrink-0 z-10 mt-auto"
                        style={{ height: "calc(min(100vw, 560px) * 0.804)" }}
                    >
                        <div className="absolute inset-x-0 bottom-0 px-6 pt-4 pb-8 text-center">
                            <a
                                href="https://store.nebula.tv/products/jet-lag-the-game-hide-and-seek-transit-game"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block text-xs font-semibold text-white drop-shadow hover:underline"
                            >
                                Buy the official Hide+Seek box from Nebula →
                            </a>
                        </div>
                    </div>
                ) : (
                    <div className="mt-auto sticky bottom-0 z-10 px-6 pt-4 pb-8 text-center bg-jetlag border-t border-border/40">
                        <a
                            href="https://store.nebula.tv/products/jet-lag-the-game-hide-and-seek-transit-game"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-block text-xs font-semibold text-jetlag-yellow hover:underline"
                        >
                            Buy the official Hide+Seek box from Nebula →
                        </a>
                    </div>
                )}
            </div>
        </div>
    );
}

function RosterGroup({
    label,
    tone,
    entries,
    emptyHint,
}: {
    label: string;
    tone: "seeker" | "hider";
    entries: { name: string; badge?: string }[];
    emptyHint: string;
}) {
    const dotColor =
        tone === "seeker"
            ? "bg-primary"
            : "bg-accent-yellow";
    return (
        <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 space-y-1">
            <div className="flex items-center gap-1.5">
                <span
                    className={cn(
                        "inline-block w-2 h-2 rounded-full shrink-0",
                        dotColor,
                    )}
                    aria-hidden
                />
                <span className="text-[10px] uppercase tracking-[0.12em] font-display font-extrabold text-muted-foreground">
                    {label}
                </span>
            </div>
            {entries.length > 0 ? (
                <ul className="text-xs text-current/85 leading-snug pl-3.5 space-y-0.5">
                    {entries.map((e, i) => (
                        <li
                            key={`${e.name}-${i}`}
                            className="flex items-center gap-1.5"
                        >
                            <span>{e.name}</span>
                            {e.badge && (
                                <span
                                    className={cn(
                                        "text-[9px] font-display font-extrabold uppercase tracking-[0.10em]",
                                        "rounded-[3px] px-1 py-[1px] leading-none",
                                        "bg-accent-yellow text-[hsl(var(--sidebar-background))]",
                                    )}
                                >
                                    {e.badge}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            ) : emptyHint ? (
                <div className="text-[11px] text-muted-foreground italic leading-snug pl-3.5">
                    {emptyHint}
                </div>
            ) : null}
        </div>
    );
}

export default Welcome;
