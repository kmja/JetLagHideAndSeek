import { useStore } from "@nanostores/react";
import { MapPinOff } from "lucide-react";

import { clearGpsSpoof, spoofedPosition } from "@/lib/debugGpsSpoof";

/**
 * Always-visible chip shown whenever a debug GPS spoof is active (v937).
 * The spoof is now persistent (survives reloads, for multi-device testing),
 * so this banner is the safety net: it makes an active spoof impossible to
 * forget and offers a one-tap clear back to real GPS. Inert (renders null)
 * when there's no spoof, so it never shows for a normal user.
 */
export function SpoofIndicator() {
    const spoof = useStore(spoofedPosition);
    if (!spoof) return null;
    return (
        <button
            type="button"
            onClick={() => clearGpsSpoof()}
            className="fixed z-[1950] left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+0.25rem)] flex items-center gap-1.5 rounded-full bg-amber-500 text-black px-3 py-1 text-[11px] font-poppins font-bold shadow-lg active:scale-95 transition-transform"
            title={`GPS spoofed to ${spoof.lat.toFixed(3)}, ${spoof.lng.toFixed(3)} — tap to clear`}
            aria-label="GPS is spoofed — tap to clear"
        >
            <MapPinOff className="w-3.5 h-3.5" />
            GPS SPOOFED · tap to clear
        </button>
    );
}

export default SpoofIndicator;
