import { useStore } from "@nanostores/react";
import { Bug } from "lucide-react";

import { spoofedPosition } from "@/lib/debugGpsSpoof";
import { debugLauncherHidden, debugPanelOpen } from "@/lib/debugState";
import { cn } from "@/lib/utils";

/**
 * Inline launcher for the developer debug panel, sized to sit in the
 * app header (SeekerTopBar / HiderTopBar). v617: replaces the floating
 * bottom-left "debug" chip on mobile — it was colliding with the
 * Map-options chip that moved to bottom-left in v616.
 *
 * Deliberately tiny: it only imports `debugPanelOpen` + `spoofedPosition`
 * (both featherweight atoms), so dropping it in the always-loaded header
 * does NOT pull the heavy `DebugPhaseControls` bundle — that still loads
 * lazily the first time the panel actually opens.
 *
 * Amber-tints while GPS is spoofed so a forgotten spoof can't masquerade
 * as broken real GPS (mirrors the old floating chip's behaviour).
 */
export function DebugLaunchButton({ className }: { className?: string }) {
    const $spoof = useStore(spoofedPosition);
    // When hidden, keep the 40×40 hit target but render fully transparent —
    // invisible in screenshots, still clickable to reopen the panel (where the
    // toggle to un-hide lives). opacity-0 covers the icon + border + bg.
    const $hidden = useStore(debugLauncherHidden);
    return (
        <button
            type="button"
            onClick={() => debugPanelOpen.set(true)}
            aria-label="Open developer debug panel"
            title={$spoof ? "Debug — GPS spoofed" : "Debug"}
            className={cn(
                "h-10 w-10 flex items-center justify-center rounded-md",
                "border transition-colors",
                $spoof
                    ? "text-amber-300 border-amber-300/60 bg-amber-500/20 hover:bg-amber-500/30"
                    : "text-white/70 border-white/30 bg-white/10 hover:bg-white/20 hover:text-white",
                $hidden && "opacity-0 hover:opacity-0",
                className,
            )}
        >
            <Bug className="w-4 h-4" />
        </button>
    );
}

export default DebugLaunchButton;
