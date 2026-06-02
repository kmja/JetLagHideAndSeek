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

# 4. First deploy
pnpm run deploy

# 5. Verify
curl https://jlhs-overpass-cache.<your-subdomain>.workers.dev/health
```

For ongoing deploys: the Cloudflare Workers Builds project
rooted at `overpass-cache/` auto-deploys on every push to
master, same pattern as the multiplayer worker.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /api/interpreter?data=…` | none | Cached Overpass query. Used by the seeker app. |
| `POST /admin/prewarm` | Bearer | Bulk-fetch by relation id. Used by the bulk script. |
| `GET /admin/status` | Bearer | Cache size + count. |
| `GET /health` | none | Liveness probe. |

`X-Cache` response header reports `EDGE_HIT` / `R2_HIT` /
`MISS` / `MISS_REFRESH` / `R2_STALE_FALLBACK` so you can see
which layer served any given request.

## Overnight bulk prewarm

A scheduled cron already keeps the curated list in
`src/cities.ts` warm at ~5 cities/week. For larger pre-fills
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

`bulk-cities.json` ships with ~160 well-known cities. To add
more without hand-looking-up every OSM relation id, use the
discovery script:

```bash
# 1. Write a JSON array of "City, Country" strings
echo '["Tampere, Finland", "Aarhus, Denmark", "Tartu, Estonia"]' > /tmp/names.json

# 2. Resolve via Photon and append to bulk-cities.json
node scripts/discover-osm-ids.mjs \
    --input /tmp/names.json \
    --output ./bulk-cities.json \
    --append
```

Photon's free tier handles this fine at the default 1 req/s
pacing. The script checkpoints every 25 resolves, so a crash
mid-run doesn't lose work. Verify the resulting JSON before
running `bulk-prewarm.mjs` — Photon occasionally returns a
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
