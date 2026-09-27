# Native Operator check-in media

The native gateway opens the backend-authorized `dojo_operator` session without choosing a member. The negotiated catalog exposes only allowed reads/writes; models supply explicit member references on scoped calls and the host owns session/idempotency fields. See [the unified contract](operator-unified-contract.md) and [native continuity](native-continuity.md).

Check-in inventory and original images remain subject to current backend category sharing, source ownership and retained-context authorization. The shared adapter validates MIME, dimensions, signature, SHA-256, byte bounds and roster references before returning native image parts. Metadata alone is not a visual assessment or proof of complete coverage. Declare vision capability only for a model that actually supports it.

Legacy Studio image cards, their temporary ID cache, text-only card wrapper and `/api/operator/image` endpoint are removed. Use native Pi for authorized tool work and the independent read-only member activity UI for human browsing. No native transcript or retrieved image is saved as an Operator chat history entry. Backend revocation must terminate retained runtime context as described in the continuity contract; a new session cannot authorize old workspace contents.

Shared media-integrity, authorization, evidence and native-continuity suites are retained. Embedded-agent tests exercise the shared transport, not the isolated terminal; `native-pi-path` and `native-browser` are the real sandbox acceptance seams. No synthetic result establishes live model judgment or a production deployment.
