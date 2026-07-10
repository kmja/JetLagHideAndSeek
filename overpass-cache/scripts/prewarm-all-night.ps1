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
    # ALL laptop-prewarm flags go here (mode included), so you can run any mode
    # under the keep-awake + restart-until-exit-3 loop. Examples:
    #   normal warm   : -Extra "--skip-starred --priority-regions"   (default)
    #   audit + repair: -Extra "--audit-encoding --repair --priority-regions"
    #                   (fixes the encoding-poisoned entries across the list;
    #                    do NOT include --skip-starred here — that would skip
    #                    the warmed cities, which are exactly the poisoned ones)
    [string]$Extra = "--skip-starred --priority-regions",
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
            --worker $Worker --secret $Secret --email $Email `
            @extraArgs 2>&1 | Tee-Object -FilePath $log -Append
        $code = $LASTEXITCODE
        if ($code -eq 3) {
            "=== nothing left to do (exit 3) — stopping ($(Get-Date -Format o)) ===" |
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
