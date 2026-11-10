# WP 5.5 check, on Windows: the HOLO installer installs for the current user only, with the
# library server address IT gives it, starts, and uninstalls cleanly.
#
#   pwsh scripts/check-installer.ps1 -Installer apps/desktop/release/HOLO-Setup-<version>.exe [-RequireSignature]
#
# The installer runs silently (/S) as IT would push it. Everything it writes must be under the
# user's own folder and HKCU: nothing in Program Files or HKLM, so no administrator is needed.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [switch]$RequireSignature
)
$ErrorActionPreference = "Stop"
$script:failed = 0
function Check([bool]$ok, [string]$what, [string]$detail = "") {
  $line = if ($ok) { "PASS" } else { "FAIL"; $script:failed++ }
  if ($detail) { Write-Host "$line $what ($detail)" } else { Write-Host "$line $what" }
}

$server = "https://viewer.internal"
$dir = Join-Path $env:LOCALAPPDATA "Programs\HOLO"
$uninstallKeys = "Software\Microsoft\Windows\CurrentVersion\Uninstall"

# Signature: required when the pipeline has the organisation's certificate.
$sig = Get-AuthenticodeSignature $Installer
if ($RequireSignature) { Check ($sig.Status -eq "Valid") "the installer is signed" "$($sig.Status) $($sig.SignerCertificate.Subject)" }
else { Write-Host "INFO installer signature: $($sig.Status) (no certificate in this pipeline)" }

# Install, silently, with the server address.
$p = Start-Process -FilePath $Installer -ArgumentList "/S", "/SERVER_URL=$server" -Wait -PassThru
Check ($p.ExitCode -eq 0) "the installer runs silently" "exit code $($p.ExitCode)"
Check (Test-Path "$dir\HOLO.exe") "HOLO is installed in the user's own folder" $dir
Check (-not (Test-Path "$env:ProgramFiles\HOLO")) "nothing goes to Program Files"
$cfg = if (Test-Path "$dir\viewer.json") { Get-Content "$dir\viewer.json" -Raw | ConvertFrom-Json } else { $null }
Check ($cfg.serverUrl -eq $server) "the server address given to the installer is in viewer.json" "$($cfg.serverUrl)"
Check (Test-Path "$dir\resources\bin\FBX2glTF.exe") "the FBX converter is installed"
Check (Test-Path "$dir\resources\web\index.html") "the web build is installed"
Check (Test-Path "$dir\resources\THIRD_PARTY_LICENSES.md") "the third-party licences are installed"
Check (-not (Test-Path "$dir\resources\web\samples\fbx")) "the FBX test file is not shipped"

$entry = Get-ChildItem "HKCU:\$uninstallKeys" | Get-ItemProperty | Where-Object { $_.DisplayName -like "HOLO*" }
Check ($null -ne $entry) "it is listed in the user's installed apps" "$($entry.DisplayName) $($entry.DisplayVersion)"
$machine = Get-ChildItem "HKLM:\$uninstallKeys" -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like "HOLO*" }
Check ($null -eq $machine) "nothing is registered for the whole machine"
Check (Test-Path "HKCU:\Software\Classes\.fbx\OpenWithList\HOLO.exe") "FBX files offer Open with HOLO"
Check (Test-Path "HKCU:\Software\Classes\.zip\OpenWithList\HOLO.exe") "zip files offer Open with HOLO"
$zipDefault = (Get-ItemProperty "HKCU:\Software\Classes\.zip" -ErrorAction SilentlyContinue).'(default)'
Check ($zipDefault -notlike "*HOLO*") "HOLO does not take over zip files" "$zipDefault"
$glb = (Get-ItemProperty "HKCU:\Software\Classes\.glb" -ErrorAction SilentlyContinue).'(default)'
Check ($null -ne $glb -and $glb -ne "") ".glb files open with HOLO" "$glb"

# Start it: it must keep running (no crash at start) with the address from viewer.json.
$app = Start-Process -FilePath "$dir\HOLO.exe" -PassThru
Start-Sleep -Seconds 20
$alive = -not $app.HasExited
Check $alive "HOLO starts and keeps running" $(if ($alive) { "window: '$((Get-Process -Id $app.Id).MainWindowTitle)'" } else { "exit code $($app.ExitCode)" })
Get-Process -Name HOLO -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

# Uninstall, silently.
$un = Get-ChildItem $dir -Filter "Uninstall*.exe" | Select-Object -First 1
$u = Start-Process -FilePath $un.FullName -ArgumentList "/S" -Wait -PassThru
# The uninstaller copies itself out of the folder and carries on; wait for it.
for ($i = 0; $i -lt 60 -and (Test-Path "$dir\HOLO.exe"); $i++) { Start-Sleep -Seconds 1 }
Check (-not (Test-Path "$dir\HOLO.exe")) "it uninstalls silently" "exit code $($u.ExitCode)"
Check (-not (Test-Path "$dir\viewer.json")) "the uninstaller removes viewer.json"
Check (-not (Test-Path "HKCU:\Software\Classes\.fbx\OpenWithList\HOLO.exe")) "the uninstaller removes Open with"
$left = Get-ChildItem "HKCU:\$uninstallKeys" | Get-ItemProperty | Where-Object { $_.DisplayName -like "HOLO*" }
Check ($null -eq $left) "it is gone from the installed apps"

if ($script:failed) { Write-Host "$($script:failed) FAILED"; exit 1 }
Write-Host "ALL PASSED"
