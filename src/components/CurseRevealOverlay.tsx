import { useStore } from "@nanostores/react";
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import { CardTile } from "@/components/CardTile";
import { curseReveal } from "@/lib/curseReveal";
import { gameSize } from "@/lib/gameSetup";

/**
 * Jet-Lag-show-style curse REVEAL animation, shown to the SEEKERS the moment a
 * curse is cast on them (`curseReveal` atom, set by the `curseReceived`
 * handler). Three beats, matching the show:
 *   1. a purple 5-pointed star with a light-blue wiggly edge grows + spins in
 *      from the centre;
 *   2. the curse card spins out, flanked by dark-purple squiggly lines;
 *   3. the card settles still in the centre while the star + squiggles rotate
 *      slowly behind it.
 * A full-screen portal overlay; tap anywhere (or wait ~9 s) to dismiss.
 *
 * All motion is CSS keyframes (see `globals.css` `curseReveal*`), so it's
 * cheap and `prefers-reduced-motion`-gated there. Mounted seeker-side only.
 */

const STAR_PURPLE = "#6b3f7a"; // the show's mid purple
const STAR_EDGE = "#a7d3e0"; // light-blue wiggly edge
const SQUIGGLE = "#232a4d"; // dark navy-purple squiggles

/** A slightly-irregular 5-point star path in a 0..200 viewBox. */
function useStarPath(): string {
    return useMemo(() => {
        const cx = 100;
        const cy = 100;
        const outer = 96;
        const inner = 40;
        const pts: string[] = [];
        for (let i = 0; i < 10; i++) {
            const r = i % 2 === 0 ? outer : inner;
            // start pointing up (-90deg), 36deg between each outer/inner vertex
            const a = (-90 + i * 36) * (Math.PI / 180);
            // a touch of irregularity so the arms read hand-drawn
            const jitter = i % 2 === 0 ? 1 : 0.94 + (i % 3) * 0.03;
            const x = cx + Math.cos(a) * r * jitter;
            const y = cy + Math.sin(a) * r * jitter;
            pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        return `M ${pts.join(" L ")} Z`;
    }, []);
}

/** A wavy radial "squiggle" line, from ~r0 to ~r1 along `angleDeg`. */
function squigglePath(angleDeg: number, r0: number, r1: number): string {
    const a = (angleDeg * Math.PI) / 180;
    const ax = Math.cos(a);
    const ay = Math.sin(a);
    // perpendicular for the wiggle offset
    const px = -ay;
    const py = ax;
    const steps = 5;
    const amp = 5;
    const cx = 100;
    const cy = 100;
    let d = "";
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const r = r0 + (r1 - r0) * t;
        const wig = Math.sin(t * Math.PI * 2.2) * amp;
        const x = cx + ax * r + px * wig;
        const y = cy + ay * r + py * wig;
        d += i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
}

export function CurseRevealOverlay() {
    const card = useStore(curseReveal);
    const $gameSize = useStore(gameSize);
    const timerRef = useRef<number | null>(null);

    // Auto-dismiss after the beat has landed (the show holds the card a few
    // seconds). A tap dismisses sooner.
    useEffect(() => {
        if (!card) return;
        timerRef.current = window.setTimeout(() => curseReveal.set(null), 9000);
        return () => {
            if (timerRef.current) window.clearTimeout(timerRef.current);
        };
    }, [card]);

    const starPath = useStarPath();
    const squiggles = useMemo(
        () =>
            // 10 squiggles, offset from the star arms so they read as the
            // dark lines flanking the card.
            Array.from({ length: 10 }, (_, i) =>
                squigglePath(-90 + i * 36 + 18, 46, 96),
            ),
        [],
    );

    if (!card) return null;

    const dismiss = () => curseReveal.set(null);

    return createPortal(
        <div
            role="dialog"
            aria-label={`Curse cast: ${card.name}`}
            onClick={dismiss}
            className="fixed inset-0 z-[1190] flex items-center justify-center overflow-hidden cursor-pointer animate-[curseRevealBackdrop_320ms_ease-out]"
            style={{
                background:
                    "radial-gradient(circle at 50% 45%, #7a4a8c 0%, #5a2f6e 55%, #3f1f52 100%)",
            }}
            data-testid="curse-reveal-overlay"
        >
            {/* Rotating background layer (slow infinite spin). Nested so the
                grow-in scale doesn't fight the spin's transform. */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="motion-safe:animate-[curseRevealSpin_44s_linear_infinite]">
                    <div className="motion-safe:animate-[curseRevealStarIn_720ms_cubic-bezier(0.22,1,0.36,1)_both]">
                        <svg
                            viewBox="0 0 200 200"
                            className="w-[135vmax] h-[135vmax]"
                            aria-hidden="true"
                        >
                            {/* dark squiggly lines flanking the star arms */}
                            {squiggles.map((d, i) => (
                                <path
                                    key={i}
                                    d={d}
                                    fill="none"
                                    stroke={SQUIGGLE}
                                    strokeWidth={3.2}
                                    strokeLinecap="round"
                                    opacity={0.9}
                                />
                            ))}
                            {/* the star: purple fill, light-blue wiggly edge */}
                            <path
                                d={starPath}
                                fill={STAR_PURPLE}
                                stroke={STAR_EDGE}
                                strokeWidth={5}
                                strokeLinejoin="round"
                            />
                        </svg>
                    </div>
                </div>
            </div>

            {/* The curse card spins out and settles in the centre. */}
            <div className="relative z-[1] motion-safe:animate-[curseRevealCardIn_760ms_560ms_cubic-bezier(0.34,1.3,0.5,1)_both]">
                <div className="w-[min(78vw,300px)] drop-shadow-2xl">
                    <CardTile card={card} gameSize={$gameSize} />
                </div>
                <p className="mt-4 text-center text-xs font-poppins font-semibold uppercase tracking-[0.14em] text-white/70">
                    Tap to dismiss
                </p>
            </div>
        </div>,
        document.body,
    );
}

export default CurseRevealOverlay;
