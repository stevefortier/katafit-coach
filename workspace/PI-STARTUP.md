# Workspace Pi 0.86.1 interactive integration

Workspace mode deliberately has no host PATH, child-process permission or
network access. Its find, grep and human shell commands run in just-bash;
autocomplete uses that same virtual filesystem, not native fd or host reads.

Pi 0.86.1 offers `ctx.ui.addAutocompleteProvider`, used by `autocomplete.mjs`.
It does **not** offer a managed-tool initialization override: its interactive
CLI unconditionally awaits native fd/rg discovery before extension binding,
even with `--no-builtin-tools` or `--no-tools`.

`pi-startup.mjs` applies a workspace-only, in-memory dependency patch using
Node's supported synchronous `registerHooks` API. It replaces exactly the
single native bootstrap expression with a completed empty dependency result
(`fdPath = null`, not an executable availability claim). Every actual native
consumer is replaced before interactive readiness. All upstream warning text
and the tools-manager implementation remain unchanged. Docker and RPC do not
install this hook. No dependency tree is edited and no install script is needed.

The patch requires Pi **0.86.1** and SHA256
`2d5dc2025bf5cb9632f83491472677a281f8bfa375840bf785d38a9d7f103e1b`
of `dist/bundle/chunks/chunk-CMRUVXTE.js`, from the locked npm dependency.
Version/hash/patch-site drift fails closed before terminal presentation. A Pi
upgrade must explicitly re-review the startup seam, update the pin, and rerun
actual permission-bound startup/search/completion tests. Prefer a future
upstream managed-tool lifecycle hook over retaining the patch indefinitely.

## Qualification

Using the supported Node 26 toolchain:

```sh
node --import tsx --test tests/workspace-startup.test.ts tests/workspace-pi-integration.test.ts
```

`WORKSPACE_STARTUP_RECEIPTS=<directory>` saves raw TUI, real tool results and
post-input isolation receipts. The test waits for Pi's post-initialization OSC
title and a real `!` command response before checking the entire transcript.
The provider is scripted; native Pi tool execution and terminal input are real.

For a package-layout check, build and `npm pack --ignore-scripts`, unpack into
a disposable installation with the exact locked dependencies physically under
its `node_modules`, then run the same startup test with
`WORKSPACE_TEST_APP=<unpacked package directory>`. This uses compiled production
WorkspaceRuntime and unchanged production permission grants. The source test
alone grants read access to externally symlinked retained dependencies when
necessary; it never changes production permissions or the dependency symlink.
