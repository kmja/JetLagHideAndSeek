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

/** Stable colour for a participant id (hash → pool). Same on every device. */
export function playerColor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
        h = (h * 31 + id.charCodeAt(i)) >>> 0;
    }
    return PLAYER_COLORS[h % PLAYER_COLORS.length];
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
