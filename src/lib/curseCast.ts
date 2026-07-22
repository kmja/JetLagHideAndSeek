import { toast } from "react-toastify";

import {
    curseCostRequiresDestination,
    curseCostRequiresRockCount,
    curseCostRequiresVideo,
    curseRequiresImage,
} from "@/lib/castingCost";
import {
    CURSE_BRIDGE_TROLL,
    CURSE_HIDDEN_HANGMAN,
    CURSE_WATER_WEIGHT,
} from "@/lib/castingConstraint";
import {
    activeBlockingCurse,
    activeBlockingCurseCastAt,
    CURSE_DRAINED_BRAIN,
    cursePreventsAskingOrTransit,
} from "@/lib/curseEnforcement";
import type { CurseCard } from "@/lib/hiderDeck";
import {
    activateOverflowingChalice,
    armFreeQuestion,
    discardCard,
} from "@/lib/hiderRole";
import { hiderCastCurse } from "@/lib/multiplayer/store";
import { recordCastCurse } from "@/lib/seekerInbound";
import { encodeCurseLink, shareOrCopy } from "@/lib/shareLinks";

/**
 * A unique client-side `castId` for a curse (v1037). Time-based + a monotonic
 * counter so two casts in the same millisecond never collide; the huge value
 * can't clash with the server's small monotonic seq (used for older clients).
 * Both the hider's `castCurses` mirror and the seekers' `receivedCurses` entry
 * carry this SAME id, so a seeker's `curseCleared` relay matches on the hider.
 * Shared by `CastCurseDialog` and the quick-cast path so a single counter
 * guarantees uniqueness across both.
 */
let castIdCounter = 0;
export function nextClientCastId(): number {
    castIdCounter = (castIdCounter + 1) % 1000;
    return Date.now() * 1000 + castIdCounter;
}

/**
 * Does casting this curse require an ACTION from the hider in the cast dialog?
 * (v1108) — a location pick, a photo, a film, a rock count, a secret word, a
 * category selection, a fizzle dice roll, or a location CONSTRAINT that must be
 * surfaced (with a "Cast anyway" override). Those keep the full
 * `CastCurseDialog`. Everything else (self-attested or discard-cost curses) is
 * "no action" → the hand plays it via a lightweight confirmation instead.
 */
export function curseNeedsCastAction(card: CurseCard): boolean {
    const cost = card.castingCost ?? "";
    if (curseCostRequiresDestination(cost)) return true; // Travel Agent (map pick)
    if (curseRequiresImage(cost, card.description)) return true; // photo/image
    if (curseCostRequiresVideo(cost)) return true; // Bird Guide (film)
    if (curseCostRequiresRockCount(cost)) return true; // Cairn (rock count)
    if (card.name === CURSE_HIDDEN_HANGMAN) return true; // pick a secret word
    if (card.name === CURSE_DRAINED_BRAIN) return true; // pick 3 questions
    // Location constraints with a "Cast anyway" override stay on the full dialog.
    if (card.name === CURSE_BRIDGE_TROLL || card.name === CURSE_WATER_WEIGHT)
        return true;
    // Fizzle-dice curses ("Roll a die. If it's X, this card/curse has no effect.")
    if (/roll a die.*no effect/i.test(cost)) return true;
    return false;
}

/** Side effects that fire the moment a curse lands — mirrors
 *  `CastCurseDialog.onCurseLanded`. */
function onCurseLanded(card: CurseCard): void {
    // Rulebook p386: record a blocking curse as active so a second can't be
    // cast until this one is cleared (or a timed one runs out).
    if (cursePreventsAskingOrTransit(card)) {
        activeBlockingCurse.set(card.name);
        activeBlockingCurseCastAt.set(Date.now());
    }
    if (card.name === "Curse of the Overflowing Chalice") {
        activateOverflowingChalice();
        toast.info(
            "Overflowing Chalice armed: your next 3 question rewards each draw one extra card.",
            { autoClose: 4000 },
        );
    }
}

/**
 * Cast a NO-ACTION curse (see `curseNeedsCastAction`) — the shared casting core,
 * identical to `CastCurseDialog.cast` for these curses (no photo/destination/
 * video/rock/hangman params to enforce). Pays the discard cost with the cards
 * the caller selected, delivers the curse (WebSocket in multiplayer, share/copy
 * link otherwise), discards the curse card, and fires the land side effects.
 * Returns whether the cast completed (a cancelled share does not).
 */
export async function performNoActionCurseCast(
    card: CurseCard,
    multiplayer: boolean,
    discardIds: string[],
): Promise<boolean> {
    const payload = {
        name: card.name,
        description: card.description,
        castingCost: card.castingCost ?? null,
        castId: nextClientCastId(),
    };
    // Impressionable Consumer's cost is "the seekers' next question is free".
    if (/next question is free/i.test(card.castingCost ?? "")) armFreeQuestion();

    if (multiplayer) {
        hiderCastCurse(payload);
        recordCastCurse(payload);
        for (const id of discardIds) discardCard(id);
        discardCard(card.id);
        onCurseLanded(card);
        return true;
    }

    // Solo / offline: the curse travels via a share/copy link.
    const url = encodeCurseLink(payload);
    const result = await shareOrCopy({
        title: `${card.name} cast on you`,
        text: `${card.name}: ${card.description}`,
        url,
    });
    if (result.method === "share" || result.method === "copy") {
        recordCastCurse(payload);
        for (const id of discardIds) discardCard(id);
        discardCard(card.id);
        onCurseLanded(card);
        toast.success(`${card.name} sent. Curse moved to discard.`, {
            autoClose: 2500,
        });
        return true;
    }
    toast.error("Could not share the curse — try again.");
    return false;
}
