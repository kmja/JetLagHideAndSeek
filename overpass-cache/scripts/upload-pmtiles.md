# Uploading the Protomaps basemap to R2

The seeker app's basemap (v230–v233) is a Protomaps vector PMTiles
file served by this worker's `/tiles/*` route. This is the proven,
working recipe — it's what produced the live `basemap.pmtiles` on
2026-06-15. Re-run it to refresh the basemap to a newer Protomaps
build, or to host a higher/lower zoom or a different region.

## Why we self-host

- **No per-request cost.** R2 has free egress to Cloudflare Workers.
  A worldwide basemap served to thousands of monthly games costs
  ~nothing in tile bandwidth.
- **No third-party blocklist risk.** v225 burned us when Firefox ETP
  and Adblock Plus EasyPrivacy started blocking CartoCDN. Our own
  `*.workers.dev` subdomain isn't classified as a tracker.
- **No commercial-use clause.** Stadia Maps' free tier is
  non-commercial only. Protomaps tiles are OSM-derived (ODbL),
  freely redistributable.

## Three traps we hit (so you don't again)

1. **Don't download the full planet through a browser.** The 127 GB
   worldwide build stalls in browser download managers (single long
   stream → CDN reset → slower-on-resume → dead). Instead, `pmtiles
   extract` pulls *only* the zoom levels you want, via many small
   range requests — robust + far smaller (world @ z13 ≈ 33 GB, not
   127 GB).
2. **Don't use `wrangler r2 object put`** for a multi-GB file
   (single-PUT capped at 5 GB), and **add `--s3-no-check-bucket`** to
   rclone — a bucket-scoped R2 token can't do the `CreateBucket`
   probe rclone does by default, and you'll get `403 AccessDenied`
   without it.
3. **A failed `pmtiles extract` leaves a deceptively "complete" file
   (v259 incident).** `extract` pre-allocates the full output size up
   front, then streams tile data in. If it dies partway (e.g. an HTTP/2
   `INTERNAL_ERROR` stream reset from build.protomaps.com mid-stream),
   the on-disk file is still full-size but mostly empty holes — and
   `extract` **cannot resume**, it restarts from zero. rclone will
   happily upload the husk at "100%", and `curl -I` returns `200 OK`
   because the object exists, so every downstream signal looks green
   while ~⅔ of the tiles are missing. **Always scroll up and confirm
   the extract logged completion, not `Failed to extract`, before
   trusting the upload.** For the *worldwide* case specifically, skip
   `extract` altogether — see "Worldwide z15" below — since z15 is the
   planet build's source ceiling, so the planet file already IS
   worldwide z15 and a plain resumable download beats a non-resumable
   extract.

## Worldwide z15 (no extract — resumable download)

z15 is Protomaps' source ceiling, so `build.protomaps.com/YYYYMMDD.pmtiles`
**is already worldwide z15** (~127 GB). Running `pmtiles extract` on it
just copies the whole file over a fragile non-resumable HTTP/2 stream.
Instead download it with curl forced to HTTP/1.1 (dodges the stream
reset) and `-C -` resume, wrapped in a loop so any drop just resumes:

```powershell
$BUILD_DATE = "20260614"
$KEY        = "basemap-z15-$BUILD_DATE.pmtiles"   # must match DEFAULT_PMTILES_URL
$work       = "$env:USERPROFILE\jlhs-pmtiles"
New-Item -ItemType Directory -Force -Path $work | Out-Null; Set-Location $work
Remove-Item "$work\basemap.pmtiles" -ErrorAction SilentlyContinue  # free the husk

$src = "https://build.protomaps.com/$BUILD_DATE.pmtiles"
$dst = "$work\$KEY"
$expected = [int64]((curl.exe -sI $src |
    Select-String 'Content-Length:\s*(\d+)').Matches.Groups[1].Value)
do {
    curl.exe --http1.1 -C - --retry 1000 --retry-all-errors --retry-delay 5 -o $dst $src
    $have = (Get-Item $dst -ErrorAction SilentlyContinue).Length
    Write-Host "Have $have / $expected bytes"
} while ($have -lt $expected)
# then upload $dst to r2:jlhs-tiles/$KEY with the rclone block below.
```

