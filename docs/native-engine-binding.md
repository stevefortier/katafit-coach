# Native engine bindings

Native image authority is a local `{ image, engine }` pair. The signed release manifest, native fingerprint and signed archive/config/OCI relation remain unchanged. An image digest alone is not a daemon identity.

`legacy` is the existing `/var/run/docker.sock` endpoint. `bounded-v1` is only `/var/lib/katafit-bounded/store/run/docker.sock`. Neither manifests, environment variables, URLs nor application requests can supply an engine endpoint. Trusted external provisioning code may request `engine: "bounded-v1"` in `NativeReleaseOptions` or the internal artifact boundary **after** establishing its separately qualified physical storage guard. That parameter is not a quota proof and does not install or start anything.

Bounded operation additionally requires `/etc/katafit/native-engines.json` with exactly:

```json
{ "bounded-v1": "/var/lib/katafit-bounded/store/run/docker.sock" }
```

The file and every ancestor must be root-owned, nonsymlinked and not group/world writable. The regular file must have a single link, fit 256 bytes and match the opened descriptor's device/inode through readback. The parser rejects additional keys or any other endpoint. There is no fallback to the default daemon if the mapping is absent or invalid. Root-owned installation code must maintain the actual endpoint and its ancestry; this mapping is not proof of mount identity, disk reservation, socket availability or daemon transaction completion. No mapping is installed by the product build or tests.

Receipt layout deliberately protects old launchers:

| Binding | Protected artifact receipt                                                                          |
| ------- | --------------------------------------------------------------------------------------------------- |
| Legacy  | `native-artifacts/<revision>.json`; absent engine means legacy; an explicit `legacy` is also valid. |
| Bounded | `native-artifacts/bounded-v1/<revision>.json`; engine must be exactly `bounded-v1`.                 |

Older receipt readers ignored added keys. Putting a bounded receipt beside legacy receipts would let them inspect its ID on the wrong daemon. The fixed subdirectory makes old readers skip it. New readers reject engine/location disagreement, duplicate exact receipts across engines and ambiguous same-fingerprint reuse across engines. Exact legacy receipts still take precedence for their own active/rollback revisions. A successful same-fingerprint reuse preserves the old image, engine and receipt bytes; it does not create a replacement receipt or rebind to the requested fresh engine.

`nativeBinding` and `nativeBindingForBuild` return the pair. `nativeBindingPreflight` returns the same pair after the actual probe. Every production caller uses these interfaces, including release reconciliation, supervisor readiness/activation, terminal, autonomy and isolated invocations. NativeRuntime and headless runtime receive the complete pair. Their version, create, attach/start HTTP, relay, inspect, workspace read, sweep and removal operations use the selected endpoint. A prepared candidate is compared again by both image and engine before activation. Active pointers include engine only for a bounded binding; old legacy pointer shapes remain unchanged.

The legacy `nativeImage`, `nativeImageForBuild` and `nativePreflight` APIs remain for frozen external callers, but reject bounded bindings instead of dropping the engine. String constructor inputs and the historical injected execution/socket hooks are legacy code interfaces; production callers use a binding object. These hooks are not manifest/HTTP/environment inputs. A bounded binding rejects a conflicting socket or cleanup engine even through those code interfaces.

Probe and headless cleanup records carry an optional closed engine identifier. Absence is legacy. Restart cleanup resolves each record's own engine, independently of the currently selected candidate. A mismatched injected cleanup engine cannot inspect/remove anything. Unknown or malformed durable state stays unresolved; it is not deleted as cleanup success. The existing ownership labels, captured container ID and exact-inspection checks still apply. The release worker retains the same operator flock, subreaper and owned-command hooks for all clients, including preflight and restart cleanup.

Tests use explicitly marked code-only mapping and API fixtures. `withNativeEngineAuthorityFixture` supplies a scoped installation-reader fixture; it cannot change the fixed endpoint strings and is never populated from CLI, worker IPC, manifests or environment. Production subprocesses validate the installed file themselves. Synthetic HTTP/command responses establish routing and failure behavior only; they do not qualify Docker or persistent storage.

Before deployment, independently review this interface, integrate the external controller's mount-pinned staging/installer/store guard, qualify fresh npm installation, and exercise both engines in an authorized isolated real-daemon fixture. The controller must also understand the bounded receipt namespace and selection engine. The existing fresh `STORAGE_ISOLATION_REQUIRED` gate and uninstalled timer are unchanged. No shared containerd migration, socket bind redirect, activation, pruning or production setup is included.

For local source process tests, the existing trusted Python subreaper source must not be group/world writable (0644 is suitable). The build already packages its copy with mode 0644. A checkout created with a group-writable umask must have that local mode corrected before the process controls; do not weaken the launcher trust check. Content and Git executable mode remain unchanged.

The release-delivery operation journal records `importEngine` explicitly before
load dispatch and in every subsequent checkpoint. This is the requested import
authority, separate from the optional `engine` of a completed selected binding.
A bounded request may legitimately reuse a legacy same-fingerprint receipt; that
leaves `importEngine: "bounded-v1"` while the selected binding stays legacy and
its original receipt bytes remain unchanged.

Retries must request the same import authority. Omitted engine options retain
the legacy default and reject a durable bounded operation before any capability,
attestation or daemon command; operators must explicitly resume bounded requests
through the trusted programmatic interface. No new CLI/environment authority is
introduced. Unknown/malformed journal engines, inconsistent selection fields and
changed manifest/staging identity fail closed. Checkpoint writes use the existing
file-fsync/rename/directory-fsync atomic writer; failure prevents later effects.
During fresh probing the `provisioning` checkpoint retains import authority;
during reuse probing `validating-reuse` also retains the selected binding.

Historical journals without `importEngine` mean legacy only when unambiguous:
pre-import `staging`/`staged` and valid completed/validating legacy selection may
resume as legacy and are upgraded durably before commands. Old `loading`,
`provisioning` or `provisioned` records lack enough information to distinguish an
interrupted bounded effect from legacy, so they reject. A selected bounded engine
without import authority also rejects. Such records require separately authorized
reconciliation; retry never guesses their engine or erases their evidence.
