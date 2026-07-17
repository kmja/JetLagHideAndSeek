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
 * Player roles (v829). The hide team is a UNIT: any number of equal
 * `hider`s share the hide (same zone + incoming questions + — in a
 * later track — the same hand). Everyone else `seek`s. The old
 * `coHider` / "main hider" distinction was removed; a stale client
 * sending `"coHider"` is coerced to `"hider"` server-side.
 */
export type Role = "seeker" | "hider";

/**
 * The hider's committed hiding zone, shared with the whole hide team
 * (every `hider`). Mirrors the client `HidingZone`
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

/**
 * The hide team's SHARED card economy (v831 Track 2). Every `hider`
 * draws / keeps / discards / plays from ONE deck, so the deck, hand,
 * discard pile, hand limit, Overflowing-Chalice charges, and any in-flight
 * draw-and-keep pick are held here as one blob. Like `HidingZoneShare`
 * it's a hide-team SECRET — NOT part of `GameState` (the seekers must
 * never see the hand), so the server keeps it out of the wholesale
 * snapshot and delivers it only to hide-team connections.
 *
 * The card shapes are opaque JSON to the wire (`unknown[]` / `unknown`):
 * the client owns the `Card` / `PendingDraw` types and the server just
 * relays the blob between hiders (the same treatment as `questions`).
 */
export interface DeckStateShare {
    hand: unknown[];
    deck: unknown[];
    discard: unknown[];
    handLimit: number;
    chalice: number;
    pending: unknown | null;
    pendingQueue: unknown[];
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
     * Unix ms when the seeker has *claimed* the endgame ("we're in your
     * zone"). Null during normal seeking. The hider's UI surfaces a
     * banner when this flips so they know to commit to their final spot
     * per the rulebook (p43). Server keeps it in SetupState so it rides
     * in the welcome snapshot for late joiners. A claim is provisional
     * until the hider responds (see `endgameConfirmedAt`).
     */
    endgameStartedAt: number | null;
    /**
     * Unix ms when the HIDER confirmed the seekers really are in their
     * zone (responding to the seeker's claim). Null while the claim is
     * still pending OR after a refute. The seeker's UI flips from
     * "waiting for the hider to confirm" to "you're in the right zone,
     * find them" when this is set. The tabletop rules leave this
     * implicit (co-located players just talk); the app makes the
     * positive confirmation explicit so a remote seeker isn't left
     * guessing whether the hider's silence means "yes" or "not looking
     * at my phone". Optional for back-compat with older snapshots.
     */
    endgameConfirmedAt?: number | null;
    /**
     * Unix ms until which the SEEKERS are frozen by a hider's Move
     * powerup (the end of the fresh hiding period Move grants). Null when
     * no freeze is active. Synced so the seeker device actually shows the
     * "seekers frozen — hold position" banner (it's otherwise a hider-local
     * atom). Rides the welcome snapshot for late joiners. Optional for
     * back-compat.
     */
    seekersFrozenUntil?: number | null;
    /**
     * The hider's transit-station location revealed to the seekers when a
     * Move powerup is played (Move's defining mechanic: "send the seekers
     * the location of your transit station"). The seeker map drops a
     * marker here. Null when no Move reveal is active; cleared each round.
     * Optional for back-compat.
     */
    revealedStation?: {
        lat: number;
        lng: number;
        name?: string;
    } | null;
    /**
     * Full Photon OSM feature for the host's selected play area
     * (`OpenStreetMap` on the client). Carries the extent / osm_id
     * the hider device needs so its settings dialog can recognise
     * the area instead of falling back to the persisted Japan
     * default. Typed as `unknown` on the wire — the client casts
     * on receipt; the server treats it as an opaque blob. Optional
     * for back-compat: snapshots produced by older deployments
     * land without it and the client keeps whatever value it
     * already had.
     */
    mapGeoLocation?: unknown;
    /**
     * Adjacent areas the host folded into the play area
     * (`AdditionalMapGeoLocations[]` on the client — each an OSM feature
     * + `added` flag). Without this the hide team's boundary was always
     * the primary area only, so a guest saw a smaller play area than the
     * host. Opaque blob on the wire; the client casts on receipt.
     * Optional for back-compat.
     */
    adjacentLocations?: unknown[];
    /**
     * Table-wide house rules (Settings → House rules, surfaced in the
     * lobby). Host-authoritative: the host edits them in the lobby and
     * pushes the whole setup; every device mirrors them so the whole
     * room plays by the same deviations from the printed rulebook.
     * Optional for back-compat — snapshots from older deployments land
     * without it and each device keeps its local values.
     */
    houseRules?: HouseRulesState;
}

/**
 * The opt-in house-rule toggles shared across the room. Each defaults
 * OFF to the printed rulebook; see `src/lib/houseRules.ts` for the
 * per-rule semantics.
 */
export interface HouseRulesState {
    alternateQuestionTypes: boolean;
    askOncePerQuestion: boolean;
    zoneRadiusBuffer: boolean;
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
