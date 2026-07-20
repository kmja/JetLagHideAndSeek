import { atom } from "nanostores";

import type { CurseCard } from "@/lib/hiderDeck";
import type { ReceivedCurse } from "@/lib/seekerInbound";

/**
 * Volatile trigger for the Jet-Lag-show-style curse REVEAL animation
 * (`CurseRevealOverlay`). Set to the FULL received curse when a curse is cast
 * on the SEEKERS (v1031 — carries the payload too, so the reveal can show the
 * photo / destination / rock count / film target as it arrives); the overlay
 * plays the star-spin-in → card-spin-out → settle sequence, then the seeker
 * dismisses it (or it auto-dismisses). Cleared to null when dismissed. Not
 * persisted — a reveal is a one-shot moment, never replayed on reload/reconnect
 * (the curse itself lives in `receivedCurses`).
 */
export const curseReveal = atom<ReceivedCurse | null>(null);

/** Build a `CurseCard` (for `CardTile`) from a received curse payload. */
export function curseCardFromReceived(c: ReceivedCurse): CurseCard {
    return {
        id: `reveal-${c.castId ?? c.receivedAt}`,
        kind: "curse",
        name: c.name,
        description: c.description,
        castingCost: c.castingCost ?? null,
    };
}

/** Fire the reveal animation for a freshly-received curse (seeker side). */
export function triggerCurseReveal(c: ReceivedCurse): void {
    curseReveal.set(c);
}
