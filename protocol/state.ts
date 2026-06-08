/**
 * Server-side canonical game state. This is what the GameRoom DO
 * holds in memory, and what every connected client mirrors via
 * snapshots and incremental updates.
 *
 * Deliberately treats question payloads as opaque JSON — the server
 * doesn't need to understand the question internals, it just fans
 * them out to participants. That keeps the worker code free of the
 * zod / leaflet / turf chain.
 */

/**
 * Player roles. One `hider` per room; `coHider`s are hide-team
 * teammates who watch the same hide (zone + incoming questions) but
 * don't own the canonical hider state; everyone else `seek`s.
 */
export type Role = "seeker" | "hider" | "coHider";

/**
 * The hider's committed hiding zone, shared with the hide team (the
 * primary hider + any co-hiders). Mirrors the client `HidingZone`
 * shape. Deliberately NOT part of `GameState`: it's a secret from the
 * seekers, so the server keeps it out of the wholesale snapshot and
 * delivers it only to hide-team connections.
 */
export interface HidingZoneShare {
    stationName: string;
    stationLat: number;
    stationLng: number;
    radiusMeters: number;
    committedAt: number;
}

export type TransitMode = "bus" | "tram" | "train" | "subway" | "ferry";
export type GameSize = "small" | "medium" | "large";

/**
 * Participant identity is per-device. Display name is shown to peers;
 * device id is the stable handle the server uses to match
 * reconnects to existing rosters.
 */
export interface Participant {
    /** Server-assigned. Stable across reconnects within a session. */
    id: string;
    /** Self-reported. Empty string is allowed; UI falls back to "anonymous". */
    displayName: string;
    /** Null until the host picks a role for the participant. */
    role: Role | null;
    /** Unix ms — when they first joined. */
    joinedAt: number;
    /** Live connection flag, maintained by the DO. */
    online: boolean;
}

/**
 * Setup state mirrors what the local seeker writes to
 * `playArea` / `allowedTransit` / `gameSize` / `hidingPeriodEndsAt`
 * via the wizard. The hider needs all of it for the correct phase
 * detection and zone radius calculation.
 */
export interface SetupState {
    playArea: {
        displayName: string;
        lat: number;
        lng: number;
    } | null;
    allowedTransit: TransitMode[];
    gameSize: GameSize;
    /** Unix ms; null before the host starts the game. */
    hidingPeriodEndsAt: number | null;
    /**
     * Unix ms when the seeker has triggered the endgame ("I'm close —
     * lock down"). Null during normal seeking. The hider's UI surfaces
     * a banner when this flips so they know to commit to their final
     * spot per the rulebook (p43). Server keeps it in SetupState so it
     * rides in the welcome snapshot for late joiners.
     */
    endgameStartedAt: number | null;
}

/**
 * Full snapshot of the room. Sent to a client on join / resume / on
 * explicit request. Small enough to ship in full on every reconnect;
 * if it grows, we can switch to incremental sync later.
 */
export interface GameState {
    /** 6-char alphanumeric game code. */
    code: string;
    /** Unix ms when the host created the room. */
    createdAt: number;
    setup: SetupState;
    /** Questions in insertion order. Opaque from the server's POV. */
    questions: unknown[];
    /** Unix ms when the seeker marked the hider found; null while playing. */
    roundFoundAt: number | null;
    participants: Participant[];
}

/**
 * Maximum players in a room. 1 hider + N seekers, with N capped so
 * the DO doesn't grow unbounded. Locked by transport invariants; the
 * server rejects further joins beyond this.
 */
export const MAX_PARTICIPANTS = 5;

/** How many milliseconds of zero connections triggers a room evict. */
export const IDLE_EVICTION_MS = 30 * 60 * 1000;

/**
 * Hard ceiling on a room's total lifetime, regardless of activity.
 * Defends against a buggy or malicious client that pings forever to
 * keep an unused room from idling out.
 *
 * Sizing: the longest Jet Lag rounds (the multi-team European ones
 * the show runs) can go ~12 hours of seeking on top of a 3 h hiding
 * period — call it 15 hours of in-game time, plus a buffer for
 * setup / debrief / "we're stopping for dinner". 18 h covers that
 * realistically while still putting an outer bound on how long a
 * room can hold a DO slot. If you ever run truly marathon events,
 * bumping this is a single-constant change followed by a redeploy.
 */
export const MAX_ROOM_LIFETIME_MS = 18 * 60 * 60 * 1000;

/**
 * Cap on the number of questions stored in a single room. A
 * normal game has under 30. 200 is a hard ceiling so an abusive
 * client can't pump the room's memory footprint up arbitrarily
 * (every new question gets broadcast to everyone, amplifying the
 * attack).
 */
export const MAX_QUESTIONS_PER_ROOM = 200;

/**
 * Cap on the size of a single incoming WebSocket frame. The
 * happy-path messages are well under 4 KB; a 64 KB ceiling leaves
 * room for hand-shaped question payloads (long location names,
 * polygon coordinates) but blocks the "send a 5 MB blob 1000
 * times" attack outright.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024;
