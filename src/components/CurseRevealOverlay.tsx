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
 *   1. a purple 5-pointed star with a light-blue wiggly edge grows in FAST from
 *      the centre (its points just barely leave the frame);
 *   2. the curse card TUMBLES end over end (twice) as it grows in, slower;
 *   3. dark-navy squiggly lines grow OUT from behind the card (ease-out, a beat
 *      later), then the whole star + squiggles rotate slowly behind the settled
 *      card.
 * A full-screen portal overlay; tap anywhere (or wait ~9 s) to dismiss.
 *
 * All motion is CSS keyframes (see `globals.css` `curseReveal*`), so it's cheap
 * and `prefers-reduced-motion`-gated there. Mounted seeker-side only.
 */

const STAR_PURPLE = "#6b3f7a"; // the show's mid purple
const STAR_EDGE = "#a7d3e0"; // light-blue wiggly edge
const SQUIGGLE = "#232a4d"; // dark navy squiggles

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
            const a = (-90 + i * 36) * (Math.PI / 180);
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
        d +=
            i === 0
                ? `M ${x.toFixed(1)} ${y.toFixed(1)}`
                : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
}

export function CurseRevealOverlay() {
    const card = useStore(curseReveal);
    const $gameSize = useStore(gameSize);
    const timerRef = useRef<number | null>(null);

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
            {/* SVG rough-paper filter for the card edges. */}
            <svg width="0" height="0" className="absolute" aria-hidden="true">
                <filter id="curseCardRough">
                    <feTurbulence
                        type="fractalNoise"
                        baseFrequency="0.012 0.014"
                        numOctaves={2}
                        seed={7}
                        result="noise"
                    />
                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="noise"
                        scale={6}
                        xChannelSelector="R"
                        yChannelSelector="G"
                    />
                </filter>
            </svg>

            {/* Rotating background layer (slow infinite spin). Nested so the
                grow-in scales don't fight the spin's transform. The squiggles
                and the star each have their OWN grow-in so the squiggles can
                trail the card. */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="motion-safe:animate-[curseRevealSpin_46s_linear_infinite]">
                    {/* Squiggles — grow OUT from behind the card, delayed +
                        ease-out (beat 3). */}
                    <svg
                        viewBox="0 0 200 200"
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[112vmax] h-[112vmax] motion-safe:animate-[curseRevealSquiggleIn_620ms_520ms_cubic-bezier(0.22,1,0.36,1)_both]"
                        aria-hidden="true"
                    >
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
                    </svg>
                    {/* Star — grows in FAST (beat 1); points just barely leave
                        the frame. */}
                    <svg
                        viewBox="0 0 200 200"
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[112vmax] h-[112vmax] motion-safe:animate-[curseRevealStarIn_360ms_cubic-bezier(0.2,0.9,0.3,1)_both]"
                        aria-hidden="true"
                    >
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

            {/* The curse card tumbles end over end and settles in the centre.
                `perspective` on the wrapper makes the rotateX read as a real
                3-D tumble. */}
            <div
                className="relative z-[1] flex flex-col items-center"
                style={{ perspective: "1400px" }}
            >
                <div className="w-[min(78vw,300px)] drop-shadow-2xl motion-safe:animate-[curseRevealCardTumble_980ms_180ms_cubic-bezier(0.3,0.9,0.4,1)_both] [transform-style:preserve-3d]">
                    <div style={{ filter: "url(#curseCardRough)" }}>
                        <CardTile card={card} gameSize={$gameSize} />
                    </div>
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
