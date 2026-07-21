import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { CardTile } from "@/components/CardTile";
import { gameSize } from "@/lib/gameSetup";
import { cardFlyToHand } from "@/lib/hiderRole";

/**
 * v1043 (rebuilt v1046, seamless-origin v1052): a one-shot flourish that FLIES a
 * card into its real slot in the hand fan. Two entry points:
 *
 *   - Photo-answer AUTO-KEEP (`presentDraw`) sets `{cards}` with NO origin rect:
 *     the card POPS in at screen centre, then does a measured FLIP to its real
 *     fan slot.
 *   - The DRAW PICKER (`DrawPickerDialog`) sets `{cards, fromRect}` = the picked
 *     carousel card's on-screen rect: the flying card STARTS at that exact
 *     position + size (no pop) so it reads as the SAME card continuing from the
 *     carousel down to the hand — a true FLIP with no "new card spawned on top".
 *
 * Either way it reads the destination fan card's rect (`[data-hand-card]`),
 * animates the flying card there (shrinking to hand size), and reveals the fan
 * slot underneath on arrival — so the card neatly slots into place.
 *
 * Mounted once on `HiderPage`. Renders nothing unless a draw just fired.
 */
export function CardFlyToHand() {
    const payload = useStore(cardFlyToHand);
    const $size = useStore(gameSize);
    const elsRef = useRef<Array<HTMLDivElement | null>>([]);

    const cards = payload?.cards ?? null;
    const fromRect = payload?.fromRect;
    const seamless = Boolean(fromRect);

    useEffect(() => {
        if (!cards || cards.length === 0) return;
        elsRef.current.length = cards.length;

        const prefersReduced =
            typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

        const total = cards.length;
        let done = 0;
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

                // Seamless (from the carousel): start EXACTLY where the card is
                // (opacity 1, identity transform) and fly — no intro pop. Centre
                // pop (photo auto-keep): grow in first, hold, then fly.
                const keyframes = seamless
                    ? [
                          {
                              transform: "translate(0,0) scale(1) rotate(0deg)",
                              opacity: 1,
                              offset: 0,
                          },
                          {
                              transform: `translate(${dx}px,${dy}px) scale(${scale}) rotate(3deg)`,
                              opacity: 1,
                              offset: 1,
                          },
                      ]
                    : [
                          {
                              transform:
                                  "translate(0,0) scale(.62) rotate(-7deg)",
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
                      ];
                const anim = el.animate(keyframes, {
                    duration: seamless ? 640 : 1050,
                    easing: "cubic-bezier(0.5,0,0.2,1)",
                    fill: "forwards",
                });
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
    }, [payload, cards, seamless]);

    if (!cards || cards.length === 0) return null;

    return createPortal(
        <div className="fixed inset-0 z-[1150] pointer-events-none">
            {cards.map((card, i) => (
                <div
                    key={card.id}
                    ref={(el) => {
                        elsRef.current[i] = el;
                    }}
                    // No `filter: drop-shadow` — a filter on a
                    // will-change-transform element smears into a vertical trail
                    // during the fast GPU transform on some Android devices.
                    className="absolute rounded-xl shadow-2xl will-change-transform"
                    style={
                        seamless && fromRect
                            ? {
                                  // Start EXACTLY at the carousel card's rect so
                                  // it's the SAME card continuing (no pop).
                                  left: fromRect.left,
                                  top: fromRect.top,
                                  width: fromRect.width,
                                  opacity: 1,
                              }
                            : {
                                  // Centre the card's own box on (50%, 38%) via
                                  // layout margins (NOT a transform) so the WAAPI
                                  // transform composes from a centred origin.
                                  width: "min(46vw, 180px)",
                                  aspectRatio: "5 / 7",
                                  left: "50%",
                                  top: "38%",
                                  marginLeft: "calc(min(46vw, 180px) * -0.5)",
                                  marginTop: "calc(min(46vw, 180px) * -0.7)",
                                  opacity: 0,
                              }
                    }
                >
                    <CardTile card={card} gameSize={$size} />
                </div>
            ))}
        </div>,
        document.body,
    );
}

export default CardFlyToHand;
