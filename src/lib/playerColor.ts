/**
 * Per-player identity colour (v861). Inspired by the Jet Lag show's standings
 * screen, where every competitor owns a colour. Each participant gets a stable
 * colour derived purely from their (server-assigned, room-shared) id — so every
 * device computes the SAME colour for the same player with no extra wire sync.
 *
 * The pool is drawn from the show palette but DELIBERATELY EXCLUDES the brand
 * red (`--primary`): red is reserved for buttons / the seeker chrome, so a
 * player never wears it. Every colour here also passes white-text contrast for
 * an initialed avatar.
 *
 * Shared so the same colour can mark a player across surfaces — the lobby
 * roster now, and (future) the leaderboard rows + live seeker map pins, exactly
 * where the show uses them.
 */
export const PLAYER_COLORS = [
    "#2e9e52", // green
    "#2f7bd0", // blue
    "#d9631c", // orange
    "#8b58a6", // purple
    "#2c8b99", // teal
    "#c94f86", // pink
    "#5b62c9", // indigo
    "#b7791f", // amber
] as const;

function hashIndex(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
        h = (h * 31 + id.charCodeAt(i)) >>> 0;
    }
    return h % PLAYER_COLORS.length;
}

/** Stable colour for a participant id (hash → pool). Same on every device.
 *  Standalone fallback for surfaces without the full roster (e.g. a lone map
 *  pin). Within a roster prefer {@link assignPlayerColors}, which guarantees
 *  DISTINCT colours — a bare hash can collide (two players, same colour). */
export function playerColor(id: string): string {
    return PLAYER_COLORS[hashIndex(id)];
}

/**
 * Assign a DISTINCT colour to every id in a room (v862 — fixes two players
 * sharing a colour). Each id prefers its hash colour; if that's already taken
 * it linear-probes to the next free one, so colours stay mostly tied to the
 * player yet never collide (until there are more players than pool colours —
 * impossible at MAX_PARTICIPANTS=5 < 8). Deterministic across devices: ids are
 * processed in sorted order, and the id set is the same everywhere.
 */
export function assignPlayerColors(ids: string[]): Record<string, string> {
    const used = new Set<string>();
    const out: Record<string, string> = {};
    for (const id of [...ids].sort()) {
        const start = hashIndex(id);
        let colour = PLAYER_COLORS[start];
        if (used.has(colour)) {
            for (let k = 1; k < PLAYER_COLORS.length; k++) {
                const c = PLAYER_COLORS[(start + k) % PLAYER_COLORS.length];
                if (!used.has(c)) {
                    colour = c;
                    break;
                }
            }
        }
        used.add(colour);
        out[id] = colour;
    }
    return out;
}

/** Up-to-two-letter initials for an avatar: first letters of the first and
 *  last word, or the first two letters of a single word. */
export function playerInitials(name: string): string {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (
        parts[0][0] + parts[parts.length - 1][0]
    ).toUpperCase();
}
