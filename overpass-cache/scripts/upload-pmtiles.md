# Uploading the Protomaps basemap to R2

The seeker app's basemap (added in v230-v233) is a Protomaps vector
PMTiles file served by this worker's `/tiles/*` route. Until a file
is uploaded under `env.TILES`, the worker route 404s and the client
silently falls back to Protomaps' public demo bucket — a third-party
dependency we want to retire as soon as a single file is in place.

## Why we self-host

- **No per-request cost.** R2 has free egress to Cloudflare Workers
  and to Cloudflare's network in general. A worldwide basemap served
  to thousands of monthly games costs essentially nothing in tile
  bandwidth on our infrastructure.
- **No third-party blocklist risk.** v225 burned us when Firefox ETP
  and Adblock Plus EasyPrivacy started blocking CartoCDN at request
  time. `tiles.protomaps.com` could in theory go the same way. Our
  own subdomain on `*.workers.dev` doesn't.
- **No commercial-use clause.** Stadia Maps' free tier is non-
  commercial only; the moment the project takes a tip jar that
  becomes a blocker. Protomaps' tiles are OSM-derived under ODbL,
  freely redistributable.
- **Versioning.** We can host a v4, v5, v6 file side by side and
  swap atomically by changing the filename in the worker route.

## One-time setup

```sh
cd overpass-cache
wrangler r2 bucket create jlhs-tiles    # already declared in wrangler.toml
```

That registers the bucket on the Cloudflare account. The worker
binding `TILES → jlhs-tiles` is in `wrangler.toml` already.

## Get a PMTiles file

Two options:

### Option A — download Protomaps' worldwide file (~120 GB)

Best for "any region in the world works out of the box."

```sh
# Protomaps publishes daily builds at https://maps.protomaps.com/builds
# Pick the most recent date you trust:
curl -L -o basemap.pmtiles \
    "https://build.protomaps.com/$(date +%Y%m%d).pmtiles"
```

This is large but only fetched once; PMTiles serves byte-ranges so
the per-tile cost is identical to a smaller file.

### Option B — extract a regional slice (~50-500 MB)

Best for "we only host the regions our cron prewarms."

```sh
# Install the pmtiles CLI (https://github.com/protomaps/go-pmtiles)
brew install protomaps/tap/pmtiles

# Extract Europe + N. America from the daily build:
pmtiles extract https://build.protomaps.com/20260614.pmtiles europe.pmtiles \
    --bbox=-25,34,46,72
pmtiles extract https://build.protomaps.com/20260614.pmtiles north-america.pmtiles \
    --bbox=-170,15,-50,75

# Or merge a few regions into one file later.
```

## Upload to R2

```sh
wrangler r2 object put jlhs-tiles/basemap.pmtiles \
    --file ./basemap.pmtiles
```

(For a ~120 GB file, run this on a machine with a fast pipe — direct
to the R2 endpoint is much faster than via wrangler. See
[Cloudflare's S3-API docs](https://developers.cloudflare.com/r2/api/s3/api/)
for the multipart-upload script.)

## Verify

```sh
curl -I "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/tiles/basemap.pmtiles"
# Expect: HTTP/2 200, Accept-Ranges: bytes, Content-Length: <size>
curl -H "Range: bytes=0-15" \
    "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/tiles/basemap.pmtiles" \
    | xxd | head
# Expect: first 16 bytes of the PMTiles header (starts with "PMTiles\0\3" — magic + version)
```

Once HEAD returns 200, the seeker app's next page load will use it
automatically (the in-app probe in `src/lib/protomapsStyle.ts`
checks once per session and caches the result).
