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
    const coHiders = $participants.filter((p) => p.role === "coHider");
    const hiderTaken = Boolean(hider);

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
    const handlePickRole = (role: "seeker" | "hider" | "coHider") => {
        playerRole.set(role);
        if (role !== "coHider") {
            // Server only knows seeker / hider / null — co-hider
            // is a client-only concept layered on top of the
            // hider role.
            setOnlineRole(role);
        }
        welcomeSeen.set(true);
        setupCompleted.set(true);
        if (
            (role === "hider" || role === "coHider") &&
            typeof window !== "undefined"
        ) {
            // Hard navigation so the hider bundle replaces the welcome
            // shell — keeps the welcome chunk out of the hider's tab.
            window.location.assign("/h");
        } else {
            // Seekers stay on the SPA — soft-navigate to / so the
            // route guard mounts SeekerPage now that both gates pass.
            navigate("/", { replace: true });
        }
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
                {/* Hero — echoes the box-face cover. Official Jet Lag:
                    The Game lockup sits above the Hide+Seek wordmark. In
                    intro mode the big sun/mountain mark moves to a
                    full-width band at the BOTTOM (see the scene below),
                    exactly like the physical box; the join/lobby modes
                    keep a compact mark up here instead since their
                    content fills the lower half. */}
                <div className="px-6 pt-8 pb-6 flex flex-col items-center text-center gap-4">
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
                    <HideSeekWordmark boxLayout size="xl" />
                </div>

                {mode === "intro" ? (
                    <>
                        <div className="px-6 pb-5 text-sm leading-relaxed text-current/85 space-y-2">
                            <p>
                                A real-time companion app for playing Jet Lag:
                                The Game's Hide+Seek in your own city — on your
                                phones, across your local transit network.
                            </p>
                        </div>

                        <div className="px-6 pb-7 flex flex-col gap-2">
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
                                label={`Team Hiders · ${hider ? 1 + coHiders.length : coHiders.length}`}
                                tone="hider"
                                entries={[
                                    ...(hider
                                        ? [
                                              {
                                                  name:
                                                      hider.displayName ||
                                                      "Anonymous",
                                                  badge: "MAIN",
                                              },
                                          ]
                                        : []),
                                    ...coHiders.map((p) => ({
                                        name:
                                            p.displayName ||
                                            "Anonymous",
                                    })),
                                ]}
                                emptyHint="No hiders yet — the seat is open."
                            />
                        </div>

                        {/* Role tiles. Hider is disabled when the
                            seat is taken; Co-hider only shows when a
                            hider exists (it's a layered role on top
                            of the hider's view). */}
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
                                disabled={
                                    hiderTaken || $status !== "open"
                                }
                                className={cn(
                                    "w-full flex items-start gap-3 p-3 rounded-sm border-2 text-left",
                                    "bg-secondary border-border",
                                    "transition-colors",
                                    hiderTaken
                                        ? "opacity-50 cursor-not-allowed"
                                        : "hover:bg-accent hover:border-[hsl(var(--accent-yellow))/0.5]",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                                        manages the deck of hider cards.
                                        One per game.
                                    </div>
                                    {hiderTaken && (
                                        <div className="text-[11px] text-destructive font-semibold mt-1">
                                            Taken by{" "}
                                            {hider?.displayName ||
                                                "another player"}{" "}
                                            — join as a Co-hider instead.
                                        </div>
                                    )}
                                </div>
                            </button>
                            {hiderTaken && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        handlePickRole("coHider")
                                    }
                                    disabled={$status !== "open"}
                                    className={cn(
                                        "w-full flex items-start gap-3 p-3 rounded-sm border-2 text-left",
                                        "bg-secondary border-border",
                                        "transition-colors",
                                        "hover:bg-accent hover:border-primary/40",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        "disabled:opacity-50 disabled:cursor-not-allowed",
                                    )}
                                >
                                    <Users className="w-5 h-5 shrink-0 mt-0.5 text-muted-foreground" />
                                    <div className="flex-1 min-w-0">
                                        <div className="font-display font-extrabold uppercase tracking-[0.06em] text-sm">
                                            Co-hider
                                        </div>
                                        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                                            Joins the hide with{" "}
                                            {hider?.displayName ||
                                                "the hider"}
                                            . View-only — you see the
                                            hider's view live (zone,
                                            incoming questions, deck)
                                            but they answer and play
                                            the cards.
                                        </div>
                                    </div>
                                </button>
                            )}
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

                {/* Footer — support the real game + unofficial disclaimer.
                    In intro mode it rides on top of the mountain (no
                    background, light text for contrast on the red); in the
                    join / lobby modes it keeps the opaque sticky panel so
                    it reads over scrolling content. `mt-auto` drops it to
                    the bottom of the viewport either way. */}
                <div
                    className={cn(
                        "mt-auto px-6 pt-4 pb-8 text-center space-y-2.5",
                        mode === "intro"
                            ? "relative z-10"
                            : "sticky bottom-0 z-10 bg-jetlag border-t border-border/40",
                    )}
                >
                    <a
                        href="https://store.nebula.tv/products/jet-lag-the-game-hide-and-seek-transit-game"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            "inline-block text-xs font-semibold hover:underline",
                            mode === "intro"
                                ? "text-white drop-shadow"
                                : "text-jetlag-yellow",
                        )}
                    >
                        Love it? Buy the official Hide+Seek box from Nebula →
                    </a>
                    <p
                        className={cn(
                            "text-[10px] leading-snug",
                            mode === "intro"
                                ? "text-white/85 drop-shadow"
                                : "text-current/40",
                        )}
                    >
                        This is a free, unofficial fan-made companion. Not
                        affiliated with or endorsed by Jet Lag: The Game or
                        Nebula. Please support the creators by buying the
                        physical game.
                    </p>
                </div>
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
            : "bg-[hsl(var(--accent-yellow))]";
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
                                        "bg-[hsl(var(--accent-yellow))] text-[hsl(var(--sidebar-background))]",
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