Needs ~127 GB free local disk. Tight on space? Stream straight through
rclone with HTTP/2 disabled and no local copy:
`rclone copyto :http:$BUILD_DATE.pmtiles r2:jlhs-tiles/$KEY --http-url=https://build.protomaps.com --disable-http2 --s3-no-check-bucket --s3-chunk-size=256M --s3-upload-concurrency=8 --retries=20 --low-level-retries=50 --progress`.

## One-time setup

The `jlhs-tiles` bucket already exists (declared in `wrangler.toml`,
created in the dashboard). You need an R2 **Account API token** with
**Object Read & Write** scoped to `jlhs-tiles` (Cloudflare dashboard
→ R2 → Manage R2 API Tokens → Create Account API token). Copy the
**Access Key ID**, **Secret Access Key**, and **Account ID** (the
`<id>` in the S3 endpoint `https://<id>.r2.cloudflarestorage.com`).

## The recipe (Windows PowerShell)

Fill in the 3 token values + a recent build date, paste the block,
walk away. It self-installs `pmtiles.exe` + `rclone.exe`, extracts,
uploads, and verifies.

```powershell
$R2_ACCESS_KEY = "<ACCESS_KEY_ID>"
$R2_SECRET     = "<SECRET_ACCESS_KEY>"
$R2_ACCOUNT_ID = "<ACCOUNT_ID>"
$BUILD_DATE    = "20260614"   # https://build.protomaps.com/YYYYMMDD.pmtiles
$MAXZOOM       = 13           # z13 ≈ 33 GB; vector tiles over-zoom cleanly past this

$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$work = "$env:USERPROFILE\jlhs-pmtiles"
New-Item -ItemType Directory -Force -Path $work | Out-Null; Set-Location $work

function Get-Tool($url, $zip, $exe) {
    if (Test-Path "$work\$exe") { return }
    Invoke-WebRequest $url -OutFile "$work\$zip"
    Expand-Archive "$work\$zip" -DestinationPath "$work\$($exe)-x" -Force
    Copy-Item (Get-ChildItem "$work\$($exe)-x" -Recurse -Filter $exe |
               Select-Object -First 1).FullName "$work\$exe" -Force
}
Get-Tool "https://github.com/protomaps/go-pmtiles/releases/download/v1.30.3/go-pmtiles_1.30.3_Windows_x86_64.zip" "pm.zip" "pmtiles.exe"
Get-Tool "https://downloads.rclone.org/rclone-current-windows-amd64.zip" "rc.zip" "rclone.exe"

# Extract world @ maxzoom (range requests; ~6 min at 95 MB/s for z13)
& "$work\pmtiles.exe" extract "https://build.protomaps.com/$BUILD_DATE.pmtiles" `
    "$work\basemap.pmtiles" "--maxzoom=$MAXZOOM" "--download-threads=8"

# Upload to R2 under the exact key the app reads. --s3-no-check-bucket
# is REQUIRED for a bucket-scoped token.
$env:RCLONE_CONFIG_R2_TYPE = "s3"
$env:RCLONE_CONFIG_R2_PROVIDER = "Cloudflare"
$env:RCLONE_CONFIG_R2_ACCESS_KEY_ID = $R2_ACCESS_KEY
$env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = $R2_SECRET
$env:RCLONE_CONFIG_R2_ENDPOINT = "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
& "$work\rclone.exe" copyto "$work\basemap.pmtiles" "r2:jlhs-tiles/basemap.pmtiles" `
    --s3-no-check-bucket --s3-chunk-size=256M --s3-upload-concurrency=8 `
    --retries=20 --low-level-retries=40 --progress

curl.exe -I "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/tiles/basemap.pmtiles"
```

## Verify

The final `curl -I` should show `HTTP/1.1 200`, `Accept-Ranges:
bytes`, and `Content-Length` ≈ your file size. Once it's 200, the
app's probe (`src/lib/protomapsStyle.ts`) stops falling back to the
Protomaps public demo bucket on the next page load. In the browser
Network tab you'll see `206 Partial Content` range reads against
`/tiles/basemap.pmtiles`.

## Regional / higher-zoom variants

- Smaller file, fewer regions: add `--bbox=west,south,east,north` to
  the extract (e.g. Europe `--bbox=-25,34,46,72`).
- More street detail: bump `--maxzoom` (each level ~quadruples size).
  z13 is plenty for the muted transit-first style; maplibre
  over-zooms vector tiles cleanly when you zoom past the max.
