import { useStore } from "@nanostores/react";
import { Users, Wifi, WifiOff } from "lucide-react";

import {
    currentGameCode,
    participants,
    transportStatus,
} from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * Compact chip showing the current online connection status — used
 * in the BottomNav header area to give the player passive feedback
 * about whether they're synced.
 *
 *   - Hides entirely when no online game is active.
 *   - Green dot + count of online participants when connected.
 *   - Yellow dot + "reconnecting…" when transport is shaky.
 *   - Grey "offline" when not connected.
 */
export function PresenceChip() {
    const $code = useStore(currentGameCode);
    const $status = useStore(transportStatus);
    const $participants = useStore(participants);

    if (!$code) return null;

    const online = $participants.filter((p) => p.online).length;
    const total = $participants.length;

    const tone =
        $status === "open"
            ? "bg-emerald-400/20 text-emerald-300 border-emerald-400/40"
            : $status === "reconnecting" || $status === "connecting"
              ? "bg-yellow-400/20 text-yellow-300 border-yellow-400/40"
              : "bg-muted/40 text-muted-foreground border-border";

    const Icon =
        $status === "open" ? Wifi : $status === "closed" ? WifiOff : Users;

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-poppins font-bold uppercase tracking-wider",
                tone,
            )}
            title={`Game code: ${$code}`}
            aria-label={`Multiplayer status: ${$status}`}
        >
            <Icon className="w-3 h-3" />
            {$status === "open"
                ? `${online}/${total}`
                : $status === "reconnecting" || $status === "connecting"
                  ? "Reconnecting"
                  : "Offline"}
        </span>
    );
}

export default PresenceChip;
