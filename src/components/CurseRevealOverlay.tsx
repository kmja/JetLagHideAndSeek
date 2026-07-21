import { useStore } from "@nanostores/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CardTile } from "@/components/CardTile";
import { curseCardFromReceived, curseReveal } from "@/lib/curseReveal";
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
 * A full-screen portal overlay; tap anywhere to dismiss (no auto-timeout —
 * it stays until the seeker acknowledges it).
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

/** A SMOOTH radial "snake" that UNDULATES (sine S-curve) from ~r0 to ~r1 along
 *  `angleDeg`, shifted `lateral` units sideways. Three of these at offsets
 *  −s/0/+s and the SAME phase read as a group of three parallel snakes (the
 *  show's curse graphic). */
function squigglePath(
    angleDeg: number,
    r0: number,
    r1: number,
    lateral: number,
): string {
    const a = (angleDeg * Math.PI) / 180;
    const ax = Math.cos(a);
    const ay = Math.sin(a);
    const px = -ay; // perpendicular (sideways)
    const py = ax;
    const steps = 28;
    const amp = 6; // undulation depth
    const waves = 2.4; // number of humps along the length
    const cx = 100;
    const cy = 100;
    let d = "";
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const r = r0 + (r1 - r0) * t;
        const wig = lateral + Math.sin(t * Math.PI * waves) * amp;
        const x = cx + ax * r + px * wig;
        const y = cy + ay * r + py * wig;
        d +=
            i === 0
                ? `M ${x.toFixed(1)} ${y.toFixed(1)}`
                : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
}

