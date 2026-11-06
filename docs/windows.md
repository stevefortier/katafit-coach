# Coach on Windows

Coach runs on Windows like on Linux: the bootstrap (`katafit-coach-boot`)
starts the active version's supervisor, which runs Studio and installs
upgrades from the release's `win-x64` archive. Pi runs in
[workspace mode](workspace-sandbox.md), which is the default there; Docker mode
is Linux-only.

`install.ps1` downloads the latest `win-x64` archive, checks GitHub's SHA-256
digest before executing its bundled Node, and verifies the archive's build
attestation against the release revision. A supplied `-Archive` is explicitly a
local, unverified install. The runtime lives in `%LOCALAPPDATA%\katafit-coach`;
data lives in `%USERPROFILE%\.katafit-coach` (or `KATAFIT_COACH_HOME`).
Both folders get explicit inheritable permissions for the current user, SYSTEM
and administrators. `-InstallRoot` and `-CoachHome` can override these locations.

The installer adds the runtime's `.cmd` launcher to the user's PATH and saves
a login action that carries the data path with it. A current-user scheduled
task runs without elevation or a stored password and has no execution time
limit. If local policy refuses task registration, a current-user Startup
shortcut runs the same action. Coach runs immediately after installation;
automatic startup happens when this user logs in. Rerunning the installer stops
Coach through its authenticated CLI, waits for the bootstrap to release Node's
executable, replaces the runtime, and preserves settings, credentials and data.

Windows lacks some of the POSIX mechanisms the Linux code relies on.
`src/runtime/platform.ts` gives each one its Windows counterpart, and Linux
behaviour is unchanged:

| Linux | Windows |
|---|---|
| Private files and folders are checked for owner uid and mode bits | The installation lives in the user's profile, whose access list admits only the user, SYSTEM and administrators; Windows has no uids or POSIX modes to check |
| Folders are fsynced after a rename or creation | Skipped: Windows refuses fsync on a folder handle, and NTFS journals folder changes |
| Files are reopened read-only to fsync them | Reopened with write access, which Windows requires to flush a file |
| `flock` keeps a single owner per Coach home | `serve` holds a named pipe derived from the home; a second owner cannot listen on it, and Windows releases it when the process ends |
| A stop is a `SIGTERM` | Signals are hard terminations there, so the bootstrap and supervisor close the child's IPC channel instead, and Coach's processes shut down cleanly on disconnect; a hard stop follows only after the grace period |

The CI `windows` job runs the Windows archive under its bootstrap like an
installed copy:

- Studio answers, and its authenticated status does too.
- A second owner of the same home is refused.
- `katafit-coach stop` ends everything cleanly.

It also runs the bootstrap, handover and workspace upgrade suites on Windows.
The installer smoke runs separately as a newly created standard user under
Windows PowerShell 5.1. It checks private ACLs, user PATH, paths containing
spaces and an apostrophe, rejection of an incorrect release digest without
stopping the running copy, preservation of data and credentials on reinstall,
the saved login action, and clean shutdown.
