# Run the laptop prewarm UNATTENDED, all night — resume across restarts until
# every target city is starred, keeping Windows awake the whole time.
#
# Why a wrapper: even though laptop-prewarm.mjs isolates each city in its own
# try/catch and now survives stray async faults, a long run can still be ended
# by the machine sleeping, an OS/driver hiccup, or an OOM. This loop makes that
# a non-event: on ANY exit it just restarts, and --skip-starred means each
# restart heads straight for the cities that aren't done yet (no re-walking).
# It stops on its own when a run reports "nothing to do" (exit code 3).
#
# Usage (from the overpass-cache/ directory):
#   pwsh scripts/prewarm-all-night.ps1 -Worker https://jlhs-overpass-cache.karl-mj-andersson.workers.dev -Secret YOUR_ADMIN_SECRET
#
# Options:
#   -Email  contact for the Overpass User-Agent (default: the maintainer's).
#   -Extra  extra pass-through flags as one string, e.g.
#           -Extra "--priority-regions --seed-first"  (default: --priority-regions)
#   -RestartDelay  seconds to wait between restarts (default 30).
#
# Ctrl+C stops it; the keep-awake lock is released on exit.

param(
    [Parameter(Mandatory = $true)][string]$Worker,
    [Parameter(Mandatory = $true)][string]$Secret,
    [string]$Email = "karl-mj-andersson@gmail.com",
    [string]$Extra = "--priority-regions",
    [int]$RestartDelay = 30
)

# --- keep Windows awake (no sleep) while the loop runs ---------------------
$sig = @'
[DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$power = Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru
$ES_CONTINUOUS = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"
[void]$power::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

$log = "prewarm.log"
$extraArgs = $Extra.Split(" ", [StringSplitOptions]::RemoveEmptyEntries)

try {
    while ($true) {
        "=== run start $(Get-Date -Format o) ===" | Tee-Object -FilePath $log -Append
        node scripts/laptop-prewarm.mjs `
            --worker $Worker --secret $Secret --email $Email --skip-starred `
            @extraArgs 2>&1 | Tee-Object -FilePath $log -Append
        $code = $LASTEXITCODE
        if ($code -eq 3) {
            "=== all target cities starred — stopping ($(Get-Date -Format o)) ===" |
                Tee-Object -FilePath $log -Append
            break
        }
        "=== run exited code $code; restarting in $RestartDelay s ===" |
            Tee-Object -FilePath $log -Append
        Start-Sleep -Seconds $RestartDelay
    }
}
finally {
    # Release the keep-awake lock so the machine can sleep normally again.
    [void]$power::SetThreadExecutionState($ES_CONTINUOUS)
}
