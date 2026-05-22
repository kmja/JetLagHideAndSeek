/**
 * Wire-protocol version. Bumped whenever a breaking change is made to
 * the message shapes in `./messages.ts` so the server can reject
 * incompatible clients with a clear error instead of misinterpreting
 * fields. Patch-level changes (adding new optional fields, new message
 * variants) shouldn't bump this.
 */
export const PROTOCOL_VERSION = 1 as const;
