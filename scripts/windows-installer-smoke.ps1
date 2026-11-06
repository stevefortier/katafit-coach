# Run as a standard user, using the archive built from the PR head.
param([string]$Archive, [string]$Installer, [string]$Root)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
function Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal $identity
Check (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'The smoke must run without admin rights.'
$folderName = "User space's 100% " + [char]0x00E9 + ' Coach'
$runtime = Join-Path (Join-Path $Root $folderName) 'runtime'
$dataHome = Join-Path (Join-Path $Root $folderName) 'data'
$node = Join-Path $runtime 'node\node.exe'
$cli = Join-Path $runtime 'app\dist\cli.js'
$env:KATAFIT_COACH_HOME = $dataHome
$env:KATAFIT_COACH_PORT = '0'
$env:TEMP = Join-Path $Root 'Temp'
$env:TMP = $env:TEMP
$null = New-Item -ItemType Directory -Path $env:TEMP -Force

function Status {
    $service = Get-Content -LiteralPath (Join-Path $dataHome 'service.json') -Raw | ConvertFrom-Json
    $secrets = Get-Content -LiteralPath (Join-Path $dataHome 'secrets.json') -Raw | ConvertFrom-Json
    $null = Invoke-WebRequest -UseBasicParsing -Uri ($service.origin + '/api/status') -Headers @{ Authorization = 'Bearer ' + $secrets.admin } -TimeoutSec 10
    & $node $cli status
    Check ($LASTEXITCODE -eq 0) 'The installed CLI status failed.'
    # A new terminal has no inherited home override; the installed command
    # carries it, including for a custom data location.
    $savedHome = $env:KATAFIT_COACH_HOME
    try {
        Remove-Item Env:\KATAFIT_COACH_HOME
        & (Join-Path $runtime 'katafit-coach.cmd') status
        Check ($LASTEXITCODE -eq 0) 'The installed command lost its data path.'
    } finally { $env:KATAFIT_COACH_HOME = $savedHome }
}
function Stop-Coach {
    if (Test-Path -LiteralPath (Join-Path $dataHome 'service.json')) {
        & $node $cli stop
        Check ($LASTEXITCODE -eq 0) 'The installed CLI stop failed.'
    }
    if (Test-Path -LiteralPath (Join-Path $dataHome 'boot.pid')) {
        $bootPid = [int](Get-Content -LiteralPath (Join-Path $dataHome 'boot.pid') -Raw)
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (Get-Process -Id $bootPid -ErrorAction SilentlyContinue) {
            Check ([DateTime]::UtcNow -lt $deadline) 'The bootstrap did not exit cleanly.'
            Start-Sleep -Milliseconds 200
        }
    }
}
try {
    & $Installer -Archive $Archive -InstallRoot $runtime -CoachHome $dataHome
    Status
    # A junction must never redirect runtime replacement into another folder.
    $outside = Join-Path $Root 'outside'
    $null = New-Item -ItemType Directory -Path $outside
    [IO.File]::WriteAllText((Join-Path $outside 'keep-me'), 'untouched')
    $linked = Join-Path $Root 'linked-runtime'
    $null = New-Item -ItemType Junction -Path $linked -Target $outside
    $rejectedLink = $false
    try { & $Installer -Archive $Archive -InstallRoot $linked -CoachHome $dataHome } catch {
        Check ($_.Exception.Message -like '*Refusing a linked installation folder*') ('Unexpected link rejection: ' + $_.Exception.Message)
        $rejectedLink = $true
    } finally { [IO.Directory]::Delete($linked) }
    Check $rejectedLink 'A linked runtime folder was accepted.'
    Check ((Get-Content -LiteralPath (Join-Path $outside 'keep-me') -Raw) -eq 'untouched') 'The linked folder was modified.'
    Check ((Get-Content -LiteralPath (Join-Path $dataHome 'sandbox.json') -Raw | ConvertFrom-Json).mode -eq 'workspace') 'The installer must choose workspace mode.'
    $admin = (Get-Content -LiteralPath (Join-Path $dataHome 'secrets.json') -Raw | ConvertFrom-Json).admin
    [IO.File]::WriteAllText((Join-Path $dataHome 'keep-me'), 'preserved')

    foreach ($folder in @($dataHome, $runtime)) {
        $acl = Get-Acl -LiteralPath $folder
        Check $acl.AreAccessRulesProtected 'Installation folders must have explicit ACLs.'
        foreach ($rule in $acl.Access) {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            Check ($sid -in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) "Unexpected installation ACL: $sid"
        }
    }
    Check ($runtime -in ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')) 'The command must be on the user PATH.'

    # A bad published digest must fail before disturbing the running copy.
    $originalPid = Get-Content -LiteralPath (Join-Path $dataHome 'boot.pid') -Raw
    $script:smokeArchive = $Archive
    function Invoke-RestMethod {
        return @{ tag_name = 'coach-' + ('a' * 40); assets = @(@{ name = 'coach-' + ('a' * 40) + '-win-x64.zip'; digest = 'sha256:' + ('0' * 64) }) }
    }
    function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing)
        Copy-Item -LiteralPath $script:smokeArchive -Destination $OutFile
    }
    $rejected = $false
    try { & $Installer -InstallRoot $runtime -CoachHome $dataHome } catch {
        Check ($_.Exception.Message -like '*does not match the digest*') ('Unexpected rejection: ' + $_.Exception.Message)
        $rejected = $true
    } finally {
        Remove-Item Function:\Invoke-RestMethod
        Remove-Item Function:\Invoke-WebRequest
    }
    Check $rejected 'A corrupt release digest was accepted.'
    Check ((Get-Content -LiteralPath (Join-Path $dataHome 'boot.pid') -Raw) -eq $originalPid) 'A rejected download disturbed the running installation.'
    Status

    # Reinstallation must stop the locked Windows runtime before replacing it.
    & $Installer -Archive $Archive -InstallRoot $runtime -CoachHome $dataHome
    Status
    Check ((Get-Content -LiteralPath (Join-Path $dataHome 'secrets.json') -Raw | ConvertFrom-Json).admin -eq $admin) 'Reinstall changed the admin credential.'
    Check ((Get-Content -LiteralPath (Join-Path $dataHome 'keep-me') -Raw) -eq 'preserved') 'Reinstall lost existing data.'
    Check (-not (Test-Path -LiteralPath ($runtime + '.old'))) 'An old runtime was left behind.'

    Stop-Coach
    # Exercise the actual persisted login action, including its saved data path.
    $taskName = 'KatafitCoach-' + $identity.User.Value
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Check ($task.Principal.RunLevel -eq 'Limited') 'The login task must not elevate.'
        Check ($task.Settings.ExecutionTimeLimit -eq 'PT0S') 'The login task must run without a time limit.'
        $action = $task.Actions[0]
        $arguments = $action.Arguments
        $executable = $action.Execute
    } else {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'KatafitCoach.lnk'))
        $arguments = $shortcut.Arguments
        $executable = $shortcut.TargetPath
    }
    Check ($arguments.Contains((Join-Path $runtime 'start-coach.ps1'))) 'The saved login action points at the wrong runtime.'
    $null = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while (-not (Test-Path -LiteralPath (Join-Path $dataHome 'service.json'))) {
        Check ([DateTime]::UtcNow -lt $deadline) 'The saved login action did not start Coach.'
        Start-Sleep -Milliseconds 500
    }
    Status
    Write-Host 'Windows installer smoke passed as a standard user: install, digest and junction rejection, reinstall, login action and clean stop.'
} finally {
    Stop-Coach
    Unregister-ScheduledTask -TaskName ('KatafitCoach-' + $identity.User.Value) -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'KatafitCoach.lnk') -Force -ErrorAction SilentlyContinue
}
