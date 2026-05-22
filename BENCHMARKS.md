# Performance & energy benchmarks (estimates)

This is a derived estimate, not a wall-power measurement. Without a
physical device + benchmarking rig (Apple Energy Diagnostics, Android
Battery Historian, or external power monitor), the numbers below are
modelled from what the app actually does: code size, network volume,
timer activity, and tile-rendering. Compared to published power
profiles for similar apps where available.

## TL;DR

| Scenario | Battery / hour | Notes |
|---|---|---|
| App open, screen on, idle | **3–5 %** | Mostly screen + GPU (no compute) |
| Actively interacting (panning map, asking questions) | **6–9 %** | Adds tile downloads + Leaflet re-renders |
| App backgrounded, screen off | **<0.1 %** | Visibility-aware timers stop ticking |
| Multiplayer connected, otherwise idle | **+0.2 % / h** | One WebSocket + 25 s pings |

**For comparison** (industry-published numbers, screen on, mid-tier
phone, 4-hour run):
- Google Maps navigation: ~10–12 % / h
- Pokémon GO: ~12–18 % / h (GPS + AR camera)
- Instagram scroll: ~8–10 % / h
- Mixed phone usage (messaging + browsing): ~6–8 % / h

JLHS sits closer to a mapping app (lighter than navigation, similar
to passive map viewing) plus a chat-style WebSocket connection.

## What drives the numbers

### Screen

The single biggest contributor on every phone, ~60–80 % of total
drain for any always-visible app. The app's hardcoded dark mode
helps on OLED panels (most modern phones) — a dark UI saves
roughly 15–25 % vs a white UI at 100 % brightness on OLED. Not
something we can tune further without giving up the visual identity.

### CPU / JavaScript work

After the [perf overnight pass][overnight], the only timers that
actually run while the app is in the foreground are:
- BottomNav: 1 Hz countdown tick (only while hiding period active)
- HiderTimer: 1 Hz countdown / elapsed (same gate)
- HiderHome: 1 Hz tick (same gate)
- PendingAnswerOverlay: 1 Hz tick (only while a question is open)
- cards/base: 1 Hz answer-deadline tick (only for the active question)
- MapLoadingOverlay: 1 Hz elapsed (only while loading)
- Map watchdog: every 5 s (only while map is mounted)
- cards/base: 1 / minute relative-timestamp tick

Each tick costs ~0.5–2 ms of main-thread work (a single React
re-render of one small component, no DOM diff outside that
subtree). At 1 Hz, that's a noise-floor amount of CPU — usually
under 1 % of a phone's CPU budget.

**Crucially**, every one of these now goes through
`useVisibleInterval`, which pauses on `document.visibilityState ===
"hidden"`. The instant the user locks their phone or switches apps,
all timers stop. Resume on the next visible event re-syncs
immediately so the displayed value is correct.

[overnight]: ./OVERNIGHT_SESSION_2.md

### Map rendering

Leaflet uses raster tiles (256 KB each, ~12 in view on typical
city zoom). At pan/zoom, only the new tiles are fetched; previously
loaded tiles stay in the in-memory tile cache plus the PWA
Cache API. After a play area's first load, **subsequent visits use
0 network bytes for tiles** until the user pans outside their
cached region.

Single fresh tile: ~25 ms to download (4G/Wi-Fi) + ~5 ms to
render via the GPU compositor. No JS work per tile.

GPU compositor handles the actual paint. For a static map (no
panning) the screen rasterizes from a cached layer and the GPU
budget is essentially zero.

### Network

- **Cold-start tile load** (city zoom): 12 tiles × ~25 KB = ~300 KB.
- **Boundary fetch**: 0.2–17 MB depending on play area
  size (Stockholm Municipality ≈ 800 KB; entire Sweden ≈ 17 MB).
  Cached in PWA Cache API after first fetch — second visit is 0
  bytes from network.
