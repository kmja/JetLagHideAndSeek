import { useStore } from "@nanostores/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { CardTile } from "@/components/CardTile";
import { gameSize } from "@/lib/gameSetup";
import { cardFlyToHand } from "@/lib/hiderRole";

/**
 * v1043: a one-shot flourish that "flies" an auto-kept card down to the hand
 * fan. Answering a photo question (a draw-1-keep-1 reward) silently added a
 * card to the hand with no feedback; `presentDraw` now sets `cardFlyToHand`,
 * and this overlay pops the card in centre-screen, holds a beat, then flies it
 * down toward the bottom hand — the same "card goes to your hand" beat the
 * draw picker gives. Clears the atom when the animation ends.
 *
 * Mounted once on `HiderPage`. Renders nothing unless a draw just fired.
 */
export function CardFlyToHand() {
    const cards = useStore(cardFlyToHand);
    const $size = useStore(gameSize);

    useEffect(() => {
        if (!cards) return;
        const t = window.setTimeout(() => cardFlyToHand.set(null), 1250);
        return () => window.clearTimeout(t);
    }, [cards]);

    if (!cards || cards.length === 0) return null;

    return createPortal(
        <div className="fixed inset-0 z-[1150] pointer-events-none">
            {cards.map((card, i) => (
                <div
                    key={card.id}
                    className="absolute left-1/2 top-1/2 w-[min(46vw,180px)] aspect-[5/7] drop-shadow-2xl motion-safe:animate-[jlCardToHand_1150ms_cubic-bezier(0.4,0,0.5,1)_both] motion-reduce:animate-[jlCardToHandFade_800ms_ease-out_both]"
                    style={{ animationDelay: `${i * 120}ms` }}
                >
                    <CardTile card={card} gameSize={$size} />
                </div>
            ))}
        </div>,
        document.body,
    );
}

export default CardFlyToHand;
