/**
 * Re-exports of shared protocol types under the local `multiplayer/`
 * namespace, plus a couple of client-only types that don't belong
 * in the on-the-wire protocol.
 */

export type { TransportStatus } from "./transport";
export type {
    ClientMessage,
    GameState,
    Participant,
    Role,
    ServerMessage,
    SetupState,
} from "@protocol/index";
