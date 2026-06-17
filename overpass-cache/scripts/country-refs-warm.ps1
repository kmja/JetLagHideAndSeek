<#
.SYNOPSIS
    Fast-fill country-shard references via the worker's
    /admin/prewarm-country-ref endpoint. PowerShell port of
    country-refs-warm.mjs — same behaviour, no Node required.

.DESCRIPTION
    Complement to the hourly cron (2 shards/tick -> ~5 days). This
    drains the full 214-shard list in ~6-10 hours by chaining shards
    back-to-back and blocking on each. The WORKER stays the only thing
    that talks to overpass-api.de, so script-driven warms use the same
    slot-wait + semaphore discipline as the cron — the script's pace
    IS the worker's pace. No risk of getting your own IP throttled.

    Idempotent: the worker skips shards that are already fresh, so
    rerunning is safe and cheap. Resumable: Ctrl+C and restart any
    time.

.EXAMPLE
    .\country-refs-warm.ps1 `
        -Worker "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev" `
        -AdminSecret "<your ADMIN_SECRET>"

.EXAMPLE
    # Only the four US splits:
    .\country-refs-warm.ps1 -Worker "..." -AdminSecret "..." -Filter "US-"

.PARAMETER Worker
    Worker base URL (no trailing slash). Required.

.PARAMETER AdminSecret
    The worker's ADMIN_SECRET bearer token. Required.

.PARAMETER Filter
    Only warm shards whose iso starts with one of these prefixes
    (e.g. "US-","CA-"). Omit to warm all shards.

.PARAMETER SkipFresh
    Skip shards the status endpoint already reports as fresh, without
    even asking the worker. By default we ask (the worker returns
    "skipped-fresh" cheaply), which is more accurate.

.PARAMETER DelayAfterStoreMs
    Cushion between shards we actually stored. Default 1500.

.PARAMETER MaxRetries
    Per-shard retry budget on transient errors. Default 2.
#>

param(
    [Parameter(Mandatory = $true)] [string] $Worker,
    [Parameter(Mandatory = $true)] [string] $AdminSecret,
    [string[]] $Filter = @(),
    [switch] $SkipFresh,
    [int] $DelayAfterStoreMs = 1500,
    [int] $MaxRetries = 2
)

$ErrorActionPreference = "Stop"
$WorkerUrl = $Worker.TrimEnd('/')

function Matches-Filter([string] $iso) {
    if ($Filter.Count -eq 0) { return $true }
    foreach ($f in $Filter) { if ($iso.StartsWith($f)) { return $true } }
    return $false
}

function Invoke-PrewarmShard([string] $iso) {
    $body = @{ iso = $iso } | ConvertTo-Json -Compress
    $headers = @{ Authorization = "Bearer $AdminSecret" }
    return Invoke-RestMethod -Method Post `
        -Uri "$WorkerUrl/admin/prewarm-country-ref" `
        -Headers $headers -ContentType "application/json" -Body $body
}

function Warm-WithRetries([string] $iso) {
    for ($attempt = 0; $attempt -le $MaxRetries; $attempt++) {
        try {
            return Invoke-PrewarmShard $iso
        } catch {
            if ($attempt -eq $MaxRetries) { return $null }
            $backoff = 5 * ($attempt + 1)
            Write-Host "   $iso attempt $($attempt + 1) failed ($($_.Exception.Message)), retry in ${backoff}s"
            Start-Sleep -Seconds $backoff
        }
    }
    return $null
}

# ── Pull the live shard list off the worker so we never drift from the
#    deployed table. ──────────────────────────────────────────────────
Write-Host "Fetching shard status from $WorkerUrl ..."
$status = Invoke-RestMethod -Method Get -Uri "$WorkerUrl/admin/country-refs-status"
if (-not $status.enabled) {
    Write-Warning ("COUNTRY_REFS_PREWARM_ENABLED is not 'true' on the deployed worker. " +
        "The endpoint still works, but the cron isn't running and the slicing path " +
        "won't read shards either. Continuing — set the var to 'true' when ready.")
}

$candidates = @($status.shards | Where-Object { Matches-Filter $_.iso })
Write-Host "Found $($candidates.Count) candidate shards (after filter).`n"

$totalStored = 0
$totalSkippedFresh = 0
$totalFailed = 0
$totalAttempted = 0
[int64] $totalBytes = 0

for ($i = 0; $i -lt $candidates.Count; $i++) {
    $shard = $candidates[$i]
    $pos = "[$($i + 1)/$($candidates.Count)]"

    if ($SkipFresh -and $shard.status -eq "fresh") {
        Write-Host "$pos $($shard.iso) already fresh ($($shard.ageHours)h), skip"
        $totalSkippedFresh++
        continue
    }

    $result = Warm-WithRetries $shard.iso
    $totalAttempted++

    if ($null -eq $result) {
        $totalFailed++
        Write-Host "$pos $($shard.iso) X gave up after $MaxRetries retries"
        continue
    }

    switch ($result.status) {
        "stored" {
            $kb = if ($result.sizeBytes) { "{0:N1}" -f ($result.sizeBytes / 1024) } else { "?" }
            Write-Host "$pos $($shard.iso) OK stored ($kb KB)"
            $totalStored++
            if ($result.sizeBytes) { $totalBytes += [int64]$result.sizeBytes }
            Start-Sleep -Milliseconds $DelayAfterStoreMs
        }
        "skipped-fresh" {
            Write-Host "$pos $($shard.iso) - already fresh (worker-side)"
            $totalSkippedFresh++
        }
        "slot-timeout" {
            Write-Host "$pos $($shard.iso) .. slot timeout, backing off 30s"
            Start-Sleep -Seconds 30
        }
        default {
            Write-Host "$pos $($shard.iso) ? unknown status: $($result.status)"
        }
    }
}

Write-Host "`n=== Done ==="
Write-Host "Stored:        $totalStored"
Write-Host "Skipped fresh: $totalSkippedFresh"
Write-Host "Failed:        $totalFailed"
Write-Host "Attempted:     $totalAttempted"
Write-Host ("Total bytes:   {0:N1} MB" -f ($totalBytes / 1MB))
