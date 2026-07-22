import { atom } from "nanostores";

/**
 * Volatile trigger for the "curse cleared!" CELEBRATION (`CurseClearedOverlay`).
 * Set to the cleared curse's name the moment a curse is cleared — by the seekers
 * beating it, an auto-expiry, or the hide team receiving the `curseCleared`
 * relay. The overlay flashes the skull twice (the show's beat) then bursts a
 * big green "CURSE CLEARED!" celebration and fades. Cleared to null on dismiss.
 * Not persisted — a one-shot moment, never replayed on reload/reconnect.
 */
export const curseCleared = atom<string | null>(null);

/** Fire the cleared celebration for a curse by name. No-op on an empty name. */
export function triggerCurseCleared(name: string | null | undefined): void {
    if (name) curseCleared.set(name);
}
