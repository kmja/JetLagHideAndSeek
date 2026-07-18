import { useStore } from "@nanostores/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { setupCompleted, welcomeSeen } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import {
    displayName as displayNameAtom,
    multiplayerError,
    pickRandomCastName,
} from "@/lib/multiplayer/session";
import { joinAsGuest } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

import { InstallAppButton } from "./InstallAppButton";
import { HideSeekScene, HideSeekWordmark } from "./JetLagLogo";

/**
 * First-load welcome screen. v267: was a dialog overlaid on the
 * seeker view; now its own fullsize page mounted at `/welcome` so
 * the seeker shell (sidebars, map, top + bottom nav, drawers) never
 * loads on first launch. The seeker / hider route guards redirect
 * unseen users here; this component reverse-redirects to / once
 * welcome is seen.
 *
 * Two paths out:
 *
 *  - "Create game" → flips `welcomeSeen=true` and navigates to /setup
 *    so the wizard takes over.
 *  - "Join a game" → opens a room-code DIALOG on top of the landing
 *    page (v932); on Continue we connect as a guest with role STILL
 *    NULL, flip `welcomeSeen=true` + `setupCompleted=true`, then
 *    navigate into the game shell. There the SHARED `GameLobbyDialog` +
 *    `RolePicker` open (name + role picker on top of the lobby) — the
 *    EXACT same surface the host lands on (v925). Hosting and joining
 *    share one flow.
 */
