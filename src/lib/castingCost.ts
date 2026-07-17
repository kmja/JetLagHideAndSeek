import type { Card } from "./hiderDeck";

/**
 * Structured representation of a curse's *discard* casting cost, parsed
 * from the printed casting-cost text (rulebook hider deck). Only
 * discard-type costs are modelled here — the others ("Roll a die",
 * "Film a bird", "You must be at the restaurant", …) are real-life
 * actions the hider self-attests, so there's nothing for the app to
 * enforce.
 *
 * `null` means the curse has no discard cost (no cost at all, or a
 * non-discard cost).
 */
export interface DiscardCost {
    /** How many cards must be discarded. Ignored when `whole` is true. */
    count: number;
    /** Which cards in hand can satisfy the cost. */
    kind: "any" | "powerup" | "time-bonus";
    /** True for "Discard your hand" — discard every eligible card, no pick. */
    whole: boolean;
    /** Short imperative label for the pay-cost UI. */
    label: string;
}

/**
 * Parse a curse's casting-cost string into a {@link DiscardCost}, or
 * null if it isn't a discard cost. Case-insensitive and tolerant of
 * the deck's "2"/"two" and "powerup"/"time bonus" phrasings.
 */
export function parseDiscardCost(castingCost: string | null): DiscardCost | null {
    if (!castingCost) return null;
    const c = castingCost.toLowerCase();
    if (!c.includes("discard")) return null;

    if (c.includes("your hand")) {
        return { count: 0, kind: "any", whole: true, label: "Discard your hand" };
    }
    if (c.includes("powerup")) {
        return {
            count: 1,
            kind: "powerup",
            whole: false,
            label: "Discard a powerup",
        };
    }
    if (c.includes("time bonus")) {
        return {
            count: 1,
            kind: "time-bonus",
            whole: false,
            label: "Discard a time bonus",
        };
    }
    // Plain card discard: "Discard a card" / "Discard 2 cards" /
    // "Discard two cards".
    const two = /\b(2|two)\b/.test(c);
    const count = two ? 2 : 1;
    return {
        count,
        kind: "any",
        whole: false,
        label: count === 2 ? "Discard 2 cards" : "Discard a card",
    };
}

/**
 * Whether a curse's casting cost is "take a photo" — i.e. the hider must
 * attach a proof photo the seekers see (Curse of the Zoologist "A photo
 * of an animal", Curse of the Luxury Car "A photo of a car"). Those are
 * the curses where the app can actually deliver the hider's photo to the
 * seekers, rather than leaving it a self-attested real-life action.
 *
 * "Film a bird" is deliberately EXCLUDED — it's a video, not a still, and
 * the app has no video pipeline; the bird footage is the casting-cost
 * proof the hider keeps, not something delivered over the wire.
 *
 * Curse of the Ransom Note is ALSO included: its cost is spelling out
 * "ransom note" as a physical ransom note, and a photo of that note is the
 * natural proof to deliver to the seekers (matched on "ransom note" since
 * the cost text doesn't literally say "photo").
 */
export function curseCostRequiresPhoto(castingCost: string | null): boolean {
    return (
        !!castingCost &&
        (/\bphoto\b/i.test(castingCost) || /ransom note/i.test(castingCost))
    );
}

/**
 * Whether a curse's DELIVERABLE is an image the HIDER must send to the
 * seekers — distinct from a photo CASTING COST (above). Curse of the
 * Unguided Tourist ("Send the seekers an ... Street View image") and Curse
 * of the Labyrinth ("send a photo of it") both require the hider to attach
 * an image that's delivered to the seekers as the curse's payload. It rides
 * the SAME photo pipeline as the photo-cost curses (capture → R2 →
 * `CursePayload.photoUrl` → CurseInbox), just for the deliverable rather
 * than the cost. Detected off the description since neither casting cost
 * literally says "photo". `curseRequiresImage` unions both signals for the
 * cast flow's "must attach a photo" gate.
 */
export function curseCostDeliverableIsImage(
    description: string | null,
): boolean {
    if (!description) return false;
    return (
        /send the seekers an[^.]*\b(image|photo|picture)\b/i.test(description) ||
        /send a photo of it/i.test(description)
    );
}

/**
 * Unified "this curse needs the hider to attach an image" gate — true when
 * the casting cost is a proof photo OR the deliverable is a hider-sent image.
 */
export function curseRequiresImage(
    castingCost: string | null,
    description: string | null,
): boolean {
    return (
        curseCostRequiresPhoto(castingCost) ||
        curseCostDeliverableIsImage(description)
    );
}

/**
 * Whether a curse's casting cost is "film for a duration" — Curse of the
 * Bird Guide ("Film a bird"), where the mechanic is entirely about the
 * elapsed TIME the hider managed (the seekers must then film for at least
 * as long). The app can't practically deliver 15 minutes of video, but it
 * CAN time it precisely and send the seekers the target duration, so the
 * cast flow offers an in-app stopwatch instead of the full video.
 */
export function curseCostRequiresVideo(castingCost: string | null): boolean {
    return !!castingCost && /\bfilm\b/i.test(castingCost);
}

/**
 * Whether a curse's casting cost is "build a rock tower" (Curse of the
 * Cairn), where the mechanic is entirely about the NUMBER of rocks the
 * hider stacked (the seekers must then build a tower of the same count).
 * The app can't verify a real rock tower, but it CAN carry the target
 * count to the seekers, so the cast flow offers a rock-count entry.
 */
export function curseCostRequiresRockCount(
    castingCost: string | null,
): boolean {
    return !!castingCost && /\brock tower\b/i.test(castingCost);
}

/**
 * Whether a curse requires the hider to pick a DESTINATION (Curse of the
 * Mediocre Travel Agent — the hider chooses a place near the seekers for
 * them to travel to). Matched on "vacation destination" in the casting-cost
 * constraint text; the chosen place is delivered to the seekers.
 */
export function curseCostRequiresDestination(
    castingCost: string | null,
): boolean {
    return !!castingCost && /vacation destination/i.test(castingCost);
}

/**
 * The subset of `hand` that can satisfy `cost`, excluding the curse
 * card paying the cost (the casting cost is paid *in addition* to the
 * curse itself).
 */
export function eligibleForDiscardCost(
    hand: Card[],
    cost: DiscardCost,
    castingCurseId: string,
): Card[] {
    return hand.filter((card) => {
        if (card.id === castingCurseId) return false;
        if (cost.kind === "any") return true;
        return card.kind === cost.kind;
    });
}

/**
 * Whether the hand holds enough eligible cards to pay `cost`. A
 * "whole hand" cost is always payable (discarding zero other cards is
 * still a legal payment). A counted cost needs at least `count`
 * eligible cards — otherwise the curse can't be cast.
 */
export function canPayDiscardCost(
    hand: Card[],
    cost: DiscardCost,
    castingCurseId: string,
): boolean {
    if (cost.whole) return true;
    return (
        eligibleForDiscardCost(hand, cost, castingCurseId).length >= cost.count
    );
}