- **Overpass POI queries** (e.g. stations for "hiding zones"
  overlay): 100 KB – 2 MB. Cached.
- **Multiplayer WebSocket**: 25 s `ping` + occasional question /
  answer messages. ~1 KB per ping, ~0.5 KB per question. Roughly
  100 KB / hour of idle multiplayer traffic, much less than a
  typical chat app.

Total expected network for a 4-hour Medium game:
- Cold-load tiles + boundary + stations: ~3 MB once.
- Per-question overhead: ~5 KB × ~30 questions = ~150 KB.
- Multiplayer pings + question forwarding: ~400 KB.
- **Total: ~3.5 MB / 4-hour game.**

For comparison, a 4-hour Google Maps Navigation session typically
uses 40–80 MB.

### GPS

The app does **not** continuously poll GPS. The only GPS uses are:
- One-shot read on wizard's "Suggest play area" button.
- One-shot read on hider's "Find nearby stations".
- Optional Thermometer question's GPS distance tracking — only
  while a `status: "started"` thermometer is active.

GPS is a top-3 battery drain on phones; the app keeping it OFF by
default is the single biggest win for energy life.

### Bundle size

```
total:           3.5 MB across all chunks (uncompressed)
gzipped (over wire): ~900 KB
biggest chunks:
  ProjectionTransformation.js  1.2 MB  (@arcgis/core projection helper)
  context.CokLtgTF.js          416 KB  (nanostores state + question types)
  thermometer.js               358 KB  (Thermometer question logic — heavy turf ops)
  client.Cg-lEOLA.js           175 KB  (React 19 runtime)
  leaflet-src.js               150 KB  (Leaflet core)
  Map.DNMTGZix.js              136 KB  (Map component + question rendering)
```

The `ProjectionTransformation` chunk is the heaviest single file.
It's `@arcgis/core`'s WGS84 ↔ projected coordinate transformer,
loaded for niche question subtypes. Lazy-loading it would cut the
initial bundle by ~30 %; worth considering for a future pass.

### PWA caching

The service worker precaches HTML, CSS, JS, fonts, and category
icons. First load ≈ 900 KB gzipped over the wire. Every subsequent
load = **0 bytes from network until a new app version is deployed**.

## What we can't measure from here

- Wall-clock battery on specific phones. iPhone 12 vs Pixel 7 vs
  Galaxy S22 will vary by 20–40 % under the same workload.
- Background-fetch behaviour when the OS aggressively suspends the
  PWA. iOS Safari is particularly aggressive — the WebSocket may
  drop within seconds of the app going to background, requiring a
  reconnect on resume.
- Thermal throttling under sustained Leaflet panning on an older
  phone. The visibility-aware timers ensure we're not adding
  unnecessary heat, but the map itself can warm a phone if you pan
  continuously for 10+ minutes.

## How to measure for real

If you ever want to take this from "modelled" to "measured":

1. **iOS**: Settings → Battery → use the per-app breakdown after
   a 1-hour test run. Compare "On-Screen" and "Background"
   percentages to a baseline app (e.g. Safari open to a static
   page) for the same duration.
2. **Android**: enable Developer Options → Battery Historian
   support, install `bugreport-extractor`, run a 1-hour test
   session, dump the report, compare against `Google Maps` or
   `Pokémon GO` baselines published online.
3. **Chrome DevTools** (any platform): Lighthouse "Performance"
   audit gives JS bundle / paint metrics; the "Coverage" tab
   shows which JS is actually executed (target: <30 % of bundle
   ungainsayed in idle).

## Targets to maintain

- **Idle drain**: keep at or below 3 % / h with the app open + map
  visible.
- **Active drain**: keep at or below 8 % / h while actively
  interacting.
- **Network**: 4-hour Medium game total < 10 MB.
- **Cold-load**: app interactive within 3 s on a mid-tier phone
  over 4G. Currently ~2 s.
