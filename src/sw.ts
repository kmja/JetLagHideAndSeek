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

registerRoute(
    ({ url }: { url: URL }) =>
        /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/.*\.png/i.test(url.href),
    new CacheFirst({
        cacheName: "tiles-carto",
        plugins: [
            new ExpirationPlugin({ maxEntries: 6000, maxAgeSeconds: 60 * 24 * 60 * 60 }),
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
            new ExpirationPlugin({ maxEntries: 4000, maxAgeSeconds: 60 * 24 * 60 * 60 }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) =>
        /^https:\/\/(tiles|[a-d]\.tiles)\.openrailwaymap\.org\//i.test(url.href),
    new CacheFirst({
        cacheName: "tiles-railway",
        plugins: [
            new ExpirationPlugin({ maxEntries: 3000, maxAgeSeconds: 60 * 24 * 60 * 60 }),
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
            new ExpirationPlugin({ maxEntries: 3000, maxAgeSeconds: 60 * 24 * 60 * 60 }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) => /^https:\/\/tile\.thunderforest\.com\//i.test(url.href),
    new CacheFirst({
        cacheName: "tiles-thunderforest",
        plugins: [
            new ExpirationPlugin({ maxEntries: 3000, maxAgeSeconds: 60 * 24 * 60 * 60 }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) => /^https:\/\/photon\.komoot\.io\//i.test(url.href),
    new StaleWhileRevalidate({
        cacheName: "api-geocode",
        plugins: [
            new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 }),
            new CacheableResponsePlugin({ statuses: [0, 200] }),
        ],
    }),
);

registerRoute(
    ({ url }: { url: URL }) => /\/coastline50\.geojson$/i.test(url.href),
    new CacheFirst({
        cacheName: "asset-coastline",
        plugins: [
            new ExpirationPlugin({ maxEntries: 1, maxAgeSeconds: 365 * 24 * 60 * 60 }),
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
