import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

/**
 * Game setup state — the result of the 3-step onboarding flow that runs on
 * first load and via the "New game" action in the bottom nav.
 */

/**
 * Transit modes that meaningfully change what's available in the game.
 * Per the rulebook, walking is always permitted (so we don't list it),
 * and motor vehicles / bikes aren't part of the standard transit set —
 * the seeker needs to think in terms of public-transit-reachability.
 * Bus is technically valid but opens up far too many options to make
 * for an interesting game, so it's off by default.
 */
export type TransitMode = "bus" | "tram" | "train" | "subway" | "ferry";

export type GameSize = "small" | "medium" | "large";

/** Whether the setup wizard has been completed at least once. */
export const setupCompleted = persistentAtom<boolean>(
    "setupCompleted",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/** The play area as a named place + coordinates. */
export const playArea = persistentAtom<{
    displayName: string;
    lat: number;
    lng: number;
} | null>("playArea", null, {
    encode: JSON.stringify,
    decode: JSON.parse,
});

/**
 * Allowed transit modes for this session. Default is train + subway —
 * the most iconic Jet Lag transit and what the YouTube series uses
 * most. Adding bus is a power-user choice because it dramatically
 * expands the search space.
 */
export const allowedTransit = persistentAtom<TransitMode[]>(
    "allowedTransit",
    ["train", "subway"],
    { encode: JSON.stringify, decode: JSON.parse },
);

/** Hiding zone size category. Per the rulebook this controls both the
 *  geographic scope of the game and the length of the hiding period. */
export const gameSize = persistentAtom<GameSize>("gameSize", "medium", {
    encode: (v) => v,
    decode: (v) => v as GameSize,
});

/** Top-right map display toggles. */
export const satelliteView = persistentAtom<boolean>("satelliteView", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const showTransitLines = persistentAtom<boolean>(
    "showTransitLines",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/** Volatile: is the setup wizard currently shown? */
export const setupDialogOpen = atom<boolean>(false);

/**
 * Unix timestamp (ms) at which the hiding period ends. Null when no
 * hiding period is currently running. Persisted so the timer survives
 * page reloads — a 3-hour hiding period for a Large game needs to be
 * resilient.
 */
export const hidingPeriodEndsAt = persistentAtom<number | null>(
    "hidingPeriodEndsAt",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/** Hiding period duration in minutes, per the rulebook (image 2). */
export const HIDING_PERIOD_MINUTES: Record<GameSize, number> = {
    small: 30,
    medium: 60,
    large: 180,
};

/**
 * Rulebook copy for each size, used in step 3 of the setup wizard.
 * Verbatim from the printed rulebook so seekers/hiders recognise it.
 */
export const SIZE_DESCRIPTIONS: Record<
    GameSize,
    { spans: string; lasts: string; examples: string }
> = {
    small: {
        spans: "A single town, small city, or portion of a large city",
        lasts: "4-8 hours",
        examples: "Lower Manhattan; Winston-Salem, NC",
    },
    medium: {
        spans: "A major city, metro area, or region",
        lasts: "about 1 day",
        examples: "Hong Kong; New York City; Greater London, UK",
    },
    large: {
        spans: "A large region, an entire country, or several small countries",
        lasts: "2 to 4 days",
        examples: "Switzerland; Japan; New England, US",
    },
};

/** Human-readable labels for each transit mode. */
export const TRANSIT_LABELS: Record<TransitMode, string> = {
    bus: "Bus",
    tram: "Tram",
    train: "Train",
    subway: "Subway",
    ferry: "Ferry",
};

/** Format milliseconds-remaining as MM:SS (or H:MM:SS over an hour). */
export function formatTimeRemaining(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
}