export function Welcome() {
    const $welcomeSeen = useStore(welcomeSeen);
    const navigate = useNavigate();

    const [joinOpen, setJoinOpen] = useState(false);
    const [code, setCode] = useState("");
    const [castPlaceholder] = useState(() => pickRandomCastName());

    // v267: the welcome screen is its own /welcome route. Redirect a
    // returning user (welcomeSeen=true) away on mount so they don't see
    // the first-load screen again. v925/v932: also prefill the room code
    // from a shared `?join=CODE` deep link (the route gate preserves the
    // param when it bounces a fresh device to /welcome) and OPEN the join
    // dialog so the user only has to hit Continue.
    useEffect(() => {
        if ($welcomeSeen) {
            navigate("/", { replace: true });
            return;
        }
        const j = new URLSearchParams(window.location.search).get("join");
        if (j) {
            const up = j.trim().toUpperCase();
            if (/^[A-Z0-9]{3,8}$/.test(up)) {
                setCode(up);
                setJoinOpen(true);
            }
        }
    }, [$welcomeSeen, navigate]);

    const trimmedCode = code.trim().toUpperCase();
    // v932: codes are now 3 letters; accept 3–8 so an in-progress game's
    // older/longer code still joins.
    const validCode = /^[A-Z0-9]{3,8}$/.test(trimmedCode);

    const handleStartNew = () => {
        welcomeSeen.set(true);
        // v252: wizard is its own route now. Navigate explicitly so
        // we land on /setup even before the SeekerPage's route guard
        // would catch the (welcomeSeen=true, !setupCompleted) state.
        if (!setupCompleted.get()) navigate("/setup");
    };

    // Join a room, mirroring the HOST flow: connect as a guest with role
    // STILL NULL and mark welcome + setup done, then navigate into the
    // game shell. The shared `GameLobbyDialog` opens with the `RolePicker`
    // (name + role) on top — identical to what the host sees. The display
    // NAME is chosen in that picker (a random cast name seeds the initial
    // presence until then, exactly as it does for the host).
    const handleJoin = () => {
        if (!validCode) return;
        multiplayerError.set(null);
        // Clear any stale local role so the server's null assignment for a
        // fresh joiner isn't overridden — RolePicker only opens on role null.
        playerRole.set(null);
        const name = displayNameAtom.get()?.trim() || castPlaceholder;
        joinAsGuest(trimmedCode, name);
        welcomeSeen.set(true);
        setupCompleted.set(true);
        navigate("/", { replace: true });
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
                whole viewport, sized per the box spec: sun Ø = a third of
                the width, the mountain's apex at the sun's centre, its base
                the full bottom edge. Sits behind the content; the footer
                text rides on top of the mountain. */}
            <HideSeekScene className="pointer-events-none fixed inset-0 z-0" />
            <div className="relative z-10 w-full sm:max-w-md flex flex-col p-0 gap-0">
                {/* Hero — echoes the box-face cover: the official Jet Lag:
                    The Game lockup with the Hide+Seek wordmark stacked
                    tightly beneath it (as on the box). */}
                <div className="px-6 pt-8 pb-0 flex flex-col items-center text-center gap-8 shrink-0">
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
                    <HideSeekWordmark boxLayout size="2xl" />
                </div>

                {/* Blurb + CTAs sit just under the wordmark with reasonable
                    spacing; the sun reserve below uses mt-auto to stay
                    pinned at the bottom. */}
                <div className="px-6 pt-8 flex flex-col items-center text-center gap-6">
                    <p className="text-sm leading-relaxed text-current/85">
                        A real-time companion app for playing Jet Lag: The
                        Game's Hide+Seek in your own city — on your phones,
                        across your local transit network.
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
                            onClick={() => setJoinOpen(true)}
                        >
                            Join a game
                        </Button>
                        {/* Renders only when installable (Android / desktop
                            Chrome) or on iOS Safari; hidden once installed. */}
                        <InstallAppButton />
                    </div>
                </div>

                {/* Footer — a single link supporting the real game. It sits
                    inside a bottom RESERVE whose height matches the sun band,
                    so the centred middle above stops exactly at the sun's top
                    edge and the link rides on the mountain.

                    Reserve height mirrors HideSeekScene's geometry: apex
                    height D = (ew/2)/tan(40°) plus sun radius r =
                    (ew/6)·1.25 ≈ 0.804·ew, ew = min(100vw, 560px). Keep
                    this factor in sync with HideSeekScene. */}
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
            </div>

            {/* Join-a-game code step — a dialog OVER the landing page (v932),
                so the first step reads as a light modal on the box cover
                rather than swapping the whole screen. Continue drops the
                guest into the shared lobby + role picker. */}
            <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
                {/* `dark` scopes the dark CSS vars to the dialog subtree so it
                    matches the always-dark landing (it portals to <body>,
                    outside the landing's own `dark` wrapper). */}
                <DialogContent className="dark max-w-sm rounded-2xl bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]">
                    <DialogTitle className="font-display font-black uppercase tracking-tight text-xl">
                        Join a game
                    </DialogTitle>
                    <DialogDescription className="text-sm text-muted-foreground">
                        Got a code from a friend? Enter the room code and
                        you'll drop into the lobby, where you pick your display
                        name and role.
                    </DialogDescription>

                    <div className="space-y-1.5 pt-1">
                        <label
                            htmlFor="welcome-join-code"
                            className="text-[10px] uppercase tracking-[0.16em] font-inter-tight font-bold text-muted-foreground"
                        >
                            Game code
                        </label>
                        <Input
                            id="welcome-join-code"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder="3 letters"
                            maxLength={8}
                            autoFocus
                            autoCapitalize="characters"
                            spellCheck={false}
                            className="font-mono uppercase tracking-[0.2em]"
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && validCode) {
                                    e.preventDefault();
                                    handleJoin();
                                }
                            }}
                        />
                        <p className="text-[10px] text-muted-foreground">
                            Letters and digits only. Case-insensitive.
                        </p>
                    </div>

                    <div className="flex gap-2 pt-2">
                        <Button
                            variant="ghost"
                            className="flex-1"
                            onClick={() => setJoinOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            className="flex-1 font-display font-extrabold uppercase tracking-[0.02em]"
                            onClick={handleJoin}
                            disabled={!validCode}
                        >
                            Continue
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

export default Welcome;
