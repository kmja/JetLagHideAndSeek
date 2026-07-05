/**
 * v667: Overpass "soft failure" detection. When the interpreter hits
 * its server-side time/memory limit it returns HTTP 200 whose JSON body
 * carries a `remark` like `runtime error: Query timed out in "query" at
 * line 4 after 26 seconds.` — with `elements` empty or silently
 * truncated. Treating that as a win is how "hiding zones say loaded but
 * the map is empty" happened: the aborted body got cached (browser
 * Cache API AND the worker's R2) and every retry re-served the poison.
 * Any runtime-error remark means the query was aborted server-side, so
 * the body is a FAILURE regardless of how many elements made it out.
 *
 * Pure helpers (no imports) so both `getOverpassData`'s race and the
 * unit tests use them directly; the overpass-cache worker mirrors the
 * same sniff on its write + read paths (`isAbortedOverpassText` in
 * `overpass-cache/src/index.ts`).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const isAbortedOverpassJson = (json: any): boolean =>
    !!json &&
    typeof json.remark === "string" &&
    /runtime error|timed out|out of memory/i.test(json.remark);

/** Byte-level abort sniff for a raced response body. Overpass appends
 *  the `remark` at the END of the JSON, so the tail pre-check keeps the
 *  common (clean, possibly huge) body cheap — the full parse only runs
 *  when the tail actually contains a remark key. Gzip-magic bodies
 *  (legacy poisoned cache entries) are left to
 *  `safeJsonFromCachedResponse`'s healing path downstream. */
export const sniffAbortedOverpassBytes = (bytes: Uint8Array): boolean => {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        return false;
    }
    const tail = new TextDecoder().decode(
        bytes.subarray(Math.max(0, bytes.length - 4096)),
    );
    if (!tail.includes('"remark"')) return false;
    try {
        return isAbortedOverpassJson(
            JSON.parse(new TextDecoder().decode(bytes)),
        );
    } catch {
        return false;
    }
};
