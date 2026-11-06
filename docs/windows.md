# Coach on Windows

Coach runs on Windows like on Linux: the bootstrap (`katafit-coach-boot`)
starts the active version's supervisor, which runs Studio and installs
upgrades from the release's `win-x64` archive. Pi runs in
[workspace mode](workspace-sandbox.md), which is the default there; Docker mode
is Linux-only.

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
