# jlhs-overpass-cache

R2-backed cache in front of public Overpass mirrors for the
JetLag Hide and Seek seeker app. See `src/index.ts` header for
the full design; this README covers the operator workflow.

## One-time setup

```bash
# 1. Install deps
cd overpass-cache
pnpm install

# 2. Create the R2 bucket
wrangler r2 bucket create jlhs-overpass-cache

# 3. Set the admin secret (used by /admin/* endpoints)
wrangler secret put ADMIN_SECRET --config wrangler.toml
# (paste a long random string)

# 3b. (optional) Transit journey/plan secrets — see envTypes.ts.
#     All optional; without them the affected regions fall back to
#     a walking estimate rather than a live schedule.
wrangler secret put TRAFIKLAB_API_KEY  --config wrangler.toml  # SE — ResRobot (journey arrivals + plan)
wrangler secret put DIGITRANSIT_API_KEY --config wrangler.toml # FI — Digitransit plan
wrangler secret put TFL_API_KEY         --config wrangler.toml # London — higher rate limit (works keyless too)
wrangler secret put NAVITIA_API_KEY     --config wrangler.toml # navitia.io — France/Paris + broad-Europe fallback
wrangler secret put TFNSW_API_KEY        --config wrangler.toml # Transport for NSW — Sydney/NSW (Australia)
wrangler secret put HERE_API_KEY         --config wrangler.toml # HERE Transit — near-universal fallback
wrangler secret put GOOGLE_MAPS_API_KEY  --config wrangler.toml # Google Directions transit — broadest universal fallback
# (Denmark/Norway/Switzerland/Germany adapters are keyless — no secret needed.)
# HERE + Google are universal: with either key set, cities lacking a free
# regional adapter (Tokyo, NYC, Calgary, Singapore, …) get real journeys.

# 4. First deploy
pnpm run deploy

# 5. Verify
curl https://jlhs-overpass-cache.<your-subdomain>.workers.dev/health
```

For ongoing deploys: the Cloudflare Workers Builds project
rooted at `overpass-cache/` auto-deploys on every push to
master, same pattern as the multiplayer worker. Its configured
Workers Builds deploy command is `node scripts/deploy.mjs` (a
thin shim that no-ops on non-master branches so preview pushes
stay green) — NOT `pnpm run deploy`, which is the manual
`wrangler deploy` path above.

## Endpoints

Non-exhaustive — the worker also proxies references (`/api/refs/*`),
transit overlays (`/api/transit/*`), elevation (`/api/elevation/*`),
map assets (`/api/mapasset/*`), rail tiles (`/api/railtile/*`),
Photon geocoding (`/api/photon/{forward,reverse}`), and PMTiles
(`/tiles/*`); see the `url.pathname` dispatch in `src/index.ts` for
the full list. The commonly-touched ones:

| Path | Auth | Purpose |
|---|---|---|
| `GET /api/interpreter?data=…` | none | Cached Overpass query. Used by the seeker app. |
| `POST /api/journey/arrivals` | none | Reach: anchor + many stops → earliest arrival at each (ResRobot). Needs `TRAFIKLAB_API_KEY`; without it returns the empty-results shape so the client degrades gracefully. (`src/journey.ts`) |
| `POST /api/travel/plan` | none | Plan: single origin→destination journey **with legs** via the regional adapter dispatcher (Trafiklab/Entur/Digitransit/TfL/Swiss + walking backstop). Always returns a journey. (`src/travel/`) |
| `POST /admin/prewarm` | Bearer | Bulk-fetch by explicit relation id list (caller supplies the ids). |
| `POST /admin/trigger-prewarm` | Bearer | Manually run the cron's next batch right now (picks from `POPULAR_CITIES`). Optional body `{ "batch": 20, "delayBetweenMs": 1000 }`. |
| `POST /admin/discover` | Bearer | Resolve unresolved candidate city names via Photon and append the new relation IDs to the R2-stored list. Optional body `{ "batch": 20 }` or `{ "names": ["Halifax, Canada", ...] }`. |
| `GET /admin/status` | Bearer | Cache size + count. |
| `GET /health` | none | Liveness probe. |

### Discovery + prewarm pipeline

There are two backlogs:

1. **Unresolved names** — `bulk-city-names.json` ships ~600 candidate
   strings; about 170 already have resolved IDs in `bulk-cities.json`.
   The rest need a Photon search to turn "Halifax, Canada" into
   relation `12345`. This is what `/admin/discover` does.
2. **Unwarmed relations** — once an ID is known, the boundary query
   has to actually run so the result lands in R2. This is what
   `/admin/trigger-prewarm` and the daily cron do.

An **hourly** cron (`crons = ["0 * * * *"]`) drains both backlogs each
tick — discovery (Photon name → relation id) plus prewarm (~25 cities
via `PREWARM_BATCH_SIZE`), alongside HSR-country and global
country-shard reference passes. A fresh bucket fills out in roughly a
day of wall-clock; the curated ~170-city list warms much faster. Speed
it up further by hitting the endpoints below.

