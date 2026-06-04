import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite config for the JetLag Hide+Seek seeker app.
//
// Migration history: the app was originally Astro + React islands.
// Every interactive piece was annotated `client:only` because the
// app is effectively a SPA — heavy map interaction, multiplayer
// state, no content rendered server-side. Astro's SSR layer was
// pure friction (the leaflet-imports-break-SSR trap, double React
// instances under pnpm, hydration boundary mental tax). Switching
// to a plain Vite SPA dropped all of that without losing anything
// — the PWA, the dist-to-Cloudflare-Pages deploy, and the
// React-dedup hygiene below all carried over with no behaviour
// change.
//
// Production builds emit static HTML+JS+CSS into `dist/`, which
// Cloudflare Pages (configured via `wrangler.jsonc`) serves as
// Worker Static Assets with SPA fallback to `index.html`.
export default defineConfig({
    plugins: [
        react(),
        // PWA — same plugin shape as the Astro version, just the
        // upstream `vite-plugin-pwa` package. Manifest, runtime
        // caching, and devOptions are preserved verbatim from
        // the previous astro.config.mjs.
        VitePWA({
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
                globPatterns: [
                    "**/*.{js,css,html,svg,png,jpg,jpeg,gif,webp,ico,woff,woff2,ttf}",
                ],
                // The 50 m coastline GeoJSON is ~8 MB; precaching
                // would balloon the offline shell. It's fetched
                // lazily and cached at runtime instead.
                globIgnores: ["**/coastline50.geojson"],
                // SPA fallback: an unknown deep link should land on
                // the React Router shell, which routes client-side.
                navigateFallback: "/index.html",
                // /h, /h/, and /h?... all need to land on the SPA
                // shell too — the React Router will pick the hider
                // route. The Astro version had a separate /h.html
                // page; the SPA has a single shell.
                navigateFallbackDenylist: [],
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
                runtimeCaching: [
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
                    // Overpass responses are NOT runtime-cached
                    // here — `src/maps/api/cache.ts` already
                    // manages them in dedicated Cache Storage
                    // buckets. Duplicating would confuse
                    // invalidation.
                ],
            },
            devOptions: {
                enabled: true,
                type: "module",
                navigateFallback: "/",
            },
        }),
    ],
    resolve: {
        // Path alias — mirrors the existing Astro / tsconfig
        // `@/*` → `src/*` so component imports keep working
        // unchanged.
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
        // React-instance hygiene under pnpm — same rationale as
        // before. Forces every `import 'react'` / `import
        // 'react-dom'` to land on a single file so React 19's
        // "more than one copy of React" check stays happy.
        dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
        // Pre-bundle the React-using dependencies so they all
        // come out of `.vite/deps/` with the deduped React
        // already wired in.
        include: [
            "@nanostores/react",
            "@nanostores/persistent",
            "nanostores",
            "@radix-ui/react-alert-dialog",
            "@radix-ui/react-checkbox",
            "@radix-ui/react-dialog",
            "@radix-ui/react-label",
            "@radix-ui/react-popover",
            "@radix-ui/react-select",
            "@radix-ui/react-separator",
            "@radix-ui/react-slot",
            "@radix-ui/react-toggle",
            "@radix-ui/react-toggle-group",
            "@radix-ui/react-tooltip",
            "lucide-react",
            "react-toastify",
            "react-icons",
            "vaul",
            "cmdk",
        ],
    },
    build: {
        // Match the Astro output dir Cloudflare's
        // wrangler.jsonc already points at.
        outDir: "dist",
        sourcemap: false,
        // SPA — a single entry HTML.
        rollupOptions: {
            input: path.resolve(__dirname, "index.html"),
        },
    },
});
