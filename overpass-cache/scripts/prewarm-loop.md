# Running the prewarm loop on your PC

`laptop-prewarm.mjs` warms the worker's R2 cache from your home IP
(which isn't rate-limited the way the worker's shared Cloudflare-edge
IP is). It walks every city the worker knows about and primes, per
city:

- **boundary** — the play-area polygon
- **references** — all 15 question-reference families (hospitals,
  museums, parks, train stations, …)
- **transit** — subway / bus / ferry route overlays (v247)

and once per run, **HSR** (high-speed rail) per country.

It's idempotent: each query asks the worker whether R2 already holds a
fresh entry and skips the upstream fetch if so. So running it on a loop
just keeps everything warm and picks up newly-discovered cities.

## One-time setup

1. Install **Node 18+** (https://nodejs.org — LTS is fine).
2. Clone the repo somewhere (the script lives in it):
   ```powershell
   git clone https://github.com/kmja/jetlaghideandseek.git
   ```

## Run once (to test)

```powershell
node .\jetlaghideandseek\overpass-cache\scripts\laptop-prewarm.mjs `
    --worker https://jlhs-overpass-cache.karl-mj-andersson.workers.dev `
    --secret <WORKER_ADMIN_SECRET> `
    --delay-ms 2000
```

Watch the log. You'll see `✓ ... stored` for fresh fetches and
`⤼ ... already cached — skipping` for warm ones. First full pass over
~230 cities takes a few hours (it paces to overpass-api.de's slot
limits); subsequent passes are fast because almost everything's warm.

Useful flags:
- `--max 50` — only the first 50 cities (quick smoke test).
- `--skip-transit` / `--skip-references` / `--skip-hsr` /
  `--skip-boundaries` / `--skip-discover` — drop a phase.
- `--delay-ms 3000` — slower pacing if you see lots of 429s.

## Run on a loop (overnight / indefinitely)

Paste this into a fresh PowerShell window. It pulls the latest script,
runs a full pass, sleeps an hour, repeats — forever (Ctrl+C to stop).
Fill in the secret once at the top.

```powershell
$SECRET = "<WORKER_ADMIN_SECRET>"
$WORKER = "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev"
$REPO   = "$env:USERPROFILE\jetlaghideandseek"
$SLEEP_HOURS = 1

# Clone once if it's not there yet.
if (-not (Test-Path $REPO)) {
    git clone https://github.com/kmja/jetlaghideandseek.git $REPO
}

while ($true) {
    Write-Host "=== prewarm pass starting $(Get-Date -Format o) ==="
    # Pull the latest script (cheap; picks up new cities + query fixes).
    git -C $REPO pull --quiet 2>$null
    node "$REPO\overpass-cache\scripts\laptop-prewarm.mjs" `
        --worker $WORKER --secret $SECRET --delay-ms 2000
    Write-Host "=== pass done $(Get-Date -Format o); sleeping $SLEEP_HOURS h ==="
    Start-Sleep -Seconds ($SLEEP_HOURS * 3600)
}
```

## Leaving it running unattended

- A `$5/month` VPS or any always-on home PC handles this fine — it's
  network-bound, near-zero CPU.
- To survive reboots on Windows, wrap the loop in a Scheduled Task set
  to "Run whether user is logged on or not" with trigger "At startup".
- The script never deletes anything; the worst a bad run does is fail
  to warm a city, which the next pass retries. Safe to kill any time.

## How this relates to the in-app preload

The client also warms the *current* play area at hiding-period start
(`src/lib/preload.ts`) — boundary, references, transit overlays, HSR.
That covers any city, including ones not in the worker's list. This
loop is the *proactive* layer: it warms the curated city list ahead of
time so the very first player in a popular city gets instant cache hits
instead of paying the Overpass round-trip themselves. Both write to the
same R2 entries (identical query strings → identical cache keys), so
they reinforce each other rather than duplicate work.
