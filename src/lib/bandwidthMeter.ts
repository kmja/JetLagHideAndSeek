/**
 * Scope-based byte counter for "how much did the user actually download
 * over the wire?". The preload flow opens a scope per bucket, runs its
 * fetches, then closes the scope and reads the total.
 *
 * Data source is `cacheFetch`: on a cache MISS the response's
 * `Content-Length` header is recorded into every active scope. For
 * gzipped responses from our worker / Cloudflare edge, `Content-Length`
 * is the on-the-wire (compressed) size — which is what mobile users
 * actually pay for in data. Cache hits record zero bytes (the data was
 * already on disk; nothing crossed the network).
 *
 * Multiple concurrent scopes work — the preload of `references` and
 * `transit` can both be open at once, and every cache-miss byte count
 * adds to both totals.
 */

const activeScopes = new Map<string, number>();

/** Open a fresh measurement scope. Resets to zero if a scope with the
 *  same name already existed. */
export function startMeter(name: string): void {
    activeScopes.set(name, 0);
}

/** Close a measurement scope and return its accumulated bytes. */
export function stopMeter(name: string): number {
    const total = activeScopes.get(name) ?? 0;
    activeScopes.delete(name);
    return total;
}

/** Called by `cacheFetch` after a cache-miss fetch resolves. Adds the
 *  response's wire bytes to every currently-open scope. No-op when no
 *  scopes are active, so this is cheap to call unconditionally. */
export function recordBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    if (activeScopes.size === 0) return;
    for (const [name, total] of activeScopes) {
        activeScopes.set(name, total + bytes);
    }
}
