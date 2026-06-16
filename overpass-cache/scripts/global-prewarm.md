# Global reference prewarm + bbox slicing

Design doc for the next iteration of the Overpass-reference cache.
Status: **scaffolding committed; runtime path not yet wired.**

## Goal

Every play area on Earth (Antarctica excepted) hits R2 cache for
its reference families (museums, hospitals, airports, train
stations, brand shops, …) — instantly, regardless of whether anyone
has played there before. Boundaries continue to use the existing
per-relation cache; this design only addresses the references and
adjacent-search queries that scale with bbox area.

## How it works

1. **Cron prewarms per shard.** A "shard" is a country, or a
   sub-region of a country too large to fit in one Overpass query
   (US split into east/west at -100°; Canada similarly). Each shard
   has a bounding box. The cron fires the combined-families Overpass
   query against the shard's bbox and stores the response at
   `country-refs/<shard.iso>/all` in R2.

2. **Incoming `/api/interpreter` request → bbox extracted.** The
   query carries a `(south,west,north,east)` tuple on every family
   selector. Worker pulls that tuple out. If the query has no bbox
   (e.g. a `relation(R)` boundary fetch, an `around:` radius query),
   slicing is not eligible; fall through to existing paths.

3. **Template fingerprint match.** The worker normalises the query
   (strips the bbox tuples, collapses whitespace) and compares against
   the known combined-references template. Single-family on-tap
   queries (`prefetchCategory("hospital")`) are matched against their
   own per-family template. If no template matches, fall through.

4. **Find containing shard.** Walk `COUNTRY_SHARDS`; pick the
   smallest-by-area shard whose bbox fully contains the requested
   bbox. If none contains (border-spanning play areas, queries far
   from any prewarmed country), fall through.

5. **Read the shard's cached response.** R2 GET on
   `country-refs/<iso>/all`. If missing, fall through (the cron
   hasn't warmed this shard yet, or storage was evicted).

6. **Slice by bbox.** Parse the cached JSON, walk `elements[]`, keep
   elements whose lat/lng (or `center.lat/center.lon` for ways &
   relations) falls inside the requested bbox. Re-serialize, return
   with `X-Cache: SLICED` for diagnostics.

7. **Cache the sliced response at the edge.** Same TTL as a regular
   R2 hit, so popular play areas get served from the Cloudflare Cache
   API on subsequent identical requests — no R2 round-trip, no parse.

## Shard model

Files: `country-refs/<iso>/all` per shard.

```
country-refs/SE/all      ← Sweden, all families, ~10 MB
country-refs/DE/all      ← Germany, all families, ~25 MB
country-refs/US-east/all ← US east of -100°, ~40 MB
country-refs/US-west/all ← US west of -100°, ~30 MB
country-refs/CA-east/all
country-refs/CA-west/all
country-refs/AU/all
country-refs/JP/all
…
```

Total **214 shards** covering nearly every populated UN member state
+ a handful of dependent territories with their own OSM coverage
(Greenland, French Guiana, Puerto Rico, Cayman Islands, Hong Kong,
Macau, Faroe Islands, Isle of Man, US Virgin Islands, Guam, …).
Antarctica, polar islands, and disputed uninhabited fringes are
deliberately out of scope.

Per-shard size varies wildly: city-states like Monaco or Singapore
have <1 MB references; densely-mapped countries like Germany or
Japan land at ~25–50 MB; sparsely-mapped large countries like Mali
or Chad will be a few MB despite the geographic footprint. Total
estimated R2 footprint: **~4–8 GB worldwide**, comfortably inside
the free tier (10 GB) with room to grow as OSM coverage densifies.

Per-request: the Worker pulls one shard file from R2 (single object,
fast — typically <50 ms over the Cloudflare backbone), parses
(<200 ms even for the densest shards), bbox-filters elements,
re-serializes. Sub-second worst-case, near-instant on cache-hit
through the Cloudflare Cache API.

### Big-country splits

Single combined-families queries for very large countries either
overrun Overpass's 180 s server-side budget or produce R2 objects
slow to parse in the Worker. Where that's a risk we split:

- **United States** → US-east, US-west (at lng −100°), US-AK, US-HI
- **Canada** → CA-east, CA-west (at lng −90°)
- **Russia** → RU-west, RU-central, RU-east (at lng 60°, 120°)
- **China** → CN-east, CN-west (at lng 105°)
- **Brazil** → BR-north, BR-south (at lat −16°)
- **Australia** → AU-east, AU-west (at lng 135°)
- **Argentina** → AR-north, AR-south (at lat −40°)
- **India** → IN-north, IN-south (at lat 22°)
- **Indonesia** → ID-west, ID-east (at lng 119°)

The split bounds are loose — picked to roughly balance
population/density so each half has a tractable response size, not
to follow administrative borders.

## Why per-country, not per-family-per-country

I'd opened the door to sharding both axes (country × family =
~550 files). For v1 we don't: one combined-per-shard file is
simpler, the bulk-families query (the dominant use case) gets
served by one fetch, and storage cost is negligible. If on-tap
single-family queries become a measurable parse bottleneck later
we can split per family inside each shard without touching the
slicing function — just emit one R2 key per (shard, family) from
the cron and add the family detection to the template match.

