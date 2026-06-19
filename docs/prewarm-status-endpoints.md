# Prewarm status endpoints

All endpoints below live on the cache worker —
`https://jlhs-overpass-cache.karl-mj-andersson.workers.dev` (or
whatever you have `WORKER` set to). They report what's currently in
R2 vs. what's still cold.

The auth model is consistent across endpoints:
- **Authless** = open, no header needed (one endpoint).
- **Auth required** = `Authorization: Bearer $ADMIN_SECRET` OR
  `?secret=$ADMIN_SECRET` in the query string.

The `ADMIN_SECRET` is the same one the laptop prewarmer uses
(`--secret` arg) and is stored as a Cloudflare Worker secret.

---

## Overall health

### `GET /health`
**Authless.** Returns plain text `ok` (HTTP 200) if the worker is up.
Use as a liveness check; doesn't say anything about prewarm state.

```bash
curl -fsS https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/health
```

---

## Aggregate cache state

### `GET /admin/status`
**Auth required.** Lists up to 10 000 entries under the `overpass/`
prefix in R2 and aggregates. Returns:

```json
{
  "cachedEntries": 4271,
  "totalBytes": 583291842,
  "prewarmedEntries": 4198,
  "tooManyToCountExactly": false
}
```

- `cachedEntries` — total Overpass-query cache hits in R2.
- `prewarmedEntries` — how many were written by the laptop / cron
  (i.e. have `prewarmed: "true"` in custom metadata) vs. fetched live.
- `tooManyToCountExactly: true` means there are more than 10 000 — the
  count stopped early.

This is the headline number — if `prewarmedEntries` is growing roughly
in line with the number of curated cities × the per-city query count,
the laptop loop is working.

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_SECRET" \
  https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/admin/status
```

---

## Country-shard prewarm progress

### `GET /admin/country-refs-status`
**Authless** (read-only summary, doesn't reveal any cached query
bodies). Walks every shard in `COUNTRY_SHARDS` (~214 entries) and
issues an R2 HEAD per shard. Returns:

```json
{
  "enabled": true,
  "ttlDays": 30,
  "freshTtlDays": 60,
  "totals": { "shards": 214, "warmed": 187, "stale": 4, "missing": 23, "bytes": 412379211 },
  "shards": [
    { "iso": "SE",    "label": "Sweden",          "status": "fresh",   "sizeBytes": 4831200, "ageHours": 12 },
    { "iso": "US-east","label": "United States — east","status": "stale", "sizeBytes": 12082311, "ageHours": 1456, "parent": "US" },
    { "iso": "XK",    "label": "Kosovo",          "status": "missing" },
    ...
  ]
}
```

- `enabled` mirrors `env.COUNTRY_REFS_PREWARM_ENABLED`. If false, the
  cron isn't writing shards at all.
- `totals.warmed` is the headline — how many of the ~214 shards have a
  fresh references entry.
- Each shard's `status` is `fresh` / `stale` / `missing`. `stale` =
  written but past `freshTtlDays`; `missing` = never written.
- `sizeBytes` per shard lets you spot the heavy hitters.

```bash
curl -fsS https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/admin/country-refs-status \
  | jq '.totals'
# {"shards":214,"warmed":187,"stale":4,"missing":23,"bytes":412379211}
```

To see only what's still cold:

```bash
curl -fsS …/admin/country-refs-status \
  | jq '.shards[] | select(.status != "fresh") | {iso, label, status}'
```

---

## Is THIS specific query cached?

### `POST /admin/check-fresh`
**Auth required.** The byte-for-byte cache probe — sends the worker
an Overpass QL string and asks whether the SHA-256-keyed R2 entry
exists and is still inside TTL. Used by the laptop loop to skip
queries that are already warm.

Request body:
```json
{ "query": "[out:json][timeout:120][bbox:55.520,12.323,55.778,12.864];..." }
```

Response when warm:
```json
{ "fresh": true, "exists": true, "ageMs": 1278342, "ttlMs": 2592000000, "cacheKey": "1f4a…" }
```

Response when missing:
```json
{ "fresh": false, "exists": false, "ttlMs": 2592000000, "cacheKey": "1f4a…" }
```

This is the only way to confirm a specific query (e.g. "Stockholm bus
overlay" or "Trondheim references") is actually in the cache, because
the answer depends on byte-identical query strings.

```bash
curl -fsS -X POST -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"query":"\n[out:json][timeout:180][bbox:55.520,12.323,55.778,12.864];\nrelation[\"route\"=\"subway\"];\nout skel geom;\n"}' \
  https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/admin/check-fresh
```

---

## Curated city list (what the laptop loops over)

### `GET /admin/list-cities`
**Auth required.** Returns the merged curated + bulk + discovered
city list — the same one the laptop pulls and iterates. Tells you
which cities are in the prewarm rotation:

```json
{
  "count": 1283,
  "cities": [
    { "name": "Stockholm", "relationId": 398021, "extent": [59.46, 17.76, 59.20, 18.36] },
    { "name": "Trondheim", "relationId": 406560, "extent": [63.60, 10.20, 63.30, 10.70] },
    ...
  ],
  "queryBuilders": {
    "boundary": "[out:json][timeout:120];relation(${relationId});out geom;",
    "referencePad": 50,
    "hsrPad": 100,
    "referenceFamilies": [ … the REFERENCE_FAMILY_FILTERS list … ]
  }
}
```

`queryBuilders` is included so an external runner (laptop, CI, ad-hoc
script) can construct byte-identical queries without keeping its own
copy of the constants in sync.

---

## Upstream debugging (when prewarm is FAILING)

### `GET /admin/diagnose?id=<relationId>`
**Auth required.** When a batch of prewarm attempts is failing, this
probes each upstream individually and reports exactly what they
returned — HTTP status, response time, response headers, body
preview. Built after a run came back with 97/100 silent `upstream-
failed` errors with suspiciously identical durations.

Probes for one OSM relation id:
- `polygons.openstreetmap.fr/get_geojson.py?id=…`
- `overpass-api.de/api/interpreter`
- `overpass.private.coffee/api/interpreter`
- `overpass.kumi.systems/api/interpreter`

Defaults to relation 175905 (NYC) if no `id` is given.

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_SECRET" \
  "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/admin/diagnose?id=398021" \
  | jq
```

Output (truncated):
```json
[
  { "label": "polygons.osm.fr",  "status": 200, "elapsedMs": 412,  "headers": {...}, "bodyPreview": "{\"type\":\"Polygon\",..." },
  { "label": "overpass-api.de",  "status": 429, "elapsedMs": 31,   "headers": { "retry-after": "...", ... }, "bodyPreview": "" },
  ...
]
```

The `headers` include rate-limit info from the public mirrors when
they're throttling — that's what surfaces "are we being banned?"
explicitly instead of as a generic timeout.

---

## Quick reference

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | none | Worker liveness |
| `/admin/status` | GET | yes | Aggregate `overpass/` R2 cache totals |
| `/admin/country-refs-status` | GET | none | Per-shard fresh/stale/missing for country references |
| `/admin/check-fresh` | POST | yes | "Is THIS specific query cached?" |
| `/admin/list-cities` | GET | yes | Curated city rotation the laptop loops over |
| `/admin/diagnose?id=…` | GET | yes | Upstream-mirror health probe |

Two endpoints aren't listed because they don't *check* status — they
*trigger* it: `/admin/trigger-prewarm` and `/admin/prewarm-country-ref`
both run a prewarm pass on demand. Use those when you want to push
something into the cache; use the table above when you want to read
what's already there.
