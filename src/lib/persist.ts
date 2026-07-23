/**
 * Defensive decoders for `@nanostores/persistent` atoms holding STRUCTURED
 * JSON (objects / arrays / FeatureCollections).
 *
 * nanostores calls `decode()` with NO try/catch — on the FIRST read AND on
 * every cross-tab `storage` event. A bare `JSON.parse` therefore throws
 * (a quota-TRUNCATED write, a concurrent-tab partial write, a schema-drifted
 * value from an older build) and the exception bubbles to the route's error
 * boundary, bricking the app on every reload with no self-heal — the exact
 * hazard the `questions` atom (context.ts) documents and `hiderRole.ts`
 * already guards against. This centralises that guard so the large structured
 * atoms (most likely to be quota-truncated) degrade to a fallback instead.
 *
 * Primitive atoms (boolean / number / small string enums) are deliberately
 * left on bare `JSON.parse`: a self-written primitive is a couple of bytes,
 * essentially never truncates, and a single corrupt toggle isn't route-fatal.
 */

/**
 * A `decode` that returns `fallback` on any parse failure. Pass an optional
 * `validate` (e.g. a zod `safeParse` wrapper) to also reject a well-formed but
 * wrong-shape value.
 */
export function safeJsonDecode<T>(
    fallback: T,
    validate?: (parsed: unknown) => T,
): (raw: string) => T {
    return (raw: string) => {
        try {
            const parsed: unknown = JSON.parse(raw);
            return validate ? validate(parsed) : (parsed as T);
        } catch {
            return fallback;
        }
    };
}
