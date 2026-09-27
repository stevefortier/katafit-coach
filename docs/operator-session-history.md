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

The host reconstructs pinned Pi 0.86.1 structured entries from validated provider exchanges. It never trusts a model-writable sandbox JSONL as canonical authority. A resumed sandbox receives only a bounded host-sealed seed via the existing stdio relay and opens it with Pi's native `--session`; it remains network-none, read-only-root, immutable-image and tmpfs-only with no host bind mounts. Files/attachments are never restored, opaque attachment receipts are invalidated, and image-bearing conversation histories are read-only with image-omission text.

History is bounded (64 conversations, 2 MiB per structured history, 16 MiB manifest); limits reject writes, never silently evict conversations. Delete unwanted conversations to recover capacity. The current format conservatively refuses unsupported content/versions rather than inventing a migration. An installation administrator can copy files deliberately; this is not protection from the host owner.

## Qualification

`npm test` exercises storage, lifecycle, API and served Chrome browser behavior. CI's explicit Docker test command includes `tests/native-session-docker.test.ts`. For synthetic native qualification:

```sh
NATIVE_DOCKER_TEST=1 NATIVE_TEST_IMAGE=sha256:<immutable-image-id> npx tsx --test tests/native-session-docker.test.ts
```

The same opt-in test supports `PAIRED_CONTINUITY_ORIGIN` (loopback only) and `PAIRED_CONTINUITY_TOKEN` from a disposable real backend fixture. In paired mode it reads real authorized member evidence, delivers one intentional message, expires both predecessor deadlines, reopens native history after owner restart without provider replay, checks the follow-up's retained context and exactly-one canonical send, then revokes membership and verifies withheld history. The provider itself is synthetic; this is not live-model semantic evaluation or production qualification.

Raw dirty-tree Docker qualification is distinct from clean exact-head artifact/updater qualification. Release still requires independent source review, matching immutable native artifact and package/update acceptance; do not relabel a task image or stop an active customer's Pi to obtain evidence.
