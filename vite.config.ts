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
// Production builds emit static HTML+JS+CSS into `dist/`, which a
// Cloudflare Worker (configured via `wrangler.jsonc`, deployed by
// Workers Builds) serves as Worker Static Assets with SPA fallback
// to `index.html`.
export default defineConfig({
    plugins: [
        react(),
        // PWA — same plugin shape as the Astro version, just the
        // upstream `vite-plugin-pwa` package. Manifest, runtime
        // caching, and devOptions are preserved verbatim from
        // the previous astro.config.mjs.
        VitePWA({
            // v930: "prompt" (was "autoUpdate"). autoUpdate wires a
            // generated `activated → window.location.reload()` listener
            // that fired the instant a new deploy's SW was detected (the
            // 60 s poll / on-focus check in PWAUpdatePrompt) with NO
            // state check — during the 2–3 min deploy cadence it hard-
            // reloaded players "out of nowhere", ejecting them from the
            // lobby/game. In "prompt" mode WE control the swap:
            // `PWAUpdatePrompt` auto-applies an update only when the user
            // is IDLE (not in a room / no active game) — preserving the
            // v777 auto-update-on-deploy intent — and otherwise surfaces
            // a "Reload to update" prompt instead of reloading live.
            registerType: "prompt",
            // injectManifest lets us write our own SW (src/sw.ts) with
            // a `push` handler for Web Push notifications. The Workbox
            // precache manifest is injected at build time.
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.ts",
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
            devOptions: {
                enabled: true,
                type: "module",
                navigateFallback: "/",
            },
        }),
    ],
    resolve: {
        // Path aliases — mirror tsconfig so component imports
        // keep working unchanged:
        //   "@/*"         → src/*
        //   "@protocol/*" → protocol/* (shared with worker/)
        alias: {
            "@": path.resolve(__dirname, "src"),
            "@protocol": path.resolve(__dirname, "protocol"),
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
            output: {
                // Vendor splitting so the initial page-load JS
                // payload stays small. Anything that's only used by
                // the map runtime (maplibre, leaflet, turf, d3) is
                // already lazy-loaded via React.lazy in MapSwitcher,
                // so isolating those vendors lets the loader skip
                // them when the user's flag points the other way.
                // Other splits (react, ui, arcgis, utils) are about
                // letting the browser cache the heavy stable vendor
                // chunks across deploys — app code churns daily, the
                // vendor blobs don't.
                // IMPORTANT: only name-chunk EAGER vendors here.
                //
                // Vite's __vitePreload helper (used by every dynamic
                // import in the app) gets hoisted by Rollup into
                // whichever chunk most-often references it. If we
                // explicitly name a LAZY vendor chunk (maplibre,
                // leaflet, arcgis) it becomes the most-frequent
                // dynamic-import target, the helper lands inside
                // it, and main.js's static 'import { __vitePreload }
                // from "./vendor-XXX.js"' drags the entire lazy
                // bundle into the initial page load — the exact
                // opposite of the intended lazy behaviour.
                //
                // For lazy deps (maplibre, leaflet, arcgis,
                // @terraformer) we return undefined so Rollup
                // chunks them naturally alongside their importing
                // chunk (Map.tsx / MapV2.tsx / arcgisOperators.ts),
                // and the __vitePreload helper stays in one of the
                // already-eager vendor chunks where it belongs.
                manualChunks(id) {
                    if (!id.includes("node_modules")) return undefined;
                    if (id.includes("/@turf/")) return "vendor-turf";
                    if (id.includes("/d3-")) return "vendor-d3";
                    if (
                        id.includes("/@radix-ui/") ||
                        id.includes("/lucide-react/") ||
                        id.includes("/react-icons/") ||
                        id.includes("/cmdk/") ||
                        id.includes("/vaul/")
                    )
                        return "vendor-ui";
                    if (
                        id.includes("/nanostores/") ||
                        id.includes("/@nanostores/")
                    )
                        return "vendor-nanostores";
                    if (
                        id.includes("/react/") ||
                        id.includes("/react-dom/") ||
                        id.includes("/react-router") ||
                        id.includes("/scheduler/")
                    )
                        return "vendor-react";
                    if (
                        id.includes("/lodash/") ||
                        id.includes("/papaparse/") ||
                        id.includes("/osmtogeojson/") ||
                        id.includes("/open-location-code/") ||
                        id.includes("/zod/") ||
                        id.includes("/qrcode.react/")
                    )
                        return "vendor-utils";
                    return undefined;
                },
            },
        },
        // Lifted from the default 500 KB so the maplibre chunk
        // (~800 KB even after splitting) stops printing a warning
        // on every build. The chunks ARE intentionally large; the
        // wins come from cacheability + lazy-loading, not from
        // shrinking them further.
        chunkSizeWarningLimit: 1024,
    },
});
