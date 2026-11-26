param(
  [Parameter(Mandatory = $true)][string]$BatchPath,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$OutputLog,
  [Parameter(Mandatory = $true)][string]$ErrorLog
)

$arguments = '/d /c ""{0}" --background"' -f $BatchPath
$process = Start-Process `
  -FilePath $env:ComSpec `
  -ArgumentList $arguments `
  -WorkingDirectory $WorkingDirectory `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutputLog `
  -RedirectStandardError $ErrorLog `
  -PassThru

$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $process.Refresh()
}

if ($process.HasExited -and $process.ExitCode -ne 0) {
  exit 1
}

exit 0
