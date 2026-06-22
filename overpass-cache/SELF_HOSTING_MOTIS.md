# Self-hosting MOTIS (license-clean global/regional transit routing)

This is the recipe for running your **own** MOTIS routing server so the
trip planner stops depending on the public `api.transitous.org` instance
(which is free + keyless but flagged **non-commercial**). Self-hosting
removes that restriction and gives you full control over coverage.

> **The app side is already done.** `overpass-cache/src/travel/adapters/motisSelfHosted.ts`
> speaks the exact MOTIS plan API and is wired into the dispatcher *ahead*
> of public Transitous. It activates the moment you set one secret
> (`MOTIS_SELF_HOSTED_URL`). Everything below is ops, not code.

## Why / when

- **License**: MOTIS is MIT-licensed (FOSS). The "not for commercial use"
  string belongs to *transitous.org's hosted API*, not to MOTIS and not
  to the underlying GTFS feeds. A box you run yourself has no such
  restriction — you only honor each GTFS feed's own license + OSM's ODbL
  attribution.
- **Coverage**: a self-hosted MOTIS covers exactly the GTFS feeds you load
  it with. Load one country → that country. Load the whole Transitous
  catalog (1800+ feeds / 55+ countries) → effectively global.
- **Cost reality** (Hetzner, mid-2026):
  | Scope | Box | RAM | ~Cost |
  |---|---|---|---|
  | One small country (e.g. CH) | Hetzner Cloud CX32 | 8 GB | €6.80/mo |
  | One large country (e.g. DE) | Hetzner Cloud CX42 | 16 GB | €16.40/mo |
  | Planet / global | Hetzner dedicated AX42 | 64 GB + NVMe | ~€46–49/mo |

  MOTIS 2 memory-maps the big geometry files, so **RAM does not need to
  match dataset size** — fast NVMe matters more than huge RAM. (A planet
  OSM street-graph import needs ≤ ~10 GB RAM per MOTIS's `osr` README;
  the scary "fails with 100 GB" quotes are MOTIS **1** / OSRM-era and no
  longer apply.)

## Two ways to build the dataset

### Path A — bare MOTIS with hand-picked feeds (simplest for a few regions)

You give MOTIS a `config.yml` listing your GTFS `.zip`(s) + one OSM
`.osm.pbf` extract, and it builds + serves.

