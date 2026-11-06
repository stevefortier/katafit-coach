# Kata.fit Coach for the current Windows user. No Node, Docker or admin needed.
#   & ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/stevefortier/katafit-coach/main/install.ps1).Content))
#   .\install.ps1 -Archive C:\path\coach-<revision>-win-x64.zip
[CmdletBinding()]
param(
    [string]$Archive,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'katafit-coach'),
    [string]$CoachHome = $(if ($env:KATAFIT_COACH_HOME) { $env:KATAFIT_COACH_HOME } else { Join-Path $env:USERPROFILE '.katafit-coach' })
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
if ($env:OS -ne 'Windows_NT') { throw 'This installer is for Windows.' }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This installer supports x64 Windows.'
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$CoachHome = [IO.Path]::GetFullPath($CoachHome)
if ($InstallRoot.StartsWith($CoachHome + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $CoachHome.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $InstallRoot -eq $CoachHome) { throw 'The runtime and data folders must be separate.' }

# Give sensitive installation files an explicit per-user ACL, including when
# the caller chooses a data folder outside the usual protected user profile.
function Protect-Folder([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        if ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing a linked installation folder: $Path"
        }
    } else { $null = New-Item -ItemType Directory -Path $Path -Force }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($user)
    foreach ($sid in @($user, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Write-Utf8([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding $false))
}
$work = Join-Path ([IO.Path]::GetTempPath()) ('coach-install-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $work
try {
    $zip = Join-Path $work 'archive.zip'
    $expectedRevision = $null
    if ($Archive) {
        Copy-Item -LiteralPath $Archive -Destination $zip
        Write-Host 'Installing a local archive you supplied: its provenance is not verified.'
    } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host 'Finding the latest Kata.fit Coach release...'
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/stevefortier/katafit-coach/releases/latest'
        if ($release.tag_name -notmatch '^coach-([a-f0-9]{40})$') { throw 'Invalid release tag.' }
        $expectedRevision = $Matches[1]
        $name = $release.tag_name + '-win-x64.zip'
        $assets = @($release.assets | Where-Object { $_.name -eq $name })
        if ($assets.Count -ne 1 -or $assets[0].digest -notmatch '^sha256:([a-f0-9]{64})$') {
            throw 'The latest release has no Windows archive with a published digest yet.'
        }
        $digest = $Matches[1]
        Write-Host "Downloading $name..."
        $url = 'https://github.com/stevefortier/katafit-coach/releases/download/' + $release.tag_name + '/' + $name
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
            throw 'The download does not match the digest GitHub publishes for it.'
        }
    }
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $work 'extract')
    $source = Join-Path $work 'extract\katafit-coach'
    $node = Join-Path $source 'node\node.exe'
    $build = Get-Content -LiteralPath (Join-Path $source 'app\dist\build.json') -Raw | ConvertFrom-Json
    $revision = $build.revision
    if ($revision -notmatch '^[a-f0-9]{40}$' -or ($expectedRevision -and $revision -ne $expectedRevision)) {
        throw 'The archive build does not match the release.'
    }
    if (-not $Archive) {
        Write-Host "Verifying the release's attestation..."
        # A file avoids Windows PowerShell 5.1's native argument quote rewriting.
        $verify = Join-Path $work 'verify.mjs'
        Write-Utf8 $verify @'
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [root, archive, revision] = process.argv.slice(2);
const { verifyProvenanceFile } = await import(pathToFileURL(join(root, 'app/dist/release/manifest.js')).href);
await verifyProvenanceFile(archive, revision);
'@
        & $node $verify $source $zip $revision
        if ($LASTEXITCODE -ne 0) { throw 'Release attestation verification failed.' }
    }

    foreach ($folder in @($InstallRoot, $CoachHome)) {
        if ((Test-Path -LiteralPath $folder) -and
            ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing a linked installation folder: $folder"
        }
    }
    # Stop through the authenticated CLI, then wait for the bootstrap to leave
    # its executable before replacing the runtime (Windows locks running EXEs).
    $env:KATAFIT_COACH_HOME = $CoachHome
    $installedNode = Join-Path $InstallRoot 'node\node.exe'
    if (Test-Path -LiteralPath (Join-Path $CoachHome 'service.json')) {
        if (-not (Test-Path -LiteralPath $installedNode)) { throw 'Stop the existing Coach before installing.' }
        & $installedNode (Join-Path $InstallRoot 'app\dist\cli.js') stop
        if ($LASTEXITCODE -ne 0) { throw 'The existing Coach could not be stopped.' }
    }
    $pidFile = Join-Path $CoachHome 'boot.pid'
    if (Test-Path -LiteralPath $pidFile) {
        $bootPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$bootPid) -and $bootPid -gt 1) {
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while (Get-Process -Id $bootPid -ErrorAction SilentlyContinue) {
                if ([DateTime]::UtcNow -gt $deadline) { throw 'The previous bootstrap has not stopped.' }
                Start-Sleep -Milliseconds 200
            }
        }
        Remove-Item -LiteralPath $pidFile -Force
    }
    Protect-Folder $CoachHome
    $modeFile = Join-Path $CoachHome 'sandbox.json'
    if (-not (Test-Path -LiteralPath $modeFile)) { Write-Utf8 $modeFile '{"mode":"workspace"}' }
    $mode = Get-Content -LiteralPath $modeFile -Raw | ConvertFrom-Json
    if ($mode.mode -ne 'workspace') { throw 'Windows requires workspace sandbox mode.' }

    $next = $InstallRoot + '.new'
    $old = $InstallRoot + '.old'
    if ((Test-Path -LiteralPath $next) -or (Test-Path -LiteralPath $old)) {
        throw 'A previous install is incomplete. Recover the .new/.old runtime folders before reinstalling.'
    }
    Protect-Folder $next
    Copy-Item -Path (Join-Path $source '*') -Destination $next -Recurse -Force
    # Generate the startup wrapper before switching runtimes. The data folder
    # is carried into every future logon without depending on shell variables.
    $startup = @'
