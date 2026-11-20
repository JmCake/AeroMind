param(
    [Parameter(Mandatory)][int]$RunnerProcessId,
    [Parameter(Mandatory)][int]$AppProcessId,
    [Parameter(Mandatory)][string]$OutFile,
    [ValidateRange(5,60)][int]$IntervalSeconds = 30
)

$ErrorActionPreference = 'Stop'
$runner = Get-CimInstance Win32_Process -Filter "ProcessId=$RunnerProcessId"
if ($runner.Name -ne 'node.exe' -or $runner.CommandLine -notmatch 'verify_lecture\.cjs') {
    throw 'Select the AeroMind lecture test runner.'
}
$service = Get-Process -Id $AppProcessId
if ($service.ProcessName -ne 'AeroMind-3D') { throw 'Select the portable AeroMind process.' }
if (Test-Path -LiteralPath $OutFile) { throw 'Select a new output file for this measurement.' }

while (Get-Process -Id $RunnerProcessId -ErrorAction SilentlyContinue) {
    $parents = @($RunnerProcessId)
    $browserIds = @()
    while ($parents.Count) {
        $clause = ($parents | ForEach-Object { "ParentProcessId=$_" }) -join ' OR '
        $parents = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' AND ($clause)" |
            Select-Object -ExpandProperty ProcessId)
        $browserIds += $parents
    }
    if ($browserIds.Count) {
        $edge = @(Get-Process -Id $browserIds -ErrorAction SilentlyContinue)
        $service.Refresh()
        [pscustomobject]@{
            utc = [DateTime]::UtcNow.ToString('o')
            edge_processes = $edge.Count
            edge_private_bytes = ($edge | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
            inference_private_bytes = $service.PrivateMemorySize64
            inference_working_set_bytes = $service.WorkingSet64
        } | Export-Csv -LiteralPath $OutFile -NoTypeInformation -Append -Encoding utf8
    }
    Start-Sleep -Seconds $IntervalSeconds
}
