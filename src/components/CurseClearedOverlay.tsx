import { useStore } from "@nanostores/react";
import { Check } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { SkullCrossbones } from "@/components/icons/gameIcons";
import { curseCleared } from "@/lib/curseCleared";

/** Celebratory confetti colours (greens + gold + a touch of purple). */
const CONFETTI = ["#4ade80", "#22c55e", "#a7d3e0", "#f2c63c", "#6b3f7a"];

/**
 * "Curse cleared!" CELEBRATION (v1110). When a curse is cleared, the curse
 * banner slides in and its skull-and-crossbones FLASHES TWICE (the Jet Lag
 * show's beat), then the banner fades up and a big green "CURSE CLEARED!"
 * bursts in with a confetti pop + an expanding ring. Auto-dismisses (or tap).
 * Mounted app-level; renders nothing unless `curseCleared` is set — fires on
 * whichever device cleared / received the clear (seeker win + hider feedback).
 */
export function CurseClearedOverlay() {
    const name = useStore(curseCleared);
    // "banner" (skull flashing) → "cleared" (celebration) → exit.
    const [phase, setPhase] = useState<"banner" | "cleared">("banner");
    const [exiting, setExiting] = useState(false);
    const timers = useRef<number[]>([]);

    const confetti = useMemo(() => {
        if (!name) return [];
        // Deterministic-ish spread (no Math.random dependency for SSR safety —
        // seeded off the name length + index).
        const seed = name.length;
        return Array.from({ length: 40 }, (_, i) => {
            const angle = (i / 40) * Math.PI * 2 + seed * 0.3;
            const dist = 120 + ((i * 37 + seed * 13) % 160);
            return {
                color: CONFETTI[i % CONFETTI.length],
                dx: Math.cos(angle) * dist,
                dy: Math.sin(angle) * dist - 70,
                rot: ((i * 53) % 200) - 100 + (i % 2 ? 360 : -360),
                delay: (i % 6) * 0.03,
                left: 50 + Math.cos(angle) * 4,
            };
        });
    }, [name]);

    const clearTimers = () => {
        timers.current.forEach((t) => clearTimeout(t));
        timers.current = [];
    };
    const exitingRef = useRef(false);
    const dismiss = () => {
        if (exitingRef.current) return;
        exitingRef.current = true;
        setExiting(true);
        clearTimers();
        timers.current.push(
            window.setTimeout(() => curseCleared.set(null), 300),
        );
    };

    useEffect(() => {
        if (!name) return;
        setPhase("banner");
        setExiting(false);
        exitingRef.current = false;
        clearTimers();
        // Skull flashes for ~900 ms, then the celebration bursts; auto-dismiss.
        timers.current.push(
            window.setTimeout(() => setPhase("cleared"), 950),
            window.setTimeout(() => dismiss(), 3100),
        );
        return clearTimers;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [name]);

    useEffect(() => clearTimers, []);

    if (!name) return null;

    return createPortal(
        <div
            role="dialog"
            aria-label={`Curse cleared: ${name}`}
            onClick={dismiss}
            className={`fixed inset-0 z-[1191] flex items-center justify-center overflow-hidden cursor-pointer pointer-events-auto ${
                exiting
                    ? "motion-safe:animate-[curseClearedOut_300ms_ease-in_forwards]"
                    : "motion-safe:animate-[curseClearedBackdrop_260ms_ease-out]"
            }`}
            style={{ background: "rgba(12, 18, 14, 0.7)" }}
        >
            {/* ── Phase 1: the curse banner, skull flashing twice ── */}
            {phase === "banner" && (
                <div className="motion-safe:animate-[curseClearedBannerIn_260ms_cubic-bezier(0.2,0.9,0.3,1)_both] flex items-stretch rounded-lg overflow-hidden shadow-2xl">
                    <div className="bg-[#5b3a78] px-6 py-4 flex items-center max-w-[70vw]">
                        <span className="font-inter-tight font-black uppercase text-2xl sm:text-3xl leading-tight text-white break-words">
                            {name}
                        </span>
                    </div>
                    <div className="bg-[#4a2f63] px-5 flex items-center">
                        <SkullCrossbones className="w-10 h-10 text-white motion-safe:animate-[curseClearedSkullFlash_900ms_ease-in-out]" />
                    </div>
                </div>
            )}

            {/* ── Phase 2: the "CURSE CLEARED!" celebration ── */}
            {phase === "cleared" && (
                <div className="relative flex flex-col items-center gap-3">
                    {/* expanding green ring behind */}
                    <span
                        aria-hidden
                        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-green-400 motion-safe:animate-[curseClearedRing_700ms_ease-out_forwards]"
                        style={{ width: "18rem", height: "18rem" }}
                    />
                    {/* confetti burst */}
                    <div
                        aria-hidden
                        className="pointer-events-none absolute left-1/2 top-1/2"
                    >
                        {confetti.map((p, i) => (
                            <span
                                key={i}
                                className="absolute w-2 h-3 rounded-sm motion-safe:animate-[jlConfettiPop_1400ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
                                style={
                                    {
                                        background: p.color,
                                        "--dx": `${p.dx}px`,
                                        "--dy": `${p.dy}px`,
                                        "--rot": `${p.rot}deg`,
                                        animationDelay: `${p.delay}s`,
                                    } as CSSProperties
                                }
                            />
                        ))}
                    </div>
                    <div className="motion-safe:animate-[curseClearedBurst_520ms_cubic-bezier(0.2,0.9,0.3,1)_both] flex flex-col items-center gap-3">
                        <span className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500 shadow-lg">
                            <Check
                                className="w-9 h-9 text-white"
                                strokeWidth={3}
                            />
                        </span>
                        <span className="font-inter-tight font-black uppercase text-3xl sm:text-5xl tracking-tight text-green-300 drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)] text-center">
                            Curse cleared!
                        </span>
                        <span className="text-sm text-white/70 max-w-[80vw] text-center truncate">
                            {name}
                        </span>
                    </div>
                </div>
            )}
        </div>,
        document.body,
    );
}

export default CurseClearedOverlay;
