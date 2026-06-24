/// <reference lib="webworker" />

/**
 * Custom Service Worker — replaces the vite-plugin-pwa generateSW output.
 *
 * Switching to `injectManifest` lets us add a `push` event handler so the
 * browser can deliver OS notifications even when every tab is closed or the
 * app is fully suspended. The Workbox precaching manifest is injected by
 * vite-plugin-pwa at build time (replaces `self.__WB_MANIFEST`).
 *
 * Runtime-caching config mirrors the old workbox: block in vite.config.ts.
 */

import { clientsClaim } from "workbox-core";
import {
    cleanupOutdatedCaches,
    createHandlerBoundToURL,
    precacheAndRoute,
} from "workbox-precaching";
import {
    NavigationRoute,
    registerRoute,
    setCatchHandler,
} from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

self.addEventListener("install", () => self.skipWaiting());
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA fallback: unknown navigations serve the precached index.html.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

/* ────────────────── Runtime caching ────────────────── */

/* PMTiles basemap range cache (v493).
 *
 * The vector basemap is one large PMTiles file on R2, read via HTTP
 * byte-range requests (the `pmtiles://` protocol + the map-preload tile
 * walk both issue them). The old design leaned on the browser's NATIVE
 * HTTP cache to persist those `206 Partial Content` responses — but
 * browsers (mobile Chrome especially) cache partial responses into a
 * huge resource unreliably, so "preloaded" ranges kept getting
 * re-fetched and every pan/zoom paid seconds of network latency.
 *
 * Here we persist each range EXPLICITLY in a dedicated Cache Storage
 * bucket. The Cache API can't store a 206, so we stash the body as a
 * 200 with the original `Content-Range` in a side header and rebuild the
 * 206 on a hit. The synthetic key is `URL + ?__range=<header>`, which is
 * deterministic per tile (the PMTiles directory maps each tile to a
 * fixed byte range), so the live map and the preload walk share entries.
 *
 * Only single byte-range GETs are handled; whole-file GETs (the city
 * tile pack) and HEAD probes pass straight through to the network (the
 * browser caches the immutable whole-file response well on its own).
 * Any network failure rethrows so the catch handler emits its 503 —
 * we never synthesize a body for a failed fetch. */
const PMTILES_RANGE_CACHE = "tiles-pmtiles-ranges";
/* ~a handful of cities' worth of z11-15 tiles + directories. FIFO-trimmed
 * so the bucket can't grow without bound and trip the quota. */
const PMTILES_RANGE_MAX_ENTRIES = 8000;
let pmtilesPutsSinceTrim = 0;

async function trimPmtilesRangeCache(): Promise<void> {
    // Amortise: only sweep occasionally, not on every tile write.
    if (++pmtilesPutsSinceTrim < 250) return;
    pmtilesPutsSinceTrim = 0;
    const cache = await caches.open(PMTILES_RANGE_CACHE);
    const keys = await cache.keys();
    const over = keys.length - PMTILES_RANGE_MAX_ENTRIES;
    if (over <= 0) return;
    // cache.keys() preserves insertion order → delete the oldest first.
    for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}

registerRoute(
    ({ url, request }: { url: URL; request: Request }) =>
        request.method === "GET" && /\/tiles\/.+\.pmtiles$/i.test(url.pathname),
    async ({ request, event }: { request: Request; event: ExtendableEvent }) => {
        const range = request.headers.get("range");
        // Whole-file GET (tile pack) → let the browser's HTTP cache handle
        // the complete immutable response; nothing range-specific to do.
        if (!range) return fetch(request);

        const cache = await caches.open(PMTILES_RANGE_CACHE);
        const keyUrl = new URL(request.url);
        keyUrl.searchParams.set("__range", range);
        const cacheKey = keyUrl.toString();

        const hit = await cache.match(cacheKey);
        if (hit) {
            const buf = await hit.arrayBuffer();
            const headers = new Headers({
                "Content-Type": "application/octet-stream",
                "Accept-Ranges": "bytes",
                "Content-Length": String(buf.byteLength),
            });
            const cr = hit.headers.get("X-Orig-Content-Range");
            if (cr) headers.set("Content-Range", cr);
            return new Response(buf, { status: cr ? 206 : 200, headers });
        }

        // Miss → network (forwards the Range header). A throw here
        // propagates to the catch handler, which returns a clean 503.
        const resp = await fetch(request);
        if (resp.status !== 206 && resp.status !== 200) return resp;

        const buf = await resp.arrayBuffer();
        const cr = resp.headers.get("Content-Range");
        const storeHeaders = new Headers({
            "Content-Type": "application/octet-stream",
        });
        if (cr) storeHeaders.set("X-Orig-Content-Range", cr);
        event.waitUntil(
            cache
                .put(cacheKey, new Response(buf, { status: 200, headers: storeHeaders }))
                .then(() => trimPmtilesRangeCache())
                .catch(() => {}),
        );
        const headers = new Headers({
            "Content-Type": "application/octet-stream",
            "Accept-Ranges": "bytes",
            "Content-Length": String(buf.byteLength),
        });
        if (cr) headers.set("Content-Range", cr);
        return new Response(buf, { status: resp.status, headers });
    },
);

