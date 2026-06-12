/**
 * Developer-only local-state nukes. Used by the debug panel to
 * simulate a first-time player: wipe every persistence tier the app
 * touches, then hard-reload to the seeker root so the Welcome screen
 * takes over (welcomeSeen lives in localStorage, so clearing it is
 * what brings Welcome back).
 *
 * Tiers cleared, in rough order of importance:
 *   - localStorage   — every nanostores persistent atom (welcomeSeen,
 *                      playerRole, questions, game setup, hider deck,
 *                      display name, tile prefs, …).
 *   - sessionStorage — the answer-view dismissal flag and friends.
 *   - Cache API       — boundary cache, Overpass response caches, map
 *                      tiles, geocoder results, the coastline asset.
 *   - IndexedDB       — defensive; the app doesn't use it today, but a
 *                      future lib might, and a "clear everything" button
 *                      that misses a tier is a debugging trap.
 *   - Service workers — unregister so the workbox precache is dropped
 *                      and the next load re-fetches fresh, the way a
 *                      genuine first visit would.
 *
 * Every step is best-effort and individually try/caught: a browser
 * that blocks one tier (Safari private mode, embedded webview) must
 * not prevent the others from clearing or the reload from happening.
 */
export async function clearAllLocalDataAndReload(): Promise<void> {
    await clearCacheStorage();
    await clearIndexedDb();
    await unregisterServiceWorkers();
    try {
        localStorage.clear();
    } catch {
        /* storage blocked */
    }
    try {
        sessionStorage.clear();
    } catch {
        /* storage blocked */
    }
    // replace() (not assign()) so the debug URL doesn't linger in
    // history, and "/" so we boot the seeker shell where Welcome lives.
    if (typeof window !== "undefined") {
        window.location.replace("/");
    }
}

async function clearCacheStorage(): Promise<void> {
    try {
        if (typeof caches === "undefined") return;
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
    } catch (e) {
        console.warn("clearCacheStorage failed:", e);
    }
}

async function clearIndexedDb(): Promise<void> {
    try {
        if (
            typeof indexedDB === "undefined" ||
            typeof indexedDB.databases !== "function"
        ) {
            return;
        }
        const dbs = await indexedDB.databases();
        await Promise.all(
            dbs.map(
                (db) =>
                    new Promise<void>((resolve) => {
                        if (!db.name) return resolve();
                        const req = indexedDB.deleteDatabase(db.name);
                        req.onsuccess =
                            req.onerror =
                            req.onblocked =
                                () => resolve();
                    }),
            ),
        );
    } catch (e) {
        console.warn("clearIndexedDb failed:", e);
    }
}

async function unregisterServiceWorkers(): Promise<void> {
    try {
        if (
            typeof navigator === "undefined" ||
            !("serviceWorker" in navigator)
        ) {
            return;
        }
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
    } catch (e) {
        console.warn("unregisterServiceWorkers failed:", e);
    }
}
