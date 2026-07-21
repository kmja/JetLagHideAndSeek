import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { CardTile } from "@/components/CardTile";
import { gameSize } from "@/lib/gameSetup";
import { cardFlyToHand } from "@/lib/hiderRole";

/**
 * v1043 (rebuilt v1046): a one-shot flourish that FLIES an auto-kept card down
 * into its real slot in the hand fan. Answering a photo question (a
 * draw-1-keep-1 reward) silently added a card to the hand with no feedback;
 * `presentDraw` now sets `cardFlyToHand`, and this overlay pops the card in
 * centre-screen, holds a beat, then does a measured FLIP: it reads the exact
 * on-screen rect of the destination fan card (`[data-hand-card="<id>"]`),
 * animates the flying card to THAT position + size (shrinking as it goes), and
 * reveals the fan slot underneath on arrival — so the card neatly slots into
 * place instead of fading out at a guessed position while the real card "pops
 * in from nowhere" (the old CSS-to-a-fixed-vh approach).
 *
 * Mounted once on `HiderPage`. Renders nothing unless a draw just fired.
 */
export function CardFlyToHand() {
    const cards = useStore(cardFlyToHand);
    const $size = useStore(gameSize);
    const elsRef = useRef<Array<HTMLDivElement | null>>([]);

    useEffect(() => {
        if (!cards || cards.length === 0) return;
        elsRef.current.length = cards.length;

        const prefersReduced =
            typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

        const total = cards.length;
        let done = 0;
        // Track which fan slots we hid so cleanup always restores them.
        const hidden: HTMLElement[] = [];
        const finishOne = () => {
            done += 1;
            if (done >= total) cardFlyToHand.set(null);
        };

        // Defer one frame so the fan has rendered the new card(s) and laid out.
        const raf = requestAnimationFrame(() => {
            cards.forEach((card, i) => {
                const el = elsRef.current[i];
                if (!el) {
                    finishOne();
                    return;
                }
                const idSel =
                    typeof CSS !== "undefined" && CSS.escape
                        ? CSS.escape(card.id)
                        : card.id;
                const target = document.querySelector<HTMLElement>(
                    `[data-hand-card="${idSel}"]`,
                );
                const startRect = el.getBoundingClientRect();

                // No destination (fan not mounted) or reduced motion: a short
                // pop + fade in place, no measured flight.
                if (prefersReduced || !target || startRect.width === 0) {
                    const a = el.animate(
                        [
                            { transform: "scale(.7)", opacity: 0 },
                            { transform: "scale(1)", opacity: 1, offset: 0.3 },
                            { transform: "scale(1)", opacity: 1, offset: 0.72 },
                            { transform: "scale(.92)", opacity: 0 },
                        ],
                        { duration: 700, easing: "ease-out", fill: "forwards" },
                    );
                    a.onfinish = finishOne;
                    a.oncancel = finishOne;
                    return;
                }

                const targetRect = target.getBoundingClientRect();
                const scale = targetRect.width / startRect.width;
                const dx =
                    targetRect.left +
                    targetRect.width / 2 -
                    (startRect.left + startRect.width / 2);
                const dy =
                    targetRect.top +
                    targetRect.height / 2 -
                    (startRect.top + startRect.height / 2);

                // Hide the destination slot until the flying card lands, then
                // reveal it — a seamless hand-off (the flying card lands at the
                // slot's exact position + size).
                const prevOpacity = target.style.opacity;
                target.style.opacity = "0";
                hidden.push(target);

                const anim = el.animate(
                    [
                        {
                            transform: "translate(0,0) scale(.62) rotate(-7deg)",
                            opacity: 0,
                            offset: 0,
                        },
                        {
                            transform: "translate(0,0) scale(1) rotate(0deg)",
                            opacity: 1,
                            offset: 0.16,
                        },
                        {
                            transform: "translate(0,0) scale(1) rotate(0deg)",
                            opacity: 1,
                            offset: 0.4,
                        },
                        {
                            transform: `translate(${dx}px,${dy}px) scale(${scale}) rotate(4deg)`,
                            opacity: 1,
                            offset: 1,
                        },
                    ],
                    {
                        duration: 1050,
                        easing: "cubic-bezier(0.5,0,0.2,1)",
                        fill: "forwards",
                    },
                );
                const settle = () => {
                    target.style.opacity = prevOpacity;
                    finishOne();
                };
                anim.onfinish = settle;
                anim.oncancel = settle;
            });
        });

        // Safety net: never leave the overlay (or a hidden slot) stuck.
        const safety = window.setTimeout(() => cardFlyToHand.set(null), 1700);

        return () => {
            cancelAnimationFrame(raf);
            window.clearTimeout(safety);
            hidden.forEach((t) => {
                t.style.opacity = "";
            });
        };
    }, [cards]);

    if (!cards || cards.length === 0) return null;

    return createPortal(
        <div className="fixed inset-0 z-[1150] pointer-events-none">
            {cards.map((card, i) => (
                <div
                    key={card.id}
                    ref={(el) => {
                        elsRef.current[i] = el;
                    }}
                    // No `filter: drop-shadow` here — a filter on a
                    // will-change-transform element smears into a vertical trail
                    // during the fast GPU transform on some Android devices. The
                    // CardTile reads fine without it.
                    className="absolute w-[min(46vw,180px)] aspect-[5/7] rounded-xl shadow-2xl will-change-transform"
                    style={{
                        // Centre the card's own box on (50%, 38%) via layout
                        // margins (NOT a transform) so the WAAPI transform below
                        // composes cleanly from a centred origin.
                        left: "50%",
                        top: "38%",
                        marginLeft: "calc(min(46vw, 180px) * -0.5)",
                        marginTop: "calc(min(46vw, 180px) * -0.7)",
                        opacity: 0,
                    }}
                >
                    <CardTile card={card} gameSize={$size} />
                </div>
            ))}
        </div>,
        document.body,
    );
}

export default CardFlyToHand;