registerRoute(
    ({ url }: { url: URL }) =>
        /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/.*\.png/i.test(url.href),
    new CacheFirst({
        cacheName: "tiles-carto",
        plugins: [
            new ExpirationPlugin({ maxEntries: 6000, maxAgeSeconds: 60 * 24 * 60 * 60, purgeOnQuotaError: true }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) =>
        /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\//i.test(url.href),
    new CacheFirst({
        cacheName: "tiles-satellite",
        plugins: [
            new ExpirationPlugin({ maxEntries: 4000, maxAgeSeconds: 60 * 24 * 60 * 60, purgeOnQuotaError: true }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) =>
        /^https:\/\/(tile|[a-c]\.tile)\.openstreetmap\.org\//i.test(url.href),
    new CacheFirst({
        cacheName: "tiles-osm",
        plugins: [
            new ExpirationPlugin({ maxEntries: 3000, maxAgeSeconds: 60 * 24 * 60 * 60, purgeOnQuotaError: true }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) => /^https:\/\/tile\.thunderforest\.com\//i.test(url.href),
    new CacheFirst({
        cacheName: "tiles-thunderforest",
        plugins: [
            new ExpirationPlugin({ maxEntries: 3000, maxAgeSeconds: 60 * 24 * 60 * 60, purgeOnQuotaError: true }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) => /^https:\/\/photon\.komoot\.io\//i.test(url.href),
    new StaleWhileRevalidate({
        cacheName: "api-geocode",
        plugins: [
            new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60, purgeOnQuotaError: true }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) => /\/coastline50\.geojson$/i.test(url.href),
    new CacheFirst({
        cacheName: "asset-coastline",
        plugins: [
            new ExpirationPlugin({ maxEntries: 1, maxAgeSeconds: 365 * 24 * 60 * 60, purgeOnQuotaError: true }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

/* v233: Protomaps glyph fonts (label rendering). Small finite set,
 * worth caching aggressively so offline / poor-signal sessions still
 * render labels. The actual PMTiles file isn't cached here — it uses
 * HTTP byte-range requests which Workbox's strategies don't preserve
 * cleanly, and the worker emits `Cache-Control: immutable` so the
 * browser's native HTTP cache handles it correctly. */
registerRoute(
    ({ url }: { url: URL }) =>
        /^https:\/\/protomaps\.github\.io\/basemaps-assets\//i.test(url.href),
    new CacheFirst({
        cacheName: "protomaps-glyphs",
        plugins: [
            new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 365 * 24 * 60 * 60, purgeOnQuotaError: true }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

/* ────────────────── Catch handler ────────────────── */

/**
 * When a registered route's strategy throws — CacheFirst gets a cache
 * miss AND the network fetch fails — Workbox lets the rejection reach
 * `respondWith()`.
 *
 * History:
 *   - v140 returned `Response.error()` → Firefox flagged it as "SW sent
 *     an Error Response, invalid fetch() call".
 *   - v142 returned a 200 transparent PNG for image requests → fixed
 *     Firefox but caused two new problems: (1) MapLibre crashes with
 *     "DOMException: object is no longer usable" when a cancelled tile
 *     fetch races against the synthesized response, and (2) a
 *     legitimately-failed tile gets cached as transparent forever
 *     (CacheableResponsePlugin's `statuses: [0,200]` includes our 200)
 *     — making the picker map look dark and empty on subsequent loads.
 *
 * The right answer is to return an opaque non-cacheable error response:
 *   - Body `null` so there's no stream that can be consumed.
 *   - Status `503` is filtered out by CacheableResponsePlugin's default
 *     statuses, so the failure isn't poisoned into the cache.
 *   - It's a real Response (not Response.error()), so Firefox doesn't
 *     complain about the SW returning an invalid value, and there's no
 *     stream to race against MapLibre's cancellation.
 *
 * MapLibre treats a 5xx the same way it treated v140's Response.error()
 * (a single quiet network-error log line, no CORS trio), but without
 * the DOMException trace.
 */
setCatchHandler(async () =>
    new Response(null, {
        status: 503,
        statusText: "Service Worker offline-fallback",
    }),
);

/* ────────────────── Push notifications ────────────────── */

interface PushPayload {
    title: string;
    body?: string;
    tag?: string;
}

self.addEventListener("push", (event: PushEvent) => {
    let data: PushPayload | null = null;
    try {
        data = event.data?.json() as PushPayload;
    } catch {
        return;
    }
    if (!data?.title) return;

    const { title, body, tag } = data;

    event.waitUntil(
        (async () => {
            // If any client window is currently visible, the app's own
            // in-tab notify() handles it via the WebSocket message.
            // Skip the OS notification to avoid a double-ding.
            const clients = await self.clients.matchAll({
                type: "window",
                includeUncontrolled: true,
            });
            const anyVisible = clients.some(
                (c) => (c as WindowClient).visibilityState === "visible",
            );
            if (anyVisible) return;

            await self.registration.showNotification(title, {
                body,
                tag,
                icon: "/android-chrome-192x192.png",
                badge: "/favicon-32x32.png",
                data: { url: "/" },
            });
        })(),
    );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
    event.notification.close();
    const targetUrl: string = (event.notification.data?.url as string) ?? "/";

    event.waitUntil(
        (async () => {
            const clients = await self.clients.matchAll({
                type: "window",
                includeUncontrolled: true,
            });
            const existing = clients.find((c) =>
                c.url.startsWith(self.registration.scope),
            );
            if (existing) {
                await (existing as WindowClient).focus();
            } else {
                await self.clients.openWindow(targetUrl);
            }
        })(),
    );
});
