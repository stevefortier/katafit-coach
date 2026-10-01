# Native Operator attachments

Native Pi can send the operator an image or a file with the `send_to_operator` tool. Items show up in the **Attachments from Pi** panel of the global Coach pane. When the pane is expanded on desktop the panel sits to the right of the terminal; when docked, or full screen below 900px wide, it stacks under the terminal. Collapsing the pane or navigating Studio keeps the cards and their previews. Images get a preview, **Enlarge** (a modal dialog) and **Download**. Other files get a download card. The tool is offered only by the Studio-owned native terminal. Other gateway consumers never see it.

## Tool contract

Pass exactly one source, plus an optional `filename` (≤120 characters) and `caption` (≤500 characters):

- **`image_receipt`**: the opaque `ir_…` value that a successful check-in image read in _this_ session returns. The host keeps up to 16 receipts / 48 MiB of validated pixels in memory for the session. Receipts cannot be forged, reused across sessions, or turned into backend references.
- **`workspace_path`**: a path to a regular file below `/workspace`, either relative (`reports/visits.csv`) or prefixed with `/workspace/`. These are rejected: any other absolute path, empty, `.` or `..` components, control/format characters, more than 8 components, components over 128 bytes, and paths over 256 bytes.

A success returns a receipt with `status: "accepted_to_operator_panel"`, `operator_viewed: "not_confirmed"`, `panel_connected`, `duplicate` and the remaining capacity. "Accepted" means stored for the panel. It does **not** mean the operator saw the item. Failures return one fixed guidance line per code: `ATTACHMENT_ARGUMENTS_REJECTED`, `_RECEIPT_UNKNOWN`, `_PATH_REJECTED`, `_FILE_NOT_FOUND`, `_FILE_UNAVAILABLE`, `_FILE_EMPTY`, `_TOO_LARGE`, `_BUDGET_EXHAUSTED`, `_REJECTED`, `_BUSY` or `_UNAVAILABLE`. `_BUSY` means the send was not dispatched. The extension never renders backend prose, and anything malformed collapses to one fixed fallback.

## Security boundaries

- **Reading**: the host starts a `docker exec` of `/usr/local/bin/node` (absolute, no `PATH` lookup) as uid 1000 in this runtime's own container, with `NODE_OPTIONS` cleared. The host supplies the read script. It walks each path component with `O_NOFOLLOW`/`O_DIRECTORY` through `/proc/self/fd`, so symlinks at any depth are refused, including intermediate directories that point back inside `/workspace`. `/workspace` is its own tmpfs, so a hardlink to anything outside it cannot be created (`EXDEV`). It `fstat`s the opened descriptor, so directories, FIFOs and devices are refused. The read is bounded to 8 MiB + 1 by both the script and the host's `maxBuffer`, and it times out after 15s. A file that grows during the read fails as `_TOO_LARGE`. Nothing in the sandbox can make the host read a host path.
- **Budgets**: 8 MiB per item, 16 items and 32 MiB per runtime. An identical source, content, filename and caption is deduplicated.
- **Typing**: bytes are sniffed and decoded with sharp. Only single-frame PNG, JPEG, GIF or WebP gets an image preview, with the extension forced to match. Everything else, including SVG, HTML and PDF, is served as `application/octet-stream`. Filenames and captions are normalized, and the UI renders them with `textContent` only.
- **Disclosure**: arguments, filename, caption, bytes and the receipt Pi would get back are screened for configured credentials before anything is published (`ATTACHMENT_REJECTED`; the item is dropped). Acceptance is itself a fresh backend authorization of the retained context.
- **Serving**: `GET /api/terminal/attachments/<session>/<id>` requires the admin bearer key. `<session>` is a random 128-bit id minted for each runtime. Unknown, old, foreign or malformed ids all return 404. Responses carry `nosniff`, `no-store`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: sandbox; default-src 'none'` and `Content-Disposition: attachment`. The browser fetches bytes once per item and displays them only through `blob:` URLs.
- **Authorization per disclosure**: every byte response and every reconnect snapshot that contains items first gets its own backend authorization of the retained context (legacy backends: a fresh check-in image recheck). No earlier allow is cached or reused, and an authorization already in flight when the request arrived never counts. Concurrent requests share only an authorization that started after them. The response carries a copy of the bytes, so a teardown during the write cannot change it. Outcomes:
  - Pi has a request in flight (authorization would race it): `503`, `Retry-After: 2`, `ATTACHMENT_AUTHORIZATION_BUSY`. Nothing is sent to the backend.
  - The backend is transiently unreachable: `503`, `Retry-After: 5`, `ATTACHMENT_AUTHORIZATION_UNAVAILABLE`. The session is kept.
  - The continuity command TTL expired: `409 ATTACHMENT_TURN_REQUIRED` until the next human turn in the terminal.
  - Another Studio operation is running: `409 OPERATION_IN_PROGRESS`.
  - Revocation, context expiry, a definite denial (legacy included) or a configuration authority change: `410`, and the runtime is destroyed.
- **Browser lifecycle**: the page keeps cards only while it can show that the session is alive and authorized:
  - Any non-policy disconnect starts a local 30s erase deadline, measured from the last frame heard. Only an authorized snapshot of the same session after reconnecting cancels it.
  - The server sends a heartbeat every 10s. 25s of silence, or the browser's `offline` event, counts as a lost link.
  - Snapshot, pending and item frames carry `context_expires_in_ms` (relative, `null` on legacy). The page erases itself at that deadline even while connected, on both monotonic and wall clocks, and re-checks when the tab becomes visible.
  - A reconnect that cannot be authorized yet gets `attachments-pending` (`busy`, `unavailable` or `turn_required`) with no metadata. The server retries (busy: every 1s; otherwise 2s backing off to 10s) while that socket and session stay current.
  - Opening the terminal in another tab sends `attachments-cleared` to the old tab before closing it.
  - Each card has its own abort signal. A response for a removed card creates no object URL. Bytes must match the announced size and, where WebCrypto exists (secure contexts), the SHA-256. The blob type always comes from validated metadata.
  - Busy is polled every 2s for up to 5 minutes. Outages back off up to 10s for six attempts. Turn-required and other refusals show distinct messages. **Download** retries a failed load and fills the preview too.
- **Teardown**: Stop, detach timeout, revocation, expiry and configuration change all zero-fill and drop host copies. The session id is invalidated before teardown finishes. A connected page receives `attachments-cleared` and a 1008 close, then revokes its object URLs. A disconnected page erases itself by its own deadline. Reconnecting within the detach window sends one authorized metadata snapshot, which the page reconciles by id with no duplicate cards or refetch.

## Limitations

- Transient backend outages are retryable, not terminal. The page's local deadlines still apply.
- Once the continuity command TTL expires, serving, reconnect snapshots and `send_to_operator` fail until the next human turn advances it.
- Previews requested while Pi is mid-request wait for a gap between its requests.
- Blobs the browser has already fetched stay in that page's memory until Stop, a session change, a local deadline, lock or page close. Downloaded files are outside Studio's control.
- Terminal output replayed on reconnect is not authorization-gated. This predates attachments and is unchanged.
- Image decoding uses sharp with a 40-megapixel `limitInputPixels` cap. The decode has no separate timeout; it is bounded by the 8 MiB input.
- If the host's 15s read timeout fires, the in-container reader process is not killed. It is bounded by the size limit and the container's resources.
- The Docker Pi end-to-end test uses a scripted provider, not a live model.
- The extension guidance is part of the sandbox image, so you need a native artifact built from this revision.
