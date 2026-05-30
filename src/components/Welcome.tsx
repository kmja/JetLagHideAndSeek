import { useStore } from "@nanostores/react";
import { Eye, Loader2, MapPin, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "react-toastify";

import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setupCompleted, setupDialogOpen, welcomeSeen } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import {
    joinAsGuest,
    leaveGame,
    setOnlineRole,
} from "@/lib/multiplayer/store";
import {
    currentGameCode,
    displayName as displayNameAtom,
    multiplayerError,
    participants as participantsAtom,
    transportStatus,
} from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

import { HideSeekMark, HideSeekWordmark } from "./JetLagLogo";

/**
 * First-load welcome screen. Shown when `welcomeSeen` is false,
 * regardless of `setupCompleted`. Two paths out:
 *
 *  - "Start new game"  → flips `welcomeSeen=true` and lets
 *    GameSetupDialog take over (its own auto-open kicks in once
 *    `welcomeSeen` flips).
 *  - "Join a game"     → inline display-name + code form; on join we
 *    flip `welcomeSeen=true` and `setupCompleted=true` so the wizard
 *    doesn't pop on top of the guest (the host pushes setup via the
 *    multiplayer transport instead).
 *
 * The dialog has no close button — first-loaders must pick a path.
 * Returning users (welcomeSeen=true) never see it.
 */
export function Welcome() {
    const $welcomeSeen = useStore(welcomeSeen);
    const $status = useStore(transportStatus);
    const $error = useStore(multiplayerError);
    const $code = useStore(currentGameCode);
    const $participants = useStore(participantsAtom);

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

    const open = !$welcomeSeen;

    const trimmedName = name.trim();
    const trimmedCode = code.trim().toUpperCase();
    const validCode = /^[A-Z0-9]{4,8}$/.test(trimmedCode);
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
        // GameSetupDialog has a reactive auto-open effect tied to
        // welcomeSeen + setupCompleted — flipping welcomeSeen here is
        // enough; we don't need to set setupDialogOpen manually.
        // (Set it anyway as a belt-and-braces in case the effect runs
        // before this paint frame.)
        if (!setupCompleted.get()) setupDialogOpen.set(true);
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
            window.location.assign("/h");
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
        <Dialog
            open={open}
            // The welcome screen cannot be dismissed by clicking
            // outside or pressing Esc — first-loaders must pick a
            // path. Returning users (welcomeSeen=true) never see this.
            onOpenChange={() => {
                /* no-op */
            }}
        >
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0 max-h-[92vh] sm:max-w-md",
                )}
                // Hide the default radix close X — no escape hatch.
                closeIcon={false}
            >
                {/* Hero — echoes the box-face cover */}
                <div className="px-6 pt-8 pb-6 flex flex-col items-center text-center gap-4">
                    <HideSeekMark size={72} onDark />
                    <HideSeekWordmark boxLayout size="xl" />
                    <DialogTitle className="sr-only">
                        Welcome to Hide+Seek
                    </DialogTitle>
                </div>

                {mode === "intro" ? (
                    <>
                        <div className="px-6 pb-5 text-sm leading-relaxed text-slate-200 space-y-2">
                            <p>
                                A seeker's map-elimination companion for the
                                Jet Lag: The Game board game.
                            </p>
                            <p>
                                One player hides on public transit. The rest
                                ask questions to narrow them down — radius,
                                thermometer, matching, measuring, tentacles —
                                and rule the map out region by region until
                                only the hider's spot is left.
                            </p>
                            <p className="text-slate-300/80">
                                Whoever hides the longest wins.
                            </p>
                        </div>

                        <div className="px-6 pb-7 flex flex-col gap-2">
                            <Button
                                size="lg"
                                className="w-full font-display font-extrabold uppercase tracking-[0.02em]"
                                onClick={handleStartNew}
                            >
                                Start new game
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
                        <div className="px-6 pb-5 text-sm leading-relaxed text-slate-200 space-y-1">
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
                                    placeholder="What others see (e.g. Kalle)"
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
                        <div className="px-6 pb-3 text-sm leading-relaxed text-slate-200 space-y-1">
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
                                names={seekers.map(
                                    (p) =>
                                        p.displayName || "Anonymous",
                                )}
                                emptyHint="No seekers yet."
                            />
                            <RosterGroup
                                label={
                                    hider
                                        ? "Hider · 1"
                                        : "Hider · 0"
                                }
                                tone="hider"
                                names={
                                    hider
                                        ? [
                                              hider.displayName ||
                                                  "Anonymous",
                                          ]
                                        : []
                                }
                                emptyHint="No hider yet — the seat is open."
                            />
                            {coHiders.length > 0 && (
                                <RosterGroup
                                    label={`Co-hiders · ${coHiders.length}`}
                                    tone="coHider"
                                    names={coHiders.map(
                                        (p) =>
                                            p.displayName || "Anonymous",
                                    )}
                                    emptyHint=""
                                />
                            )}
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
            </DialogContent>
        </Dialog>
    );
}

function RosterGroup({
    label,
    tone,
    names,
    emptyHint,
}: {
    label: string;
    tone: "seeker" | "hider" | "coHider";
    names: string[];
    emptyHint: string;
}) {
    const dotColor =
        tone === "seeker"
            ? "bg-primary"
            : tone === "hider"
              ? "bg-[hsl(var(--accent-yellow))]"
              : "bg-[hsl(var(--accent-orange))]";
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
            {names.length > 0 ? (
                <div className="text-xs text-slate-200 leading-snug pl-3.5">
                    {names.join(", ")}
                </div>
            ) : emptyHint ? (
                <div className="text-[11px] text-muted-foreground italic leading-snug pl-3.5">
                    {emptyHint}
                </div>
            ) : null}
        </div>
    );
}

export default Welcome;