/** Format a film-duration target ("Film for m:ss"). */
function formatFilmTarget(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function CurseRevealOverlay() {
    const received = useStore(curseReveal);
    const $gameSize = useStore(gameSize);

    const starPath = useStarPath();
    // Squiggles in GROUPS OF THREE — smooth navy "snakes" that UNDULATE (sine)
    // as they radiate outward, drawn ON TOP of the star. Each group is three
    // PARALLEL snakes (same angle + phase, shifted sideways −s/0/+s), so they
    // read as a ribbon of three snakes. Six groups fan around the star.
    const squiggles = useMemo(() => {
        const out: string[] = [];
        for (let g = 0; g < 6; g++) {
            const base = -90 + g * 60;
            for (const lat of [-11, 0, 11]) {
                out.push(squigglePath(base, 34, 104, lat));
            }
        }
        return out;
    }, []);

    // Exit animation: on dismiss, fade + shrink out over ~320ms before clearing
    // the atom (which unmounts), instead of snapping away instantly.
    const [exiting, setExiting] = useState(false);
    const dismissTimer = useRef<number | null>(null);
    useEffect(() => {
        // A fresh curse resets the exit state (the component stays mounted and
        // just returns null between curses).
        if (received) setExiting(false);
    }, [received]);
    useEffect(
        () => () => {
            if (dismissTimer.current) clearTimeout(dismissTimer.current);
        },
        [],
    );

    if (!received) return null;

    const card = curseCardFromReceived(received);
    const dismiss = () => {
        if (exiting) return;
        setExiting(true);
        dismissTimer.current = window.setTimeout(
            () => curseReveal.set(null),
            320,
        );
    };

    // Payload delivered with the curse (v1031) — shown as it arrives so the
    // seekers immediately see what the hider sent (photo / destination / rock
    // count / film target).
    const payloadItems: { label: string }[] = [];
    if (received.rockCount != null) {
        payloadItems.push({
            label: `Build a rock tower ${received.rockCount} rock${received.rockCount === 1 ? "" : "s"} high`,
        });
    }
    if (received.filmSeconds != null) {
        payloadItems.push({
            label: `Film for at least ${formatFilmTarget(received.filmSeconds)}`,
        });
    }
    if (received.travelDestination) {
        payloadItems.push({
            label: `Destination: ${received.travelDestination}`,
        });
    }

    return createPortal(
        <div
            role="dialog"
            aria-label={`Curse cast: ${card.name}`}
            onClick={dismiss}
            className={`fixed inset-0 z-[1190] flex items-center justify-center overflow-hidden cursor-pointer ${
                exiting
                    ? "opacity-0 transition-opacity duration-300 ease-in pointer-events-none"
                    : "animate-[curseRevealBackdrop_320ms_ease-out]"
            }`}
            style={{
                // A dark, mostly-neutral scrim (not a full-screen purple wash) —
                // the purple STAR is the colour, the backdrop just dims the game.
                background: "rgba(18, 12, 26, 0.82)",
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

            {/* Rotating background layer (slow infinite spin). The spin box is
                a REAL sized element centred by the outer flex, so it spins
                around its own centre = screen centre. The star + squiggles are
                centred WITHIN it via `inset-0 m-auto` (NOT a translate — the
                grow-in animations overwrite `transform`, which is exactly what
                made the star orbit instead of spinning in place). */}
            <div
                className={`absolute inset-0 flex items-center justify-center pointer-events-none transition-transform duration-300 ease-in ${
                    exiting ? "scale-90" : ""
                }`}
            >
                <div className="relative w-[108vmin] h-[108vmin] motion-safe:animate-[curseRevealSpin_46s_linear_infinite]">
                    {/* Star — grows in FAST (beat 1); big enough that its points
                        push well past the frame edges. Fills the spin box.
                        Drawn FIRST so the snakes sit ON TOP of it. */}
                    <svg
                        viewBox="0 0 200 200"
                        className="absolute inset-0 m-auto w-full h-full motion-safe:animate-[curseRevealStarIn_360ms_cubic-bezier(0.2,0.9,0.3,1)_both]"
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
                    {/* Squiggles — smooth navy snakes that grow OUT ON TOP of the
                        star, delayed + ease-out (beat 3). Fill the spin box. */}
                    <svg
                        viewBox="0 0 200 200"
                        className="absolute inset-0 w-full h-full motion-safe:animate-[curseRevealSquiggleIn_620ms_520ms_cubic-bezier(0.22,1,0.36,1)_both]"
                        aria-hidden="true"
                    >
                        {squiggles.map((d, i) => (
                            <path
                                key={i}
                                d={d}
                                fill="none"
                                stroke={SQUIGGLE}
                                strokeWidth={8}
                                strokeLinecap="butt"
                                strokeLinejoin="round"
                                opacity={0.95}
                            />
                        ))}
                    </svg>
                </div>
            </div>

            {/* The curse card tumbles end over end and settles in the centre.
                `perspective` on the wrapper makes the rotateX read as a real
                3-D tumble. */}
            <div
                className={`relative z-[1] flex flex-col items-center transition-transform duration-300 ease-in ${
                    exiting ? "scale-90" : ""
                }`}
                style={{ perspective: "1400px" }}
            >
                <div className="relative w-[min(78vw,300px)] drop-shadow-2xl motion-safe:animate-[curseRevealCardTumble_1500ms_180ms_cubic-bezier(0.3,0.9,0.4,1)_both] [transform-style:preserve-3d]">
                    {/* Torn-paper backing: a slightly-larger card-white
                        rectangle with the rough filter, so its EDGES look torn.
                        The card on top drops its OWN border + shadow so its white
                        surface MERGES into this white paper — otherwise the
                        card's crisp straight edge showed inside the torn frame
                        (the reported ugliness). The card content stays sharp
                        (only the paper is filtered). */}
                    <div
                        aria-hidden="true"
                        className="absolute -inset-[9px] rounded-[7%] bg-white"
                        style={{ filter: "url(#curseCardRough)" }}
                    />
                    <div className="relative">
                        <CardTile
                            card={card}
                            gameSize={$gameSize}
                            className="!border-0 !shadow-none"
                        />
                    </div>
                </div>
                {payloadItems.length > 0 && (
                    <div className="mt-3 flex flex-col items-center gap-1.5">
                        {received.photoUrl && (
                            <img
                                src={received.photoUrl}
                                alt="Curse proof"
                                className="max-h-32 rounded-md border border-white/25 object-contain bg-black/20"
                            />
                        )}
                        {payloadItems.map((p, i) => (
                            <span
                                key={i}
                                className="rounded-full bg-black/35 px-3 py-1 text-center text-xs font-semibold text-white"
                            >
                                {p.label}
                            </span>
                        ))}
                    </div>
                )}
                <p className="mt-4 text-center text-xs font-poppins font-semibold uppercase tracking-[0.14em] text-white/70">
                    Tap to dismiss
                </p>
            </div>
        </div>,
        document.body,
    );
}

export default CurseRevealOverlay;