1. **Get the data**
   - GTFS: download the feeds you want. Find them via the
     **Mobility Database** (https://mobilitydatabase.org — free API/CSV
     catalog, 6000+ feeds) or Transitous's `feeds/` directory
     (https://github.com/public-transport/transitous/tree/main/feeds —
     each region's JSON lists direct GTFS URLs).
   - OSM: grab the matching extract from **Geofabrik**
     (https://download.geofabrik.de — e.g. `switzerland-latest.osm.pbf`
     ~400 MB, `germany-latest.osm.pbf` ~4.5 GB, or `planet-latest.osm.pbf`
     ~87 GB for global).

2. **Generate `config.yml` — let MOTIS write it for you.** MOTIS ships a
   `config` subcommand that emits a minimal config from your OSM + GTFS
   files, so you don't hand-write it:

   ```bash
   ./motis config switzerland-latest.osm.pbf switzerland-gtfs.zip
   ```

   That produces a `config.yml` whose real top-level keys are:

   ```yaml
   server:
     port: 8080
     # web_folder: ui     # bundled web UI; omit for an API-only box
   osm: switzerland-latest.osm.pbf
   timetable:
     datasets:
       ch:                       # arbitrary dataset id
         path: switzerland-gtfs.zip
       # add more feeds as extra datasets:
       # de:
       #   path: germany-gtfs.zip
   ```

   `timetable.datasets.<id>.path` takes a GTFS **.zip** directly (no
   unzip needed). **Cost tip:** you do NOT need MOTIS's `tiles:` or
   `geocoding:` blocks — the app already uses Protomaps for basemap
   tiles and Photon for geocoding. Leaving them out makes the box an
   API-only router with a much smaller memory/disk footprint. (Full key
   list — `server`, `osm`, `timetable`, `gbfs`, `tiles`,
   `street_routing`, `geocoding`, `limits`, … — is in
   https://github.com/motis-project/motis/blob/master/docs/setup.md.)

3. **Import + serve with Docker** (two phases: import builds a
   persistent `/data` dataset once; server reuses it). Pin `:master` —
   MOTIS publishes no stable semver tag, only rolling `master`/`edge`:

   ```yaml
   # docker-compose.yml
   services:
     motis-import:
       image: ghcr.io/motis-project/motis:master
       volumes:
         - ./switzerland-gtfs.zip:/input/switzerland-gtfs.zip
         - ./switzerland-latest.osm.pbf:/input/switzerland-latest.osm.pbf
         - ./config.yml:/config.yml
         - motis-data:/data:rw
       command: /bin/sh -c "./motis import"
     motis-server:
       image: ghcr.io/motis-project/motis:master
       depends_on:
         motis-import: { condition: service_completed_successfully }
       volumes: [ motis-data:/data:rw ]
       ports: [ "8080:8080" ]
       command: /bin/sh -c "./motis server"
   volumes:
     motis-data:
   ```

   ```bash
   docker compose run --rm motis-import   # once (or after a feed refresh)
   docker compose up -d motis-server      # serves on :8080
   ```

   > The OSM street-graph build dominates import time (minutes for a
   > country, a few hours for planet; RAM/SSD-bound). The dataset is
   > built once and reused on restart.

### Path B — run the whole Transitous stack (for global coverage)

Transitous (https://github.com/public-transport/transitous) is itself the
**feed catalog + config generator** that produces a MOTIS dataset from its
curated 150+ region list. To self-host the same coverage transitous.org
has:

```bash
git clone https://github.com/public-transport/transitous
cd transitous
python3 src/fetch.py                              # download all feeds
python3 src/generate-motis-config.py --skip-missing-files  # emit config.yml
# → feeds + config.yml land in the output dir; point MOTIS at that config.yml
```

Then import/serve that generated `config.yml` with the same Docker
commands as Path A. This is the planet-scale option (budget the AX42-class
box above).

## Wiring it into the app

The plan endpoint is **`GET /api/{version}/plan`** — and the version
segment is **instance-dependent**: current MOTIS `master` serves
`/api/v6/plan`, while today's Transitous serves `/api/v1/plan`. So:

1. Find your instance's version — open `https://YOUR_HOST/openapi.yaml`
   (or the Swagger UI) and read the single `paths:` version segment, or
   just try `/api/v1/plan` and `/api/v6/plan`.

2. Set the secret to the **full** plan-endpoint URL:

   ```bash
   cd overpass-cache
   npx wrangler secret put MOTIS_SELF_HOSTED_URL
   # paste e.g.  https://motis.yourdomain.com/api/v1/plan
   ```

That's it — `motisSelfHosted.ts` is ordered ahead of public Transitous,
so once the secret is set your box wins and the public instance becomes a
mere backstop. The request our adapter sends
(`fromPlace=lat,lon&toPlace=lat,lon&time=ISO&arriveBy=false`) and the
`{ itineraries: [{ legs: [...] }] }` response it parses are stable across
MOTIS versions; only the path's `vN` differs.

## Verify it's live

Use the worker's diagnostic (added during the adapter audit):

```bash
curl -s -X POST "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/api/travel/plan?debug=1" \
  -H "Content-Type: application/json" \
  -d '{"origin":{"lat":47.5476,"lng":7.5895},"destination":{"lat":47.5673,"lng":7.6079,"name":"Test"}}'
```

In the response, the `motis-self-hosted` adapter row should flip from
`key: "missing"` / `result: "null"` to `key: "present"` / `result:
"journey"`. (Also probe your box directly first — a fresh `:master`
build serves `v6`:
`curl 'https://YOUR_HOST/api/v6/plan?fromPlace=47.5476,7.5895&toPlace=47.5673,7.6079'`.)

## License / attribution checklist (self-hosting)

- **MOTIS**: MIT — no restriction.
- **OSM data**: ODbL — display OSM attribution.
- **Each GTFS feed**: its own license (mostly open/attribution). Transitous
  emits a `license.json` during import; honor those per-feed terms +
  attribution.
- You are NOT bound by transitous.org's non-commercial policy once you're
  off their hosted API.

## Sources / further reading

- MOTIS engine + setup: https://github.com/motis-project/motis (MIT LICENSE),
  `docs/setup.md`, and the `osr` street-router README
  https://github.com/motis-project/osr
- MOTIS API (OpenAPI): https://github.com/motis-project/motis/blob/master/openapi.yaml
  (browse a live one at https://europe.motis-project.de/openapi/)
- Transitous stack + feed catalog: https://github.com/public-transport/transitous
  (and the MOTIS-Notes wiki)
- Mobility Database: https://mobilitydatabase.org
- OSM extracts: https://download.geofabrik.de , https://planet.openstreetmap.org

> Anything marked "ILLUSTRATIVE" / "⚠️ verify" above is because MOTIS's
> config + CLI format drifts between versions and the docs are the source
> of truth — the *app-side contract* (request/response shape, the
> `MOTIS_SELF_HOSTED_URL` wiring) is stable and confirmed.
</content>
</invoke>
