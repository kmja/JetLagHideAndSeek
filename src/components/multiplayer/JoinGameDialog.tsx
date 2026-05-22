import { useStore } from "@nanostores/react";
import { Loader2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
    createGame,
    joinAsGuest,
    joinAsHost,
} from "@/lib/multiplayer/store";
import {
    currentGameCode,
    displayName as displayNameAtom,
    multiplayerError,
    transportStatus,
} from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * Unified host/join dialog. Two tabs: "Host a game" (creates a new
 * room, surfaces the code so the host can share it) and "Join a
 * game" (enter a 6-char code). Display name input is shared between
 * the tabs.
 *
 * On successful connect this dialog closes; the rest of the UI (the
 * presence chip in the BottomNav, the GameSetupDialog wizard) takes
 * over from there.
 */
export function JoinGameDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
}) {
    const $displayName = useStore(displayNameAtom);
    const $status = useStore(transportStatus);
    const $code = useStore(currentGameCode);
    const $error = useStore(multiplayerError);

    const [mode, setMode] = useState<"host" | "join">("host");
    const [name, setName] = useState($displayName || "");
    const [code, setCode] = useState("");
    const [busyHost, setBusyHost] = useState(false);
    /** Suppresses auto-close until the user has actually acted —
     *  otherwise a stale "open" status from a previous session
     *  would close the dialog the moment it mounts. */
    const [acted, setActed] = useState(false);

    useEffect(() => {
        if (open) {
            setName(displayNameAtom.get() || "");
            setCode("");
            setActed(false);
            multiplayerError.set(null);
        }
    }, [open]);

    // Close on successful connect once the user has explicitly acted.
    useEffect(() => {
        if (acted && $status === "open" && $code) {
            onOpenChange(false);
        }
    }, [acted, $status, $code, onOpenChange]);

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
            toast.success(`Hosting game ${newCode}.`, { autoClose: 2500 });
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

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0",
                    "max-h-[85vh]",
                )}
            >
                <div className="px-6 pt-5 pb-3 shrink-0 border-b border-border flex items-start gap-3">
                    <span className="inline-flex items-center justify-center w-9 h-9 rounded shrink-0 bg-primary/15 mt-0.5">
                        <Users className="w-4 h-4 text-primary" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Multiplayer
                        </div>
                        <DialogTitle className="font-inter-tight font-black uppercase text-lg tracking-tight leading-tight mt-1">
                            Play with friends
                        </DialogTitle>
                        <DialogDescription className="text-xs mt-1.5 text-muted-foreground">
                            One person hosts; everyone else joins with
                            the 6-character code.
                        </DialogDescription>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-4">
                    {/* Mode switcher */}
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

                    {/* Display name (always visible) */}
                    <div className="space-y-1.5">
                        <label className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Display name
                        </label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="What others see (e.g. Kalle)"
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
                                Letters and digits only. Codes are
                                case-insensitive.
                            </p>
                        </div>
                    )}

                    {mode === "host" && (
                        <p className="text-xs text-muted-foreground leading-snug">
                            Creating a game gives you a 6-character code
                            to share. Up to 4 friends can join.
                        </p>
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
                        <div className="rounded-sm border-2 border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive space-y-1">
                            <div>{$error.message}</div>
                            {/* "Report an issue" link — only surfaces
                                on `internal` / unexpected errors, not
                                on user-fixable ones like room_full or
                                version_mismatch where it'd be noise. */}
                            {($error.code === "internal" ||
                                $error.code === "unknown_room") && (
                                <a
                                    href="https://github.com/kmja/JetLagHideAndSeek/issues/new"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={cn(
                                        "inline-block underline text-[10px] uppercase tracking-wider font-poppins font-bold",
                                        "hover:no-underline",
                                    )}
                                >
                                    Report an issue
                                </a>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-end">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    {mode === "host" ? (
                        <Button
                            onClick={handleHost}
                            disabled={!canHost}
                            className="gap-1.5"
                        >
                            {busyHost && (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            )}
                            Host
                        </Button>
                    ) : (
                        <Button
                            onClick={handleJoin}
                            disabled={!canJoin}
                            className="gap-1.5"
                        >
                            Join
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default JoinGameDialog;
