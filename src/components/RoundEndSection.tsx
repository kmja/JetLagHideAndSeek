import { useStore } from "@nanostores/react";
import { Copy, Share2, Sparkles, Trophy } from "lucide-react";
import { useState } from "react";
import { toast } from "react-toastify";

import { appConfirm } from "@/lib/confirm";
import { copyFoundLink, shareFoundLink } from "@/lib/foundShare";
import { hidingPeriodEndsAt, setupCompleted } from "@/lib/gameSetup";
import { roundFoundAt } from "@/lib/hiderRole";
import {
    currentGameCode,
    multiplayerEnabled,
    participants,
} from "@/lib/multiplayer/session";
import { seekerRotateHider } from "@/lib/multiplayer/store";
import { startNewGame, startNewRound } from "@/lib/roundActions";

import { RotateHiderDialog } from "./multiplayer/RotateHiderDialog";
import { Button } from "./ui/button";

/**
 * Round-end recap card. Used by the lobby drawer's mid-game branch
 * to surface the seek-time, share/copy controls, and the
 * "New round" / "New game" actions once the seeker has marked the
 * hider found.
 *
 * Self-contained: owns its rotate-hider dialog state, so callers
 * just render `<RoundEndSection />` and it does the right thing —
 * silent when the round isn't over, full recap card when it is.
 *
 * v270: lifted out of BottomNav.tsx when the standalone "Game"
 * drawer was retired. The lobby is now the canonical post-found
 * surface, since it already owns the roster + room code context the
 * recap belongs next to.
 */
export function RoundEndSection() {
    const $foundAt = useStore(roundFoundAt);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $setupCompleted = useStore(setupCompleted);
    const $mp = useStore(multiplayerEnabled);
    const $code = useStore(currentGameCode);
    const $participants = useStore(participants);

    const [rotateDialogOpen, setRotateDialogOpen] = useState(false);

    if (!$setupCompleted || !$foundAt || !$hidingEndsAt) return null;

    // In an online game with ≥2 participants, "New round" opens the
    // hider-rotation picker so the next round can have a different
    // hider. Solo / offline takes the confirm()-only fast path.
    const canRotateHider =
        $mp && $code !== null && $participants.length >= 2;

    const handleNewRound = async () => {
        if (canRotateHider) {
            setRotateDialogOpen(true);
            return;
        }
        const ok = await appConfirm({
            title: "Start a new round?",
            description:
                "Question log, hider hand, hiding zone and spot will all reset. Play area + transit + size stay the same.",
            confirmLabel: "New round",
        });
        if (!ok) return;
        startNewRound();
        toast.success("New round — hiding period starting now.", {
            autoClose: 2500,
        });
    };

    const handleConfirmRotation = (newHiderId: string) => {
        seekerRotateHider(newHiderId);
        startNewRound();
        setRotateDialogOpen(false);
        toast.success("New round — hiding period starting now.", {
            autoClose: 2500,
        });
    };

    const handleNewGame = async () => {
        const ok = await appConfirm({
            title: "Start a new game?",
            description:
                "This drops the play area, transit modes, and size — the setup wizard will re-open.",
            confirmLabel: "New game",
            destructive: true,
        });
        if (!ok) return;
        startNewGame();
    };

    return (
        <>
            <FoundSummary
                foundAt={$foundAt}
                hidingEndsAt={$hidingEndsAt}
                onShareAgain={() => void shareFoundLink($foundAt)}
                onCopyLink={() => void copyFoundLink($foundAt)}
                onNewRound={handleNewRound}
                onNewGame={handleNewGame}
            />
            <RotateHiderDialog
                open={rotateDialogOpen}
                onOpenChange={setRotateDialogOpen}
                onConfirm={handleConfirmRotation}
            />
        </>
    );
}

function FoundSummary({
    foundAt,
    hidingEndsAt,
    onShareAgain,
    onCopyLink,
    onNewRound,
    onNewGame,
}: {
    foundAt: number;
    hidingEndsAt: number;
    onShareAgain: () => void;
    onCopyLink: () => void;
    onNewRound: () => void;
    onNewGame: () => void;
}) {
    const elapsedMs = Math.max(0, foundAt - hidingEndsAt);
    const totalSec = Math.floor(elapsedMs / 1000);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const elapsed =
        hh > 0
            ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
            : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

    return (
        <div className="rounded-sm border-2 border-primary bg-primary/5 px-4 py-3 animate-in fade-in slide-in-from-top-1 duration-300">
            <div className="flex items-start gap-3">
                <Trophy className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-inter-tight font-bold uppercase tracking-[0.16em]">
                        Round ended
                    </div>
                    <div className="font-inter-tight italic font-black tabular-nums text-3xl text-primary leading-none mt-1">
                        {elapsed}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug mt-1">
                        Seek time from end of hiding period. The hider's
                        hand time-bonus minutes get subtracted from this to
                        get the final score.
                    </p>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3">
                <Button
                    variant="outline"
                    onClick={onShareAgain}
                    className="gap-1.5"
                >
                    <Share2 className="w-4 h-4" />
                    Share again
                </Button>
                <Button
                    variant="outline"
                    onClick={onCopyLink}
                    className="gap-1.5"
                >
                    <Copy className="w-4 h-4" />
                    Copy link
                </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
                <Button onClick={onNewRound} className="gap-1.5">
                    <Sparkles className="w-4 h-4" />
                    New round
                </Button>
                <Button variant="outline" onClick={onNewGame}>
                    New game
                </Button>
            </div>
        </div>
    );
}

export default RoundEndSection;