### Fast-fill without your laptop

```bash
# One batch (default 20 cities, ~25 s).
curl -X POST \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d '{}' \
    https://jlhs-overpass-cache.<sub>.workers.dev/admin/trigger-prewarm

# Bigger batch (caps at 100 per call to stay under the worker time
# budget).
curl -X POST \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -d '{"batch": 50}' \
    https://jlhs-overpass-cache.<sub>.workers.dev/admin/trigger-prewarm
```

Fire it from anywhere that can POST — Cloudflare dashboard's
"Quick edit" → "Test", Postman, the browser DevTools fetch console,
etc. Each call returns the per-city result list so you can pipe it
to a log.

To drain the discovery backlog (turn the ~430 remaining candidate
names into relation IDs) faster than the cron's 5/day pace:

```bash
# Default batch of 20, ~20 s wall clock.
curl -X POST \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -d '{}' \
    https://jlhs-overpass-cache.<sub>.workers.dev/admin/discover

# Or resolve specific names:
curl -X POST \
    -H "Authorization: Bearer $ADMIN_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"names": ["Halifax, Canada", "Lyon, France"]}' \
    https://jlhs-overpass-cache.<sub>.workers.dev/admin/discover
```

Response shape:
```json
{
  "attempted": 20,
  "resolved": [{ "name": "...", "relationId": 12345 }, ...],
  "skipped": ["..."],
  "stillUnresolved": 410
}
```

Repeat the discover call until `stillUnresolved` hits 0 (~22 calls
for the full backlog), then trigger-prewarm picks up the newly
resolved relations next time it runs.

`X-Cache` response header reports `EDGE_HIT` / `R2_HIT` /
`SLICED` / `MISS` / `MISS_REFRESH` / `R2_STALE_FALLBACK` so you can
see which layer served any given request. `SLICED` means the
response was derived by bbox-filtering a prewarmed country shard
(see `scripts/global-prewarm.md`); it carries an `X-Cache-Shard`
header naming the source shard.

## Overnight bulk prewarm

The hourly cron already keeps the curated list in
`src/cities.ts` warm (~25 cities/run). For larger pre-fills
(e.g. "load 1000 major cities tonight"), use the bulk script:

```bash
cd overpass-cache
ADMIN_SECRET=… node scripts/bulk-prewarm.mjs \
    --worker https://jlhs-overpass-cache.<sub>.workers.dev \
    --input ./bulk-cities.json \
    --batch 10 \
    --delay-between-relations 1500 \
    --delay-between-batches 2000
```

At the defaults (~2 s per relation, plus per-batch slack) a
1000-city list runs in about 35 minutes. The script prints
per-relation status (`stored` / `skipped-fresh` / `failed`)
and tail-friendly progress counters, so you can leave it
piped to a log file and check on it in the morning.

Resumable: kill the script and rerun later. Anything already
fresh in R2 is skipped server-side, so re-running on the
same list is cheap.

## Growing the list

`bulk-cities.json` ships with ~170 well-known cities. A
larger candidate set lives in `bulk-city-names.json` —
~600 cities organized by region, ready to feed to the
discovery script:

```bash
node scripts/discover-osm-ids.mjs \
    --input ./bulk-city-names.json \
    --output ./bulk-cities.json \
    --append
```

At Photon's default 1 req/s pacing this takes ~10 min and
appends every new resolution into `bulk-cities.json` (which
the bulk-prewarm step then warms into R2). The script
checkpoints every 25 resolves, so a crash mid-run doesn't
lose work.

For a one-shot fully-cold prefill, the `prewarm:overnight`
npm script wires both stages together:

```bash
ADMIN_SECRET=… WORKER_URL=https://jlhs-overpass-cache.<sub>.workers.dev \
    pnpm run prewarm:overnight
```

That runs discovery against `bulk-city-names.json`, then
bulk-prewarm against the resulting `bulk-cities.json`, with
sensible defaults. Total wall-clock for a fresh 600-city
prefill is about an hour.

To add cities not already in `bulk-city-names.json`, edit it
directly — entries are plain `"City, Country"` strings, no
relation IDs to look up by hand. Verify the resulting JSON
before running prewarm — Photon occasionally returns a
ward or sub-district instead of the city proper.

## Status check

```bash
curl -H "Authorization: Bearer $ADMIN_SECRET" \
    https://jlhs-overpass-cache.<sub>.workers.dev/admin/status
```

Returns:
```json
{
  "cachedEntries": 247,
  "totalBytes": 412_088_320,
  "prewarmedEntries": 168,
  "tooManyToCountExactly": false
}
```

## Costs

R2 free tier covers our scale comfortably:
- Storage: 10 GB free, then $0.015/GB-month.
- Class A operations (writes): 1M free/month. Bulk-warming
  1000 cities is 1000 ops — well under.
- Class B operations (reads): 10M free/month. Each game
  load is ~14 reads (one per piece); 100k game starts = 1.4M
  reads — well under.
- Egress: free (R2 distinguishing feature).

Cron + scheduled worker invocations: free below 100k/day.
