# Question data paths & prewarm status

This document is the authoritative map of **where each question type gets
its data** and **how that data is preloaded**, per the project principle
that everything should be as preloaded and stable as possible, and that
self-hosted-from-R2 is always preferred over a live external call.

## Tiers

- **Tier 0 — bundled**: data ships in the app build (`public/*.geojson`),
  loaded once into `PERMANENT_CACHE`, then served from disk forever. Zero
  external dependency at game time.
- **Tier 1 — self-hosted + prewarmed**: data is fetched through our
  Cloudflare worker (R2-cached), and the laptop prewarmer / cron warms it
  per curated city so the first seeker is instant.
- **Tier 2 — self-hosted, cached-on-demand**: goes through our worker
  (so the 2nd seeker anywhere is instant), but the FIRST seeker in an
  uncovered area pays a cold upstream fetch. Not prewarmable because the
  query is per-seeker dynamic (anchored on exact GPS).
- **Tier 3 — pure client**: no data fetch at all.

## Matching — "Is your nearest ___ the same as mine?"

| Subtype | Data path | Tier | Prewarm |
|---|---|---|---|
| Airport | `findPlacesInZone(aeroway=aerodrome+iata)` → v331 references fast-path (family `airport`) | 1 | Refs (laptop + cron Phase 4/5) |
| Transit line | rail-station references family + `trainLineNodeFinder` (live for the line walk) | 1 / 2 | Refs cache; line walk cold |
| Station name length | rail-station references family | 1 | Refs |
| Street or path | `way[highway][name](around)` + `way[highway][name=X]` — worker-cached | 2 | none (per-seeker dynamic) |
| 1st–4th admin division | `findAdminBoundary` (`is_in` + `rel(pivot)[admin_level]`) — worker-cached | 2 | none (per-point `is_in`) |
| Mountain / Park / POI / utilities (`-full`) | references families (`api:peak`, `api:park`, …) | 1 | Refs |
| Landmass | bundled `coastline50.geojson` | 0 | n/a — in build |

## Measuring — "Closer to or further from ___?"

| Subtype | Data path | Tier | Prewarm |
|---|---|---|---|
| Airport | references family `airport` | 1 | Refs |
| High-speed train line | per-country HSR query | 1 | HSR (Phase 3, laptop + cron) |
| Rail station | references family `rail-station` | 1 | Refs |
| International border | bundled `borders0_50m.geojson` | 0 | n/a — in build |
| 1st admin division border | bundled `borders1_50m.geojson` | 0 | n/a — in build |
| 2nd admin division border | `way[admin_level=6][boundary]` — worker-cached | 2 | none (no global dataset) |
| Sea level (altitude) | self-hosted Terrarium elevation tiles (`/api/elevation`) → contour | 1 | Elevation tiles (laptop, v342) |
| Body of water | bundled `lakes50.geojson` | 0 | n/a — in build |
| Coastline | bundled `coastline50.geojson` | 0 | n/a — in build |
| Mountain / Park / POI / utilities (`-full`) | references families | 1 | Refs |

## Tentacles — "Within ___ km, which ___ are you nearest to?"

| Subtype | Data path | Tier | Prewarm |
|---|---|---|---|
| Museum / Library / Movie theater / Hospital (2 km) | references families (`api:*`) | 1 | Refs |
| Zoo / Aquarium / Amusement park (25 km) | references families | 1 | Refs |
| Metro line (25 km) | bbox `relation[route=subway][name]` — worker-cached | 1 | `metro-routes` (laptop, v343) |

## Radar / Thermometer / Photo

| Category | Data path | Tier |
|---|---|---|
| Radar | circle around seeker GPS — pure client | 3 |
| Thermometer | GPS distance start→now — pure client | 3 |
| Photo | the photo IS the answer — no map data | 3 |

## Bundled assets (Tier 0)

| File | Size (raw) | Source | Used by |
|---|---|---|---|
| `coastline50.geojson` | 3.9 MB | Natural Earth 1:50m | Coastline (measuring), Landmass (matching) |
| `lakes50.geojson` | 433 KB | Natural Earth 1:50m | Body of water (measuring) |
| `borders0_50m.geojson` | 760 KB | Natural Earth 1:50m | International border (measuring) |
| `borders1_50m.geojson` | 882 KB | Natural Earth 1:50m | 1st admin div border (measuring) |

## Remaining Tier-2 (cold-on-first-ask) paths

These three are the only questions that can pay a cold upstream fetch,
and each has a documented reason it isn't Tier 0/1:

1. **2nd admin division border** — Natural Earth has no global
   county-level dataset at any resolution; bundling would require
   hosting OSM-derived data ourselves. A per-shard prewarm (mirroring
   the v329 transit shards) would close it.
2. **Street or path** — the nearest-street query is anchored on the
   seeker's exact GPS, so it can't be prewarmed without fetching every
   named highway in the country.
3. **Transit line** (the line-walk half) — `trainLineNodeFinder` walks
   from the seeker's specific station.

All three still route through our worker, so only the very first seeker
in an uncovered area is slow; everyone after hits R2.
