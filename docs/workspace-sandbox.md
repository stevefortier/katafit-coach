# Workspace sandbox: Pi without Docker

Workspace mode runs Pi sessions without Docker, the same way on Linux and
Windows. Docker stays the default; an installation opts in with
`sandbox.json` in Coach's home:

```json
{ "mode": "workspace" }
```

An absent file means Docker. A file that is unreadable or invalid fails closed
(`SANDBOX_MODE_INVALID`): sessions refuse to start rather than choose a mode.
It covers every Pi session: headless ones (autonomy cycles and worker
requests) and Studio's interactive terminal.

## Two layers

**Pi's tools act through just-bash.** Pi keeps its own `read`, `write`,
`edit`, `ls`, `find`, `grep` and `bash` tools, with their schemas, prompts and
rendering. Only their operations change (`workspace/tools.mjs`):

- `/workspace` is the session's private host folder, through just-bash's
  `ReadWriteFs` with symlinks disabled.
- Every other path is just-bash's in-memory layout, where nothing of the host
  exists.
- `bash` is just-bash's interpreter, with pipes, the usual text tools, `jq`,
  `sqlite3`, `python3` (CPython in WebAssembly) and `js-exec` (QuickJS). No
  real program runs, and just-bash's network access (curl) is off.
- `grep` keeps Pi's schema but searches with just-bash's `rg`, because Pi's
  own grep always spawns ripgrep.
- Commands typed with `!` run in the same sandbox.

On Windows, Node reports folders without execute bits, which stops
just-bash's Python from entering them. The sandbox is told folders are
searchable; host permissions are unchanged.

**Node's permission model confines the process** (`src/sandbox/workspace.ts`).
Pi runs as `node --permission` and may:

- read only the installed application and its own session folder;
- write only its session folder;
- use worker threads, because just-bash runs Python in one. Workers inherit
  the same limits.

It cannot spawn programs, open network connections, load native addons or use
WASI. A preloaded shim (`workspace/permission-shim.mjs`) makes denied paths
look absent to `existsSync`, because Pi probes parent folders for project
resources and Node would otherwise throw. It grants nothing. Pi also starts
with `--no-approve`, so project resources in the workspace are never trusted.

## The relay over Node IPC

The relay logic is shared with Docker (`sandbox/relay-core.mjs`); only the
transport differs.

- **Docker:** Pi calls the relay over loopback HTTP inside the network-none
  container, and the relay talks to the host over `docker exec` stdio.
- **Workspace mode:** the launcher (`workspace/launch.mjs`) connects to Coach
  over Node's IPC channel (one frame per message), applies the catalog, and
  starts Pi in the same process, since child processes are forbidden. An
  extension (`workspace/fetch.mjs`) installs a `fetch` that answers the
  relay's address in-process and fails for every other origin. It is
  installed after Pi has set up its own HTTP client.

Pi's process therefore has no network permission, and its only channel out is
the IPC channel, which only Coach holds. A localhost port would be reachable
by any local process. An inherited pipe is no alternative: recent Node
releases refuse sockets on inherited descriptors without `--allow-net`. The
host side of the protocol is the same `serveRelay` the Docker runtime uses
(`src/sandbox/relayChannel.ts`), fed by small stream adapters.

One limit is specific to IPC: Node reads each message whole before Coach's
frame limits apply, so a compromised Pi process could make Coach buffer one
large message. Reaching that needs code running inside Pi's process; the
model's tools run in just-bash and cannot send IPC messages.

## The interactive terminal

A pty-spawned process could not also hold the relay's IPC channel, so Pi's
process gets pipes, and `workspace/terminal.mjs` presents them as a terminal:

- `isTTY`, a size and a raw-mode stub, so Pi chooses interactive mode and its
  TUI renders;
- `FORCE_COLOR`, `COLORTERM` and `TERM`, so it renders in colour.

Studio's xterm is the real terminal emulator. Keystrokes reach Pi raw, since
no line discipline sits in between. Sizes arrive as IPC messages
(`{ resize: [columns, rows] }`). Input keeps the Docker runtime's limits.

Attachments are read by the host, directly from the session workspace, with
the container reader's rules:

- plain name parts only;
- no links;
- the same device;
- a regular file;
- bounded size;
- on Windows, no `\` or `:` inside a name, which would allow alternate data
  streams.

## Sessions

Each session gets a private folder under `sandbox/` in Coach's home, with
`workspace`, `home` and `tmp`. The folder is removed when the session stops.
The Pi process ends with Coach: its stdin and IPC channel close. Folders left
by a crash are removed at the next startup sweep; folders owned by a live
runtime in this process are kept.
