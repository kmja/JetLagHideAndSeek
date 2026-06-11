import { useStore } from "@nanostores/react";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { InvitePanel } from "@/components/multiplayer/InviteSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    currentGameCode,
    demoMode,
    displayName as displayNameAtom,
    multiplayerError,
    pickRandomCastName,
    transportStatus,
} from "@/lib/multiplayer/session";
import { startDemoGame } from "@/lib/multiplayer/demoBroker";
import {
    createGame,
    joinAsGuest,
    joinAsHost,
} from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

/**
 * Embedded host/join + invite UI for use INSIDE another Dialog
 * (e.g. the Game Settings panel). This component does not own a
 * Dialog wrapper — it just renders the controls inline and can be
 * dropped into any container.
 *
 * Behavior:
 *  - When already in a room: shows `InvitePanel` (code + participants
 *    + share + leave).
 *  - When offline: shows a mode toggle (Host / Join), a display name
 *    field, and a code input (for Join). Host kicks off
 *    `createGame()` then `joinAsHost(code, name)`.
 *
 * The display name persists to `displayNameAtom` so subsequent runs
 * remember it.
 */
export function OnlinePlaySection() {
    const $code = useStore(currentGameCode);
    const $status = useStore(transportStatus);
    const $displayName = useStore(displayNameAtom);
    const $error = useStore(multiplayerError);

    const [mode, setMode] = useState<"host" | "join">("host");
    const [name, setName] = useState($displayName || "");
    const [code, setCode] = useState("");
    const [busyHost, setBusyHost] = useState(false);
    const [acted, setActed] = useState(false);

    // Fun rotating placeholder pulled from the Jet Lag cast. Resolved
    // once per mount so the hint doesn't churn on every keystroke.
    const [castPlaceholder] = useState(() => pickRandomCastName());

    // Persist display-name edits so the user only types it once.
    useEffect(() => {
        const trimmed = name.trim();
        if (trimmed) displayNameAtom.set(trimmed);
    }, [name]);

    // Clear any previous error when the section first mounts.
    useEffect(() => {
        multiplayerError.set(null);
    }, []);

    const trimmedName = name.trim();
    const trimmedCode = code.trim().toUpperCase();
    const validCode = /^[A-Z0-9]{4,8}$/.test(trimmedCode);
    const canHost = trimmedName.length > 0 && !busyHost;
    const canJoin = trimmedName.length > 0 && validCode;

    const handleHost = async () => {
        setBusyHost(true);
        setActed(true);
        try {
            const newCode = await createGame();
            joinAsHost(newCode, trimmedName);
            // No "Hosting game X" toast — the InvitePanel that
            // replaces this card after a successful host already
            // shows the code prominently, so the toast is redundant
            // noise. (Matches the same hygiene pass that dropped the
            // wizard's room-creation toast.)
        } catch (e) {
            toast.error(
                e instanceof Error
                    ? `Couldn't host: ${e.message}`
                    : "Couldn't host the game.",
            );
            setActed(false);
        } finally {
            setBusyHost(false);
        }
    };

    const handleJoin = () => {
        if (!validCode) return;
        setActed(true);
        joinAsGuest(trimmedCode, trimmedName);
    };

    const handleDemo = (asRole: "seeker" | "hider") => {
        setActed(true);
        startDemoGame({
            asRole,
            userName: trimmedName || "You",
        });
        toast.info(
            asRole === "seeker"
                ? "Demo game: bot hider will auto-answer your questions and cast curses."
                : "Demo game: bot seekers will ping locations and ask questions.",
            { autoClose: 4000 },
        );
    };

    // Already connected to a room → show the live invite panel.
    if ($code) {
        return (
            <div
                className={cn(
                    "rounded-md border border-border bg-secondary/40",
                    "px-3 py-3",
                )}
            >
                <InvitePanel />
            </div>
        );
    }

    // Offline → show inline host/join controls.
    return (
        <div className="space-y-3">
            <p className="text-xs text-muted-foreground leading-snug">
                One device hosts; everyone else joins with the 6-character
                code. Up to 4 seekers + 1 hider.
            </p>

            <div className="flex gap-1.5 text-xs">
                <button
                    type="button"
                    onClick={() => setMode("host")}
                    className={cn(
                        "flex-1 px-3 py-1.5 rounded-sm font-poppins font-semibold",
                        "transition-colors",
                        mode === "host"
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-foreground hover:bg-accent",
                    )}
                >
                    Host a game
                </button>
                <button
                    type="button"
                    onClick={() => setMode("join")}
                    className={cn(
                        "flex-1 px-3 py-1.5 rounded-sm font-poppins font-semibold",
                        "transition-colors",
                        mode === "join"
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-foreground hover:bg-accent",
                    )}
                >
                    Join a game
                </button>
            </div>

            <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                    Display name
                </label>
                <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={`What others see (e.g. ${castPlaceholder})`}
                    maxLength={24}
                />
            </div>

            {mode === "join" && (
                <div className="space-y-1.5">
                    <label className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
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
                            if (e.key === "Enter" && canJoin) {
                                e.preventDefault();
                                handleJoin();
                            }
                        }}
                    />
                    <p className="text-[10px] text-muted-foreground">
                        Letters and digits only. Case-insensitive.
                    </p>
                </div>
            )}

            {acted && $status !== "open" && $status !== "closed" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>
                        {$status === "connecting"
                            ? "Connecting…"
                            : $status === "reconnecting"
                              ? "Reconnecting…"
                              : "Working…"}
                    </span>
                </div>
            )}

            {$error && (
                <div className="rounded-sm border-2 border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {$error.message}
                </div>
            )}

            <div className="flex justify-end">
                {mode === "host" ? (
                    <Button
                        onClick={handleHost}
                        disabled={!canHost}
                        size="sm"
                        className="gap-1.5"
                    >
                        {busyHost && (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        )}
                        Host new game
                    </Button>
                ) : (
                    <Button
                        onClick={handleJoin}
                        disabled={!canJoin}
                        size="sm"
                        className="gap-1.5"
                    >
                        Join game
                    </Button>
                )}
            </div>

            <div className="border-t border-border/60 pt-3 space-y-2">
                <div>
                    <p className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                        Demo mode (testing)
                    </p>
                    <p className="text-xs text-muted-foreground leading-snug mt-1">
                        Spin up a fake room with bot peers — answer your
                        questions, send location pings, cast curses. No
                        second device needed.
                    </p>
                </div>
                <div className="flex gap-1.5">
                    <Button
                        type="button"
                        onClick={() => handleDemo("seeker")}
                        size="sm"
                        variant="outline"
                        className="flex-1 h-8 text-xs"
                    >
                        Play as seeker
                    </Button>
                    <Button
                        type="button"
                        onClick={() => handleDemo("hider")}
                        size="sm"
                        variant="outline"
                        className="flex-1 h-8 text-xs"
                    >
                        Play as hider
                    </Button>
                </div>
            </div>
        </div>
    );
}

export default OnlinePlaySection;
