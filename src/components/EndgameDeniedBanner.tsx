import { useStore } from "@nanostores/react";
import { MapPinOff } from "lucide-react";
import { useEffect, useState } from "react";

import { endgameDeniedAt } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

/**
 * Transient on-map banner (v950): the server validated a seeker's endgame
 * claim as NOT at the hider's zone. It armed nothing (the seekers can re-try
 * at the right station), so this fleeting banner is how BOTH roles KNOW it was
 * attempted — the seeker learns they're in the wrong place, the hide team that
 * the seekers tried at the wrong spot. Auto-clears after a few seconds.
 *
 * Mounted on both the seeker map (`SeekerPage`) and the hider map
 * (`HiderBackgroundMap`); the copy is role-specific.
 */
const VISIBLE_MS = 9000;

export function EndgameDeniedBanner() {
    const $at = useStore(endgameDeniedAt);
    const $role = useStore(playerRole);
    const [shownAt, setShownAt] = useState<number | null>(null);

    useEffect(() => {
        if ($at == null) return;
        setShownAt($at);
        const t = window.setTimeout(() => {
            // Clear the atom (idempotent) + hide.
            if (endgameDeniedAt.get() === $at) endgameDeniedAt.set(null);
            setShownAt(null);
        }, VISIBLE_MS);
        return () => window.clearTimeout(t);
    }, [$at]);

    if (shownAt == null) return null;

    const isHider = $role === "hider";
    return (
        <div
            className={cn(
                "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[1044]",
                "top-2 max-w-[92vw] w-[min(92vw,420px)]",
                "animate-in fade-in slide-in-from-top-2 duration-200",
            )}
            role="status"
            aria-live="polite"
        >
            <div className="flex items-stretch overflow-hidden rounded-xl border border-destructive/40 bg-background/95 shadow-xl backdrop-blur">
                <span
                    className="flex w-12 shrink-0 items-center justify-center bg-destructive text-destructive-foreground"
                    aria-hidden="true"
                >
                    <MapPinOff className="h-5 w-5" strokeWidth={2.25} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col justify-center px-3 py-2.5">
                    <span className="text-sm font-extrabold uppercase leading-tight tracking-tight text-destructive">
                        {isHider ? "Endgame attempted" : "Not the right spot"}
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">
                        {isHider
                            ? "The seekers tried to start the endgame, but they're not at your zone."
                            : "The hider isn't in this zone. Keep searching."}
                    </span>
                </div>
            </div>
        </div>
    );
}

export default EndgameDeniedBanner;
