import { useStore } from "@nanostores/react";
import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { resumeGame } from "@/lib/gamePause";
import { manualPausedAt } from "@/lib/gameSetup";

/**
 * Full-screen "Game paused" curtain shown while the game is manually
 * paused (rulebook "General Tips"). All in-game clocks are frozen (see
 * `gamePause.ts`); this blocks interaction and shows how long the pause
 * has run, with a single Resume action. Mounted on both the seeker and
 * hider pages so whichever surface is up shows the curtain.
 */
export function GamePausedOverlay() {
    const $pausedAt = useStore(manualPausedAt);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if ($pausedAt == null) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [$pausedAt]);

    if ($pausedAt == null) return null;

    const elapsed = Math.max(0, now - $pausedAt);
    const mm = Math.floor(elapsed / 60_000);
    const ss = Math.floor((elapsed % 60_000) / 1000);

    return (
        <div className="fixed inset-0 z-[1070] flex flex-col items-center justify-center gap-6 bg-background/95 backdrop-blur-sm px-6 text-center">
            <div className="flex items-center gap-2 text-warning">
                <Pause className="w-7 h-7" />
                <span className="font-inter-tight font-black uppercase tracking-[0.2em] text-sm">
                    Game paused
                </span>
            </div>
            <div className="font-inter-tight italic font-black tabular-nums text-6xl leading-none">
                {mm}:{String(ss).padStart(2, "0")}
            </div>
            <p className="max-w-xs text-sm text-muted-foreground leading-snug">
                Every timer is frozen — the hiding clock, answer windows, and
                any freeze. Everyone should stay exactly where they are. Resume
                when all players are ready.
            </p>
            <Button
                size="lg"
                className="gap-2 mt-2"
                onClick={() => resumeGame()}
            >
                <Play className="w-5 h-5" />
                Resume game
            </Button>
        </div>
    );
}

export default GamePausedOverlay;
