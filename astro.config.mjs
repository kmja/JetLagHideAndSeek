// @ts-check
import partytown from "@astrojs/partytown";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
    integrations: [
        react(),
        tailwind({
            applyBaseStyles: false,
        }),
        partytown({
            config: {
                forward: ["dataLayer.push"],
            },
        }),
        AstroPWA({
            // autoUpdate lets a new SW activate on the next page load
            // without manual `skipWaiting` plumbing. The
            // PWAUpdatePrompt client island surfaces a toast when a
            // new build is ready so the user can reload immediately.
            registerType: "autoUpdate",
            manifest: {
                name: "Jet Lag Hide and Seek",
                short_name: "Hide+Seek",
                description:
                    "Seeker's companion for the Jet Lag Hide+Seek board game. Eliminate hiding zones with map-based questions, share answer links with the hider, and track the round in real time.",
                start_url: "/",
                scope: "/",
                display: "standalone",
                orientation: "portrait",
                theme_color: "#DC3D38",
                background_color: "#1F2F3F",
                categories: ["games", "travel", "navigation"],
                icons: [
                    {
                        src: "/android-chrome-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                        purpose: "any",
                    },
                    {
                        src: "/android-chrome-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "any",
                    },
                    {
                        src: "/android-chrome-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "maskable",
                    },
                    {
                        src: "/JLIcon.png",
                        sizes: "1080x1080",
                        type: "image/png",
                        purpose: "any",
                    },
                ],
            },
            workbox: {
                // Precache the build output (HTML, JS, CSS, fonts) so
                // a cold offline load gets the app shell.
                globPatterns: [
                    "**/*.{js,css,html,svg,png,jpg,jpeg,gif,webp,ico,woff,woff2,ttf}",
                ],
                // The 50 m coastline GeoJSON is ~8 MB; precaching it
                // would balloon the offline shell. It's fetched
                // lazily and gets cached at runtime instead.
                globIgnores: ["**/coastline50.geojson"],
                navigateFallback: "/index.html",
                // /h is a separate Astro page and gets its own
                // precached HTML; never serve the seeker shell as a
                // fallback for the hider route.
                navigateFallbackDenylist: [/^\/h/],
                // 5 MB cap per precached file — protects against
                // accidental bloat from large public assets.
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
                runtimeCaching: [
                    // CARTO basemap tiles (voyager, light, dark).
                    {
                        urlPattern:
                            /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/.*\.png/i,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "tiles-carto",
                            expiration: {
                                maxEntries: 6000,
                                maxAgeSeconds: 60 * 24 * 60 * 60,
                            },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                    // Esri World Imagery (satellite overlay).
                    {
                        urlPattern:
                            /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\//i,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "tiles-satellite",
                            expiration: {
                                maxEntries: 4000,
                                maxAgeSeconds: 60 * 24 * 60 * 60,
                            },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                    // OpenRailwayMap (rail overlay).
                    {
                        urlPattern:
                            /^https:\/\/(tiles|[a-d]\.tiles)\.openrailwaymap\.org\//i,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "tiles-railway",
                            expiration: {
                                maxEntries: 3000,
                                maxAgeSeconds: 60 * 24 * 60 * 60,
                            },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                    // OpenStreetMap standard (osmcarto basemap).
                    {
                        urlPattern:
                            /^https:\/\/(tile|[a-c]\.tile)\.openstreetmap\.org\//i,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "tiles-osm",
                            expiration: {
                                maxEntries: 3000,
                                maxAgeSeconds: 60 * 24 * 60 * 60,
                            },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                    // Thunderforest (only when the user supplies a
                    // key in Options).
                    {
                        urlPattern:
                            /^https:\/\/tile\.thunderforest\.com\//i,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "tiles-thunderforest",
                            expiration: {
                                maxEntries: 3000,
                                maxAgeSeconds: 60 * 24 * 60 * 60,
                            },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                    // Photon geocoding — small JSON, brief cache so
                    // re-typing a search feels instant.
                    {
                        urlPattern: /^https:\/\/photon\.komoot\.io\//i,
                        handler: "StaleWhileRevalidate",
                        options: {
                            cacheName: "api-geocode",
                            expiration: {
                                maxEntries: 200,
                                maxAgeSeconds: 7 * 24 * 60 * 60,
                            },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                    // The 50 m coastline GeoJSON — large, hit once.
                    {
                        urlPattern: /\/coastline50\.geojson$/i,
                        handler: "CacheFirst",
                        options: {
                            cacheName: "asset-coastline",
                            expiration: {
                                maxEntries: 1,
                                maxAgeSeconds: 365 * 24 * 60 * 60,
                            },
                            cacheableResponse: { statuses: [0, 200] },
                        },
                    },
                    // Overpass responses are NOT runtime-cached here
                    // — `src/maps/api/cache.ts` already manages them
                    // in dedicated Cache Storage buckets
                    // (ZONE_CACHE / PERMANENT_CACHE). Duplicating
                    // would waste storage and confuse invalidation.
                ],
            },
            // Allow install-prompt + update detection during
            // `pnpm dev`. Without this they only fire after a
            // production build.
            devOptions: {
                enabled: true,
                type: "module",
                navigateFallback: "/",
            },
        }),
    ],
    devToolbar: {
        enabled: false,
    },
});