$ErrorActionPreference = 'Stop'
$env:KATAFIT_COACH_HOME = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'coach-home.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$node = Join-Path $PSScriptRoot 'node\node.exe'
$boot = Join-Path $PSScriptRoot 'app\dist\boot.js'
$child = Start-Process -FilePath $node -ArgumentList ('"' + $boot + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $env:KATAFIT_COACH_HOME 'boot.log') -RedirectStandardError (Join-Path $env:KATAFIT_COACH_HOME 'boot-error.log')
[IO.File]::WriteAllText((Join-Path $env:KATAFIT_COACH_HOME 'boot.pid'), [string]$child.Id)
$child.WaitForExit()
exit $child.ExitCode
'@
    Write-Utf8 (Join-Path $next 'start-coach.ps1') $startup
    # Keep paths in UTF-8 JSON rather than executable PowerShell or batch text.
    # This also avoids Windows PowerShell 5.1's default ANSI script decoding.
    Write-Utf8 (Join-Path $next 'coach-home.json') (ConvertTo-Json -InputObject $CoachHome -Compress)
    Write-Utf8 (Join-Path $next 'cli.mjs') @'
import { readFileSync } from 'node:fs';
process.env.KATAFIT_COACH_HOME = JSON.parse(readFileSync(new URL('./coach-home.json', import.meta.url), 'utf8'));
await import('./app/dist/cli.js');
'@
    $command = '@"%~dp0node\node.exe" "%~dp0cli.mjs" %*' + "`r`n"
    Write-Utf8 (Join-Path $next 'katafit-coach.cmd') $command
    if (Test-Path -LiteralPath $InstallRoot) { Move-Item -LiteralPath $InstallRoot -Destination $old }
    try { Move-Item -LiteralPath $next -Destination $InstallRoot } catch {
        if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination $InstallRoot }
        throw
    }
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }

    # A current-user task needs no stored password and always runs unelevated.
    # If local policy forbids task registration, use the user's Startup folder.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $taskName = 'KatafitCoach-' + $identity.User.Value
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $InstallRoot 'start-coach.ps1') + '"'
    $startupFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup, [Environment+SpecialFolderOption]::Create)
    $shortcutPath = Join-Path $startupFolder 'KatafitCoach.lnk'
    $autostart = 'a scheduled task'
    try {
        $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
        $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
        if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
    } catch {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $powershell
        $shortcut.Arguments = $arguments
        $shortcut.WindowStyle = 7
        $shortcut.Save()
        $autostart = 'your Startup folder (task registration is restricted)'
    }
    # Add the installed .cmd launcher to this user's PATH, never the machine's.
    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    if ($InstallRoot -notin @($userPath -split ';')) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $InstallRoot).TrimStart(';'), 'User')
    }
    $env:Path = $InstallRoot + ';' + $env:Path
    Write-Host 'Starting Coach...'
    $null = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $url = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $service = Get-Content -LiteralPath (Join-Path $CoachHome 'service.json') -Raw | ConvertFrom-Json
            if ($service.origin -notmatch '^http://127\.0\.0\.1:\d+$') { throw 'Invalid Studio address.' }
            $secrets = Get-Content -LiteralPath (Join-Path $CoachHome 'secrets.json') -Raw | ConvertFrom-Json
            $null = Invoke-WebRequest -UseBasicParsing -Uri ($service.origin + '/') -TimeoutSec 5
            $url = $service.origin + '/#' + $secrets.admin
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $url) { throw "Studio did not start. See $CoachHome\boot-error.log" }
    Write-Host "`nKata.fit Coach $($revision.Substring(0, 7)) is installed and running."
    Write-Host "`n  Studio:   $url`n  Command:  $(Join-Path $InstallRoot 'katafit-coach.cmd') (status, open, stop)`n  Data:     $CoachHome`n  Sandbox:  workspace mode (no Docker needed)"
    Write-Host "`nIt starts when you log in through $autostart. Open a new terminal to use katafit-coach from PATH."
    Write-Host 'Studio listens on this computer only.'
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
