# Saved model providers

## Studio

**Settings → Kata.fit** holds the Kata.fit origin, private connection token and saved-connection test. **Settings → Models** holds named providers and their models. The remaining Persona, Preview, Diagnostics, Updates and Worker tabs are unchanged. `/settings?section=connection` and `#connection` are aliases for Kata.fit; `/settings?section=models` opens Models.

Register a provider name, base URL and private API key. Add each supported model's display name, exact provider model ID and optional vision flag. Provider/model IDs used internally are stable across edits. Select **Use after Save**, then use the shared **Save**. It saves Kata.fit, Models and Persona drafts together. Browsing, editing and selecting a draft model makes no provider request. The saved-active badge changes only after a successful Save. Switching to a registered provider reuses its saved endpoint/key; switching back restores its selected model and vision setting.

Only the existing OpenAI-compatible chat-completions protocol is supported. An OpenAI preset is a convenience, not a separate native adapter. There is no automatic model discovery, subscription OAuth or protocol detection. A saved entry without a key is allowed for setup, but inference still requires a key under the current Pi transport.

You may edit or remove providers/models. Removing the active entry requires selecting another valid model in the same Save. Blank credential fields retain a saved key only for the same provider identity and unchanged normalized base URL. Changing the endpoint of a keyed provider requires explicitly re-entering the intended credential or choosing **Remove saved key**. Removing its binding is not revocation at the provider; the previous configuration's private credential may remain for legacy rollback. Revoke compromised keys at their issuer.

Stop the worker and finish active preview/Operator work before saving. Source-update locking and native-terminal shutdown apply as for existing configuration saves. Tabs preserve drafts without remounting. Lock/auth expiry clears drafts and private key inputs; late responses from old authentication cannot repopulate the editor. Persona restore replaces only persona fields, retaining saved registry/credentials and unsaved other-tab drafts.

## Authenticated API

`GET /api/config` retains the legacy `provider: {baseUrl, model, vision}` active mirror and adds:

```json
{
  "models": {
    "active": {"provider": "alpha", "model": "reasoner"},
    "providers": [{
      "id": "alpha",
      "name": "Example provider",
      "baseUrl": "https://example.invalid/v1",
      "hasCredential": true,
      "models": [{"id": "reasoner", "name": "Reasoner", "model": "exact-model-id", "vision": false}]
    }],
    "limits": {"providers": 16, "modelsPerProvider": 32, "models": 64}
  }
}
```

No credential or private binding reference is returned. To save, POST the complete `origin`, eight-field `persona`, optional `token`, and `models: {active, providers}`. Providers have `id`, `name`, `baseUrl`, `models`, and optionally `apiKey` (nonempty sets/replaces) or `clearApiKey: true` (clears). Omit GET-only `hasCredential` and `limits`. Do not send top-level `apiKey` in registry mode. Optional legacy `provider` must match the derived active entry exactly.

Legacy saves without `models` remain supported: the top-level `provider` and optional `apiKey` edit the current active entry, preserving inactive providers. Endpoint changes still require credential intent. UI export is a secret-free description, not a credentials backup or a directly round-trippable save body.

IDs match `^[a-z0-9][a-z0-9_-]{0,63}$`; provider IDs are unique and model IDs are unique within a provider. Limits: 16 providers, 32 models per provider, 64 models total, 100-character display names, 200-character exact model IDs, 2048-character registry base URLs, and 4096-character new registry keys. Every provider must contain at least one model. Failures use fixed codes, including `INVALID_REGISTRY`, `REGISTRY_LIMIT`, `ACTIVE_MODEL_REQUIRED`, `CREDENTIAL_REQUIRED`, `INVALID_SECRET` and `CONFIG_TOO_LARGE`, never submitted values.

All current/inactive/new credentials are checked against current and retained configuration/persona history. The HTTP save also scans persisted Operator chat and action receipts before writing. Preview and runtime output screening include inactive credentials. Credentials must never be pasted into display names, model IDs, persona, chat or action text.

## Migration, persistence and recovery

An old single-provider installation loads as one registered **Default provider**, preserving endpoint, model, vision and API key. Migration is synthesized in memory on load and materialized on the next successful settings save. Existing persona history is untouched. Every successful save adds a persona revision, even if only the active model changed.

`Config.provider` and `Store.secrets.apiKey` remain canonical active mirrors for runtime/older readers. Private keys live only in flat string slots in protected `secrets.json`; inactive keys remain available when switching providers. Stored registry entries contain opaque versioned credential references, not keys. Re-entering a credential allocates a new binding so an interrupted write cannot associate it with the previous endpoint. Keys referenced by current/previous registry are retained; otherwise unreferenced slots are pruned on a subsequent configuration save.

Saves/restores/legacy rollback are serialized. When the endpoint/key pair changes, persistence first writes an empty legacy `apiKey` mirror plus bound slots, publishes config, then finalizes the active key mirror. An interrupted final mirror write leaves the committed registry usable by this release on restart, with an empty key for older readers rather than a mismatched credential. The committed config is the boundary; final compatibility-mirror repair failure does not undo a committed save. Pre-publication failure restores old private state. Persona restore never changes the registry or credentials. Legacy whole-configuration rollback restores the previous registry/active selection and recomputes its bound key; rolling back to a legacy endpoint without a safe matching binding leaves the key empty.

Serialized root config is capped below 3 MiB and secrets below 240 KiB, within the existing updater's 4 MiB per-file limit. Persona archives remain immutable separate records. No updater limits or protocol have changed. Back up the entire protected Coach home, not only `config.json`. Private files are not an OS keychain or encryption-at-rest guarantee. Never send a protected home as ordinary diagnostics.

## Verification

New tests: `tests/model-registry.test.ts`, `tests/model-registry-api.test.ts`, `tests/model-registry-runtime.test.ts`, and `tests/model-registry-browser.test.ts`. The browser case uses the real Store and admin server with synthetic credentials/endpoints, verifies explicit Save/readback, A→B→A, draft preservation, endpoint intent, removal, export/locking and mobile layout. These receipts do not claim live provider inference. Set `COACH_EVIDENCE_DIR` to retain synthetic screenshots outside the checkout.
