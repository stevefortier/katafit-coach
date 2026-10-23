# Isolated typed-task recovery

`isolated-tasks/state.json` is a bounded (32 records, 128 KiB) installation-owned journal outside rollback-prone root JSON snapshots. Each record contains only the original validated claimed task identity (including its original timestamps and all authority/lease generations), attempted result digest, an allowlisted denial reason and a SHA-256 backend/credential binding. It contains no completion payload or raw credential.

The Worker fsyncs a private temporary file, renames it atomically, then fsyncs the protected journal directory before releasing pending publication ownership. The protected home directory is synced after creating the journal directory. Any persistence uncertainty poisons that journal instance and blocks replacement; reopening validates the complete bounded state. A preexisting directory with a missing or malformed state file fails closed, not as empty history. Settings remain editable even if journal initialization fails, but Worker admission and replacement are blocked.

A replacement Worker hydrates all records and capacity. Only matching current backend/credential binding may read an old receipt. Denied, absent, mismatched and failed archival outcomes retain the original exclusion. Only an exact accepted receipt, or strict invalidation plus durable immutable archive, permits durable removal. Recovery never completes, fails or requeues the old task.

Older backends do not advertise exact-ID claim exclusions. No unsupported filter is sent. If a backend returns an excluded task ID under the matching binding (even a newer lease), the Worker refuses it before task context, inference, completion or failure, and holds typed polling for at least 60 seconds. This can delay other typed tasks until the backend's claim expires; main-request polling remains available. A different backend/credential binding does not suppress an unrelated same-ID task. Capacity is installation-wide, including unmatched bindings.

## Existing-runtime migration (separate operator procedure)

The local code API is `IsolatedTaskJournal.open(home)` followed by `preserve({ task, digest, reason, binding })`. This is not an HTTP endpoint or automatic migration. Import only an already-isolated obligation from a verified private export after the old Worker is stopped, its stopped presence is confirmed, native cleanup is confirmed and there are no live invocations or pending/main publication owners. Never import concurrently with an application owner: the journal relies on the installation's existing single-writer ownership.

Supply the original complete task object and original binding hash. Missing original timestamps/generations cannot be reconstructed from a newer backend task. `taskBinding(originalOrigin, originalToken)` computes the binding without persisting either raw value; an independently verified exported hash may be supplied directly. Validation is syntactic and cannot authenticate the provenance of an operator's export. Keep that provenance and the protected full-home backup separately. Repeated identical imports deduplicate; a different record for the same binding/task ID conflicts. Never fabricate receipts or infer acceptance/nonpublication from age or lease loss.

## Rollback limitation

The protected subdirectory survives root-only settings/update snapshots, but **legacy application code does not honor these exclusions**. Do not activate a pre-journal application/launcher over unresolved records. Rollback requires a journal-aware application or separately reviewed offline retention/admission controls. This change does not retrofit the already-loaded old Worker or authorize a production restart/import.
