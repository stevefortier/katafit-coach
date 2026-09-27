# Durable native Operator conversations

The Operator remains the actual isolated Pi terminal, not a replacement chat renderer. With a backend advertising **Operator archive v1**, the host saves a structured, sealed Pi conversation and selects the last-used conversation on the next service start. **Start / reconnect** starts compute; reading history or restoring Pi never automatically replays a prompt, tool call or mutation.

## Controls

- **History** opens the saved conversation panel. The compact toolbar uses an accessible History icon on narrow screens.
- **Stop** destroys the sandbox, workspace and attachment bytes, but keeps a sealed conversation.
- **New** chooses a fresh conversation using the current persona, skills and settings. Stop the current runtime first.
- **Rename** changes the protected title shown when that conversation is authorized. The inventory intentionally retains content-free date labels; it does not disclose custom titles before authorization.
- **Delete** requires confirmation, erases local protected bytes and leaves a content-free tombstone. Backend chain deletion is retried from that tombstone on later inventory requests if initially unavailable. Delivered backend messages/actions are not undone. Stop an active conversation before deleting it.
- Conversation URLs use an opaque `?conversation=` ID. Start binds to that viewed selection rather than silently opening a different default.

The panel shows the frozen model, persona revision/prompt and skill revision/bodies. Changing settings or skills does not rewrite saved history; incompatible snapshots are human read-only and New uses current configuration.

## Authority and fallback

Archive support is negotiated separately from continuity v1. Older backends remain **ephemeral**; the information control states this limitation. There is no fabricated authorization fallback.

Every protected history read requires a fresh, current backend `studio_operator_authorize_archive` receipt for the exact digest/revision. Current original credential, chief authority and the complete original source proof closure must hold. Source edits, deleted membership, category changes, credential replacement and revoked media proofs can lock the **entire** mixed transcript. A local admin key alone is insufficient. Date-only inventory contains no transcript, title, prompt or skill content.

Human history authorization is not provider authority. Resume closes the predecessor, reconciles durable action receipts without replay, journals the exact idempotent resume input, opens a bounded successor and reauthorizes its context before seeding/provider dispatch. The successor is sealed before provider traffic. Interrupted turns, omitted images, unsupported Pi formats, changed settings/skills and refused/expired resume budgets become explicit read-only reasons. Generic authority uncertainty hides all content instead of rendering an offline copy.

The browser clears content before refresh, on denial, lock, navigation, offline and hidden-tab transitions. Visible history is reauthorized every ten seconds with a twenty-second erase deadline. Text is rendered with `textContent`, not HTML; ANSI control sequences are removed. Tools/structured data remain inert text.

## Storage and privacy

Host-owned canonical history lives under `<coach-home>/operator-sessions/`, outside the updater's root JSON configuration backup/restore set. This is **plaintext private local storage**, not encryption at rest: directories are owner-only 0700, files 0600. Use encrypted disks/backups when required. The implementation rejects symlinked ancestors, nonregular/hardlinked files, unexpected ownership/permissions, malformed manifests, configured secret values and raw image content. It writes/fsyncs a journaled canonical prefix before backend sealing, then atomically replaces/fsyncs the manifest. Concurrent controller writes within the singleton service are serialized; running multiple independent owners over the same home is not supported.

The host maintains an append-only pinned Pi 0.86.1 log with stable entry identities. Incoming context cannot rewrite that prefix. Assistant selections come from provider returns; backend results must match actual host dispatch receipts. New local-tool results require pending host-observed call IDs and a fixed pinned Pi builtin allowlist. They are persisted with `details.provenance: sandbox_local` and shown as **unverified sandbox output**, never backend source proofs. Skill reads use this normal local path; host attestation is not claimed. Explicit wire `isError` flags are preserved; Pi’s OpenAI serializer omits that flag, so an absent flag is not proof of success.

A genuine prefix rewrite or compaction freezes the saved prefix as `history_mismatch`: no further sealing, no restart seed. Live Pi can continue ephemerally under the same current authority, provider, tool, image and uncertain-action guards, with an explicit notice (also on reconnect). Forged backend results or unknown tool IDs remain hard refusals even after freezing; compaction cannot disable receipt validation. Live host-observed tracking retains the existing bounded history limit, not an unlimited transcript. Actual Pi skill read/bash, Stop/resume and `/compact` followed by live continuation are tested. Compacted history itself is not resumable: after Stop, choose New explicitly; no replacement conversation is silently created.

A resumed sandbox receives only a bounded host-sealed seed via the stdio relay and opens it with Pi’s native `--session`; it remains network-none, read-only-root, immutable-image and tmpfs-only with no host bind mounts. Files/attachments are never restored, opaque attachment receipts are invalidated, and image-bearing histories remain read-only with image-omission text. Snapshot compatibility compares model, compiled prompt and ordered skill names/bodies as well as revision numbers in both read and prepare, including root-settings rollback/revision reuse.

Exact pending seals are recovered before any later dispatch or generation advance. A lost acknowledgement cannot be replaced by a new digest at the same revision. Recovering a successor's first seal retires its predecessor's resume journal. Read/capture completion of the identical checkpoint is idempotent. Deletes retain only content-free pending seal identity when first-seal acknowledgement was lost, so the archive can still be deleted after local prose erasure; confirmed tombstones are removed.

History is bounded (64 conversations, 2 MiB per structured history, 16 MiB manifest); limits reject writes, never silently evict conversations. Delete unwanted conversations to recover capacity. The current format conservatively refuses unsupported content/versions rather than inventing a migration. An installation administrator can copy files deliberately; this is not protection from the host owner.

## Qualification

`npm test` exercises storage, lifecycle, API and served Chrome browser behavior. CI's explicit Docker test command includes `tests/native-session-docker.test.ts`. For synthetic native qualification:

```sh
NATIVE_DOCKER_TEST=1 NATIVE_TEST_IMAGE=sha256:<immutable-image-id> npx tsx --test tests/native-session-docker.test.ts
```

The same opt-in test supports `PAIRED_CONTINUITY_ORIGIN` (loopback only) and `PAIRED_CONTINUITY_TOKEN` from a disposable real backend fixture. In paired mode it reads real authorized member evidence, delivers one intentional message, expires both predecessor deadlines, reopens native history after owner restart without provider replay, checks the follow-up's retained context and exactly-one canonical send, then revokes membership and verifies withheld history. The provider itself is synthetic; this is not live-model semantic evaluation or production qualification.

Raw dirty-tree Docker qualification is distinct from clean exact-head artifact/updater qualification. Release still requires independent source review, matching immutable native artifact and package/update acceptance; do not relabel a task image or stop an active customer's Pi to obtain evidence.
