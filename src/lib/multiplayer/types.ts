/**
 * Re-exports of shared protocol types under the local `multiplayer/`
 * namespace, plus a couple of client-only types that don't belong
 * in the on-the-wire protocol.
 */

export type {
    GameState,
    Participant,
    Role,
    SetupState,
    ClientMessage,
    ServerMessage,
} from "@protocol/index";

export type { TransportStatus } from "./transport";