## Border cases

A play-area bbox that spans two shards (Greater Copenhagen, the
Basel-Mulhouse area, etc.) doesn't satisfy "smallest containing
shard" against any single entry. v1 falls through to upstream
Overpass for those — the existing cache-by-query-hash path already
covers them after the first user warms it. v2 could merge sliced
responses from multiple shards on the Worker side; small extra
complexity, low payoff.

## Failure modes

Every step has a clean fall-through:

| Failure | Worker behaviour |
|---|---|
| Query has no bbox / mixed bbox forms | Existing path (R2 hash lookup → upstream) |
| Template fingerprint doesn't match a known one | Existing path |
| Bbox not fully contained in any shard | Existing path |
| R2 GET for shard returns 404 (cron hasn't warmed yet) | Existing path |
| Cached body is empty / malformed JSON | Log + existing path |
| Filter result is empty (no matching elements) | Return empty `elements: []` — same shape Overpass returns for a clean miss |

Slicing is an optimisation. The existing code stays correct if it
short-circuits — the bug surface for the new path is "extra
latency" or "fall-through to upstream", never "wrong data".

## Phase 5 cron pass

A new phase in the scheduled function, after Phase 4 (adjacent-search
prewarm):

```ts
for (const shard of COUNTRY_SHARDS) {
    const slotOk = await waitForOverpassSlot(`country-refs ${shard.iso}`);
    if (!slotOk) continue;
    try {
        const query = buildCombinedReferencesBboxQuery(shard.bbox);
        const cacheKey = `country-refs/${shard.iso}/all`;
        const r = await fetchAndStoreUpstream(env, query, cacheKey, ttlMs, {
            kind: "country-references",
            shardIso: shard.iso,
        });
        if (r.status === "stored") log(`stored ${shard.iso}: ${r.sizeBytes} B`);
    } catch (e) {
        console.warn(`[prewarm] country-refs ${shard.iso} threw:`, e);
    }
}
```

One query per shard per cron tick is plenty — at 50 shards, default
PREWARM_BATCH_SIZE pacing, the entire prewarm completes in a couple
of cron runs. Add the same skip-if-fresh logic the per-city
references pass uses so we re-warm only when the entry is past TTL.

## Wiring into `/api/interpreter`

Pseudocode:

```ts
async function handleInterpreter(query, env, cors) {
    // Existing: R2 hash lookup
    const exactHit = await tryExactCache(query);
    if (exactHit) return exactHit;

    // NEW: slicing path
    const sliced = await trySliceFromCountryRefs(query, env);
    if (sliced) return appendCacheHeaders(sliced, cors, "SLICED");

    // Existing: upstream fetch + R2 write
    return await fetchUpstreamAndStore(query, env, cors);
}
```

The slicing path runs only after the exact-hash R2 hit fails — so
re-asked queries don't pay the parse cost. The slicing path is a
single concern: "no exact hit, but I can derive an answer from a
prewarmed shard".

## Migration

1. Land scaffolding (this commit): table + helpers, no runtime
   path active.
2. Land Phase 5 cron pass behind a `COUNTRY_REFS_PREWARM_ENABLED`
   env var. Deploy. Wait until the cron has warmed all shards.
3. Land the slicing path in `handleInterpreter`, also behind an
   env var (`COUNTRY_REFS_SLICING_ENABLED`). Deploy. Verify
   `X-Cache: SLICED` shows up on a query for a play area we haven't
   ever cached.
4. Flip the slicing flag on. Watch error rates and latency. The
   fall-through means a bug in the slicing path costs us nothing
   worse than current behaviour.
5. (Later) Remove the per-city references prewarm from Phase 2.
   The country-shard path makes it redundant for any city inside
   a covered country; the per-city pass becomes wasted work.

## What this doesn't replace

- **Boundary polygons**: still per-relation. A city boundary can't
  be sliced out of a country polygon. Keep the existing per-city
  boundary prewarm.
- **HSR**: already per-country in the cron. No change.
- **Journey arrivals**: unrelated.
- **Adjacent-area search**: keep the per-city cron pass added in
  v268. It's not bbox-restricted in the same way — the query is
  keyed by (lat, lng, radius), not by bbox-containment.

## Open questions

- **TTL for country-shard caches.** The per-city references cache
  uses the default 30-day TTL. Country shards are larger and slower
  to refresh; a 60-day TTL might be more appropriate so we don't
  burn cron budget re-fetching very-large shards every month.
- **Template fingerprint storage.** Should the template hashes
  live in code (recomputed on Worker cold-start) or in R2
  metadata? Code is simpler, R2 metadata is more flexible — going
  with code for v1, can revisit.
- **Cache-busting on family-set changes.** If we ever add or
  remove a reference family from `STANDARD_REFERENCE_FAMILIES`,
  the template fingerprint changes and the slicing path stops
  matching old cached entries. Versioning the R2 key prefix
  (`country-refs/v1/SE/all`) gives a clean rebuild path.
