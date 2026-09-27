# Native Operator attachments

Native Pi can send the operator an image or a file with the `send_to_operator` tool. Items show up in the **Attachments from Pi** panel beside the terminal on `/chat/operator`. On desktop the panel sits to the right of the terminal. Below 900px wide it stacks under the terminal. Images get a preview, **Enlarge** (a modal dialog) and **Download**. Other files get a download card. The tool is offered only by the Studio-owned native terminal. Other gateway consumers never see it.

## Tool contract

Pass exactly one source, plus an optional `filename` (≤120 characters) and `caption` (≤500 characters):

- **`image_receipt`**: the opaque `ir_…` value that a successful check-in image read in _this_ session returns. The host keeps up to 16 receipts / 48 MiB of validated pixels in memory for the session. Receipts cannot be forged, reused across sessions, or turned into backend references.
- **`workspace_path`**: a path to a regular file below `/workspace`, either relative (`reports/visits.csv`) or prefixed with `/workspace/`. These are rejected: any other absolute path, empty, `.` or `..` components, control/format characters, more than 8 components, components over 128 bytes, and paths over 256 bytes.

A success returns a receipt with `status: "accepted_to_operator_panel"`, `operator_viewed: "not_confirmed"`, `panel_connected`, `duplicate` and the remaining capacity. "Accepted" means stored for the panel. It does **not** mean the operator saw the item. Failures return one fixed guidance line per code: `ATTACHMENT_ARGUMENTS_REJECTED`, `_RECEIPT_UNKNOWN`, `_PATH_REJECTED`, `_FILE_NOT_FOUND`, `_FILE_UNAVAILABLE`, `_FILE_EMPTY`, `_TOO_LARGE`, `_BUDGET_EXHAUSTED`, `_REJECTED`, `_BUSY` or `_UNAVAILABLE`. `_BUSY` means the send was not dispatched. The extension never renders backend prose, and anything malformed collapses to one fixed fallback.

## Security boundaries

- **Reading**: the host starts a `docker exec` as uid 1000 in this runtime's own container, with `NODE_OPTIONS` cleared. The host supplies the read script. It walks each path component with `O_NOFOLLOW`/`O_DIRECTORY` through `/proc/self/fd`, so symlinks at any depth are refused. It `fstat`s the opened descriptor, so directories, FIFOs and devices are refused. The read is bounded to 8 MiB + 1 by both the script and the host's `maxBuffer`, and it times out after 15s. Nothing in the sandbox can make the host read a host path.
- **Budgets**: 8 MiB per item, 16 items and 32 MiB per runtime. An identical source, content, filename and caption is deduplicated.
- **Typing**: bytes are sniffed and decoded with sharp. Only single-frame PNG, JPEG, GIF or WebP gets an image preview, with the extension forced to match. Everything else, including SVG, HTML and PDF, is served as `application/octet-stream`. Filenames and captions are normalized, and the UI renders them with `textContent` only.
- **Disclosure**: arguments, filename, caption and bytes are screened for configured credentials (`ATTACHMENT_REJECTED`). Acceptance is itself a fresh backend authorization of the retained context.
- **Serving**: `GET /api/terminal/attachments/<session>/<id>` requires the admin bearer key. `<session>` is a random 128-bit id minted for each runtime. Unknown, old, foreign or malformed ids all return 404. Responses carry `nosniff`, `no-store`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: sandbox; default-src 'none'` and `Content-Disposition: attachment`. The browser fetches bytes once per item and displays them only through `blob:` URLs.
- **Freshness**: bytes are served only if the backend authorized the retained context within the last 30s. Otherwise the host reauthorizes first. While Pi has a request in flight, a stale fence returns `503` with `Retry-After: 2` (`ATTACHMENT_AUTHORIZATION_BUSY`), and the UI retries with backoff. A continuity revocation, expiry or configuration authority change returns `410` and destroys the runtime.
- **Teardown**: Stop, detach timeout, revocation, expiry and configuration change all zero-fill and drop host copies. The session id is invalidated before teardown finishes. The page receives `attachments-cleared` and a 1008 close, then revokes its object URLs. Reconnecting within the detach window sends one metadata snapshot, which the page reconciles by id with no duplicate cards or refetch.

## Limitations

- On legacy (non-continuity) backends, a failed reauthorization refuses serving but does not tear the runtime down. Only continuity revocation or expiry is terminal.
- Once the continuity command TTL expires, serving (and `send_to_operator`) fails until the next human turn advances it.
- Blobs the browser has already fetched stay in that page's memory until Stop, a session change, lock, or page close. Downloaded files are outside Studio's control.
- The extension guidance is part of the sandbox image, so you need a native artifact built from this revision.
