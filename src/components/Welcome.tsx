import { useStore } from "@nanostores/react";
import { Loader2 } from "lucide-react";
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
import { joinAsGuest } from "@/lib/multiplayer/store";
import {
    displayName as displayNameAtom,
    multiplayerError,
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

    const [mode, setMode] = useState<"intro" | "join">("intro");
    const [name, setName] = useState(displayNameAtom.get() || "");
    const [code, setCode] = useState("");
    const [joining, setJoining] = useState(false);

    const open = !$welcomeSeen;

    const trimmedName = name.trim();
    const trimmedCode = code.trim().toUpperCase();
    const validCode = /^[A-Z0-9]{4,8}$/.test(trimmedCode);
    const canJoin = trimmedName.length > 0 && validCode && !joining;

    const handleStartNew = () => {
        welcomeSeen.set(true);
        // GameSetupDialog has a reactive auto-open effect tied to
        // welcomeSeen + setupCompleted — flipping welcomeSeen here is
        // enough; we don't need to set setupDialogOpen manually.
        // (Set it anyway as a belt-and-braces in case the effect runs
        // before this paint frame.)
        if (!setupCompleted.get()) setupDialogOpen.set(true);
    };

    const handleJoin = () => {
        if (!canJoin) return;
        setJoining(true);
        displayNameAtom.set(trimmedName);
        joinAsGuest(trimmedCode, trimmedName);
        // joinAsGuest is fire-and-forget; the transport status atom
        // flips through connecting → open (success) or closed/error.
        // We close the welcome screen optimistically — if the join
        // fails, the toast surfaced by the multiplayer error atom +
        // the host's reconcile flow will steer the user, and they can
        // re-open the setup wizard from the Settings sheet.
        welcomeSeen.set(true);
        setupCompleted.set(true);
        toast.info(`Joining game ${trimmedCode}…`, { autoClose: 2500 });
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
                                onClick={() => setMode("join")}
                            >
                                Join a game
                            </Button>
                        </div>
                    </>
                ) : (
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

                            {joining &&
                                $status !== "open" &&
                                $status !== "closed" && (
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
                        </div>

                        <div className="px-6 pb-7 pt-4 flex gap-2">
                            <Button
                                variant="ghost"
                                className="flex-1"
                                onClick={() => setMode("intro")}
                                disabled={joining}
                            >
                                Back
                            </Button>
                            <Button
                                className="flex-1 font-display font-extrabold uppercase tracking-[0.02em]"
                                onClick={handleJoin}
                                disabled={!canJoin}
                            >
                                {joining && (
                                    <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                                )}
                                Join game
                            </Button>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

export default Welcome;
