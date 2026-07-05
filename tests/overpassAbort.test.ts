import { describe, expect, it } from "vitest";

import {
    isAbortedOverpassJson,
    sniffAbortedOverpassBytes,
} from "../src/maps/api/overpassAbort";

const enc = (s: string) => new TextEncoder().encode(s);

/** The real shape Overpass returns on a soft timeout: HTTP 200, empty
 *  elements, and the abort reason in `remark`. */
const timedOutBody = JSON.stringify({
    version: 0.6,
    generator: "Overpass API 0.7.62.1",
    osm3s: { timestamp_osm_base: "2026-07-05T00:00:00Z" },
    elements: [],
    remark: 'runtime error: Query timed out in "query" at line 4 after 26 seconds.',
});

const cleanBody = JSON.stringify({
    version: 0.6,
    elements: [{ type: "node", id: 1, lat: 1, lon: 2, tags: { name: "X" } }],
});

describe("isAbortedOverpassJson", () => {
    it("flags a timed-out remark", () => {
        expect(isAbortedOverpassJson(JSON.parse(timedOutBody))).toBe(true);
    });

    it("flags an out-of-memory remark", () => {
        expect(
            isAbortedOverpassJson({
                elements: [],
                remark: "runtime error: Query ran out of memory in ...",
            }),
        ).toBe(true);
    });

    it("passes a clean body", () => {
        expect(isAbortedOverpassJson(JSON.parse(cleanBody))).toBe(false);
    });

    it("passes a non-abort remark", () => {
        expect(
            isAbortedOverpassJson({ elements: [], remark: "some note" }),
        ).toBe(false);
    });

    it("passes null / undefined / non-objects", () => {
        expect(isAbortedOverpassJson(null)).toBe(false);
        expect(isAbortedOverpassJson(undefined)).toBe(false);
        expect(isAbortedOverpassJson("runtime error")).toBe(false);
    });
});

describe("sniffAbortedOverpassBytes", () => {
    it("flags a poisoned body", () => {
        expect(sniffAbortedOverpassBytes(enc(timedOutBody))).toBe(true);
    });

    it("passes a clean body", () => {
        expect(sniffAbortedOverpassBytes(enc(cleanBody))).toBe(false);
    });

    it("flags a truncated-but-large body whose remark sits past 4 KB", () => {
        // Overpass appends the remark at the END, so the tail check
        // still sees it even when the elements payload is huge.
        const big = JSON.stringify({
            elements: Array.from({ length: 500 }, (_, i) => ({
                type: "node",
                id: i,
                lat: 1,
                lon: 2,
                tags: { name: `station ${i}` },
            })),
            remark: "runtime error: Query timed out after 26 seconds.",
        });
        expect(big.length).toBeGreaterThan(4096);
        expect(sniffAbortedOverpassBytes(enc(big))).toBe(true);
    });

    it('ignores a "remark" that is only element content', () => {
        const body = JSON.stringify({
            elements: [
                {
                    type: "node",
                    id: 1,
                    tags: { remark: "runtime error mentioned in a tag" },
                },
            ],
        });
        expect(sniffAbortedOverpassBytes(enc(body))).toBe(false);
    });

    it("leaves gzip-magic bodies to the downstream healing path", () => {
        const gz = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);
        expect(sniffAbortedOverpassBytes(gz)).toBe(false);
    });

    it("passes invalid JSON that happens to contain the remark key", () => {
        expect(
            sniffAbortedOverpassBytes(enc('garbage "remark" runtime error')),
        ).toBe(false);
    });
});
