/**
 * Shared display-name pool + unique-name picker.
 *
 * Imported by BOTH the client (placeholder hints, demo bots) and the
 * server (authoritative participant naming). The server is the only
 * place that can guarantee uniqueness across players, so it owns the
 * final assignment — see GameRoom's uniqueDisplayName().
 *
 * Default names are the first names of Jet Lag: The Game hosts and
 * recurring YouTube guests/competitors, so an un-named player still
 * shows up as someone from the show. Once that roster is used up the
 * picker falls back to a generic first-name pool, then to numeric
 * suffixes — so it never repeats and never runs dry.
 */

/** Hosts + recurring guests/competitors from the show. */
export const JETLAG_CAST_NAMES = [
    "Sam",
    "Ben",
    "Adam",
    "Toby",
    "Brian",
    "Joseph",
    "Sabrina",
    "Michelle",
    "Tom",
    "Nikki",
    "Jeannie",
    "Scott",
] as const;

/** Generic first-name pool, used once the cast roster is exhausted. */
const FALLBACK_NAMES = [
    "Alex",
    "Jordan",
    "Riley",
    "Casey",
    "Morgan",
    "Quinn",
    "Avery",
    "Jamie",
    "Taylor",
    "Robin",
    "Drew",
    "Charlie",
    "Skyler",
    "Reese",
    "Parker",
    "Rowan",
] as const;

/** A random cast name. For purely cosmetic uses (input placeholders)
 *  where collisions don't matter. */
export function pickRandomCastName(): string {
    return JETLAG_CAST_NAMES[
        Math.floor(Math.random() * JETLAG_CAST_NAMES.length)
    ];
}

/**
 * Pick a display name not already in `taken` (case-insensitive).
 *
 *   1. A random unused Jet Lag cast name.
 *   2. If the cast roster is exhausted, a random unused generic name.
 *   3. If both pools are exhausted, the first pool name with the
 *      lowest numeric suffix that's still free ("Sam 2", "Sam 3", …).
 *
 * Guaranteed to return a string not in `taken`.
 */
export function pickUniqueName(taken: Iterable<string>): string {
    const takenSet = new Set(
        [...taken].map((n) => n.trim().toLowerCase()).filter(Boolean),
    );
    const free = (pool: readonly string[]) =>
        pool.filter((n) => !takenSet.has(n.toLowerCase()));

    const freeCast = free(JETLAG_CAST_NAMES);
    if (freeCast.length > 0) {
        return freeCast[Math.floor(Math.random() * freeCast.length)];
    }
    const freeFallback = free(FALLBACK_NAMES);
    if (freeFallback.length > 0) {
        return freeFallback[
            Math.floor(Math.random() * freeFallback.length)
        ];
    }
    // Both pools exhausted (12+ cast + 16 generic = 28 names taken).
    // Suffix a base name until we find a free slot.
    const base = pickRandomCastName();
    for (let i = 2; ; i++) {
        const candidate = `${base} ${i}`;
        if (!takenSet.has(candidate.toLowerCase())) return candidate;
    }
}

/**
 * Resolve a requested display name to a unique one given the names
 * already in use. Empty/whitespace requests get an assigned cast name;
 * a non-empty request is kept if free, otherwise reassigned to a
 * unique name. Case-insensitive collision check.
 */
export function resolveUniqueDisplayName(
    requested: string | undefined,
    taken: Iterable<string>,
): string {
    const trimmed = (requested ?? "").trim();
    const takenSet = new Set(
        [...taken].map((n) => n.trim().toLowerCase()).filter(Boolean),
    );
    if (trimmed && !takenSet.has(trimmed.toLowerCase())) return trimmed;
    return pickUniqueName(takenSet);
}
