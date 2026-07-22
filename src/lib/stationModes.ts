import type { TransitMode } from "@/lib/gameSetup";

const VALID_MODES: ReadonlySet<string> = new Set([
    "subway",
    "train",
    "tram",
    "bus",
    "ferry",
]);

/**
 * Canonical encoding of a station's transit modes for a MapLibre point-feature
 * property. MapLibre feature properties must be primitives, so we pipe-join.
 * Both roles emit through this so the wire format is single-sourced.
 */
export function encodeStationModes(modes: readonly TransitMode[]): string {
    return modes.join("|");
}

/**
 * Decode a station point-feature `modes` property in ANY of the historical
 * encodings — a native array (the seeker's `StationPlace`), a pipe-joined
 * string `"a|b"` (the hider's point features), or a JSON array string (a
 * MapLibre-stringified array) — into a validated, de-duplicated `TransitMode[]`.
 *
 * v1120: used by BOTH roles' map-tap readers so the seeker and hider can no
 * longer parse the SAME feature's modes differently (the three-way encoding
 * inconsistency the review flagged).
 */
export function decodeStationModes(raw: unknown): TransitMode[] {
    let arr: unknown[] | null = null;
    if (Array.isArray(raw)) {
        arr = raw;
    } else if (typeof raw === "string" && raw.length > 0) {
        if (raw.startsWith("[")) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) arr = parsed;
            } catch {
                /* not JSON — fall through to pipe-split */
            }
        }
        if (!arr) arr = raw.split("|");
    }
    if (!arr) return [];
    const out: TransitMode[] = [];
    for (const m of arr) {
        if (typeof m === "string" && VALID_MODES.has(m) && !out.includes(m as TransitMode)) {
            out.push(m as TransitMode);
        }
    }
    return out;
}
