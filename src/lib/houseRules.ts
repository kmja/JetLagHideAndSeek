import { persistentAtom } from "@nanostores/persistent";
import { convertLength } from "@turf/turf";

import { hidingRadius, hidingRadiusUnits } from "@/lib/context";

/**
 * House-rule toggles (Settings → House rules). Each one shifts a
 * single mechanic AWAY from the printed rulebook, so the default is
 * the rulebook value and turning the toggle ON gives the table a
 * stricter / different feel.
 *
 *   • alternateQuestionTypes — RULEBOOK off: the seeker can ask two
 *     questions of the same category in a row. House rule ON: the
 *     v395 alternation gate (you must alternate types — no "back-to-
 *     back" same category). Useful for tables that want more variety
 *     in the question stream than the rulebook requires.
 *
 *   • askOncePerQuestion — RULEBOOK off: a question can be asked
 *     again at increased cost (2×, 3×, … per rulebook p65 — the
 *     hider runs the draw-keep cycle that many times in a row).
 *     House rule ON: each question / subtype / preset can only be
 *     asked once per game. This was the previous app behaviour;
 *     some groups prefer it because it forces topic variety and
 *     prevents an aggressive seeker from grinding the same question
 *     for cards.
 *
 * Persistent so the table's preference survives reloads; not synced
 * over multiplayer — the host's setting governs the room because the
 * picker UI lives on the seeker device, but the hider's draw multi-
 * plier is derived locally from the inbox.
 */
export const alternateQuestionTypes = persistentAtom<boolean>(
    "houseRule:alternateQuestionTypes",
    false,
    {
        encode: (v) => (v ? "1" : ""),
        decode: (v) => v === "1",
    },
);

export const askOncePerQuestion = persistentAtom<boolean>(
    "houseRule:askOncePerQuestion",
    false,
    {
        encode: (v) => (v ? "1" : ""),
        decode: (v) => v === "1",
    },
);

/**
 * zoneRadiusBuffer — RULEBOOK off: relative questions (radar /
 * thermometer / measuring) eliminate as EXACT point constraints, the way
 * the printed rulebook frames them (a radar "asks about your location,
 * not your hiding zone" — p234). Because the hider may roam their whole
 * zone before the endgame, an unlucky sequence of answers given from
 * different points inside the zone CAN carve away the true hiding spot.
 *
 * House rule ON: widen each relative-question cut by the hiding-zone
 * radius, so a region is only eliminated when it's inconsistent for the
 * ENTIRE zone (no point within `hidingRadius` could have produced the
 * answer). This makes it mathematically impossible to eliminate the true
 * zone from hider movement alone — at the cost of a looser map that
 * eliminates a little less area per question. Off by default because it
 * deviates from how the rulebook scopes these questions.
 */
export const zoneRadiusBuffer = persistentAtom<boolean>(
    "houseRule:zoneRadiusBuffer",
    false,
    {
        encode: (v) => (v ? "1" : ""),
        decode: (v) => v === "1",
    },
);

/**
 * The active relative-question elimination buffer, in kilometres. Returns
 * 0 when the `zoneRadiusBuffer` house rule is off (so the elimination
 * engine behaves exactly as before). Otherwise converts the seeker's
 * configured hiding-zone radius to km. Read directly by the relative
 * adjusters (`radius` / `measuring` / `thermometer`).
 */
export const zoneBufferKm = (): number => {
    if (!zoneRadiusBuffer.get()) return 0;
    const r = hidingRadius.get();
    if (!Number.isFinite(r) || r <= 0) return 0;
    try {
        return convertLength(r, hidingRadiusUnits.get(), "kilometers");
    } catch {
        return 0;
    }
};
