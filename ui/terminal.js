// One terminal for the page: its session outlives pane layout, collapse and
// Studio navigation. `active` means the session is wanted; `visible` means the
// pane is on screen. Only a visible pane reconnects automatically (checked
// again when a queued retry fires), so a collapsed pane never silently
// restarts Pi or reclaims another tab's session. A native Stop ends the
// session for good: only a deliberate start (connect) begins another.
function nativeTerminal({
  api,
  authorized,
  active,
  visible = active,
  canFocus = visible,
  onStatus = () => {},
  onOutput = () => {},
  // Committed memory receipts for this session only (never stored).
  onMemory = () => {},
  fetchAttachment,
}) {
  const $ = (id) => document.getElementById(id);
  let terminal,
    fit,
    socket,
    epoch = 0,
    pending = false,
    queued = 0,
    lose,
    retryTimer,
    retryDelay = 1500,
    // Set when the server stopped the session; suppresses every automatic
    // reconnect until a deliberate start (connect).
    ended = false,
    stateNow = "stopped";
  // The server heartbeats every 10 s; longer silence means the link is dead.
  const SILENCE_MS = 25000;
  const attachments = operatorAttachments($, fetchAttachment);
  const status = (state, text) => {
    $("nativeStatus").textContent = text;
    $("nativeStatus").dataset.state = state;
    stateNow = state;
    onStatus(state, text);
  };
  const away =
    "Disconnected. Reconnects when you open Coach; input is never replayed.";
  const retry = () => {
    if (!active() || !visible() || ended) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(reconnect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  };
  // Automatic reattachment: the pane may have been collapsed, or Pi stopped,
  // since this was queued.
  function reconnect() {
    if (active() && visible() && !ended) void connect({ automatic: true });
    else if (stateNow === "disconnected") status("disconnected", away);
  }
  // Lock/auth reset: also forgets a Stop, since the next unlock starts lazily.
  function reset() {
    teardown();
    ended = false;
  }
  function teardown() {
    resetTerminal();
    attachments.clear();
    onMemory({ type: "memory-notices", notices: [] });
  }
  function resetTerminal() {
    epoch++;
    // Leaving a live session starts its erase deadline; only an authorized
    // snapshot of the same session (after reconnecting) cancels it.
    if (socket) attachments.detached();
    lose = undefined;
    clearTimeout(retryTimer);
    if (["connected", "starting", "disconnected"].includes(stateNow))
      status(
        "disconnected",
        "Disconnected from this terminal. Reconnecting on return to Coach; input is never replayed.",
      );
    socket?.close();
    socket = undefined;
    terminal?.dispose();
    terminal = undefined;
    fit = undefined;
    $("nativeTerminal").replaceChildren();
    pending = false;
    queued = 0;
  }
  let resizeVersion = 0;
  // Genuine interaction takes precedence over a queued layout correction.
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
    $("nativeTerminal").addEventListener(event, () => resizeVersion++, {
      capture: true,
      passive: true,
    });
  const resize = () => {
    if (!fit || !$("nativeTerminal").getClientRects().length) return;
    const buffer = terminal.buffer.active;
    const viewport = terminal.element?.querySelector(".xterm-viewport");
    // Growing the pane can clamp DOM scroll before ResizeObserver runs and
    // make xterm's still-old row model look scrolled up. Physical bottom is
    // also following; tolerate one CSS pixel of scrollbar rounding.
    const following =
      buffer.viewportY >= buffer.baseY ||
      (viewport &&
        Math.abs(
          viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        ) <= 1);
    const current = terminal;
    const version = ++resizeVersion;
    fit.fit();
    if (following) {
      const pinBottom = () => {
        if (
          terminal !== current ||
          resizeVersion !== version ||
          !$("nativeTerminal").getClientRects().length
        )
          return;
        current.scrollToBottom();
        // A matching model makes scrollToBottom a no-op, even if the DOM
        // viewport resync still holds the pre-fit pixel offset.
        if (viewport)
          viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
      };
      pinBottom();
      requestAnimationFrame(() => requestAnimationFrame(pinBottom));
    }
    // Let xterm reflow a history reader's viewport; restoring its old numeric
    // row would select different text when the column count changes.
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
  };
  const observer = new ResizeObserver(resize);
  observer.observe($("nativeTerminal"));
  async function connect({ automatic = false } = {}) {
    ended = false;
    if (
      !authorized() ||
      !active() ||
      pending ||
      socket?.readyState === WebSocket.OPEN
    )
      return;
    // Reconnect keeps already shown attachments; the snapshot reconciles them.
    resetTerminal();
    pending = true;
    const generation = epoch;
    status("starting", "Starting isolated Pi…");
    try {
      const ticket = await api("terminal/ticket", {});
      if (generation === epoch && automatic && !visible()) {
        pending = false;
        status("disconnected", away);
        return;
      }
      if (generation !== epoch || !authorized() || !active()) return;
      terminal = new window.Terminal({
        screenReaderMode: true,
        scrollback: 1000,
        fontSize: 13,
        convertEol: false,
        theme: { background: "#101010", foreground: "#e8e8e8" },
      });
      fit = new window.FitAddon.FitAddon();
      terminal.loadAddon(fit);
      terminal.open($("nativeTerminal"));
      fit.fit();
      socket = new WebSocket(
        location.origin.replace(/^http/, "ws") + ticket.path,
      );
      const ws = socket;
      let failed = false;
      let lost = false,
        watchdog;
      const heard = () => {
        attachments.heard();
        clearTimeout(watchdog);
        watchdog = setTimeout(
          () =>
            markLost(
              "Connection lost (no response from Studio). Reconnecting automatically; input is never replayed.",
            ),
          SILENCE_MS,
        );
      };
      const markLost = (message, hidden = away) => {
        if (lost) return;
        lost = true;
        clearTimeout(watchdog);
        if (ws.readyState <= WebSocket.OPEN) ws.close();
        if (socket !== ws) return;
        attachments.detached();
        if (generation === epoch) {
          pending = false;
          if (ended)
            status(
              "ended",
              "Pi session ended. Start a new session or reopen Coach to begin again; input is never replayed.",
            );
          else if (!failed)
            status("disconnected", visible() ? message : hidden);
          retry();
        }
      };
      lose = markLost;
      terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536)
          ws.send(JSON.stringify({ type: "input", data }));
      });
      ws.onopen = () => {
        heard();
        ws.send(JSON.stringify({ ticket: ticket.ticket }));
      };
      ws.onmessage = (event) => {
        if (generation !== epoch || lost) return;
        heard();
        const message = JSON.parse(event.data);
        if (message.type === "output") {
          queued += message.data.length;
          if (queued > 256 * 1024) {
            failed = true;
            ws.close();
            status(
              "overflow",
              "Terminal output overflow. Reconnect; input is never replayed.",
            );
            return;
          }
          terminal.write(message.data, () => {
            queued -= message.data.length;
          });
          onOutput();
        } else if (message.type === "ready") {
          failed = false;
          status("connected", "Connected to isolated Pi.");
          retryDelay = 1500;
          pending = false;
          resize();
          if (canFocus()) terminal.focus();
        } else if (message.type === "attachments")
          attachments.snapshot(
            message.session,
            message.items,
            message.context_expires_in_ms,
          );
        else if (message.type === "attachments-pending")
          attachments.pending(
            message.session,
            message.reason,
            message.context_expires_in_ms,
          );
        else if (message.type === "attachment")
          attachments.add(
            message.session,
            message.item,
            message.context_expires_in_ms,
          );
        else if (message.type === "attachments-cleared") attachments.clear();
        else if (
          message.type === "memory-notice" ||
          message.type === "memory-notices"
        )
          onMemory(message);
        else if (message.type === "error") {
          failed = true;
          status("error", message.message);
        }
      };
      ws.onclose = (event) => {
        // Policy close means the session ended; its attachments are gone.
        if (event.code === 1008 && socket === ws) attachments.clear();
        // An explicit native Stop is never undone automatically.
        if (
          event.code === 1008 &&
          event.reason === "Session stopped" &&
          socket === ws &&
          generation === epoch
        )
          ended = true;
        markLost(
          "Disconnected. Reconnecting automatically; input is never replayed.",
        );
      };
      ws.onerror = () => {
        if (generation === epoch) {
          failed = true;
          status("error", "Native terminal connection failed.");
        }
      };
    } catch {
      if (generation === epoch) {
        pending = false;
        retry();
        status(
          "unavailable",
          "Native Pi unavailable. Docker and the pinned sandbox image are required.",
        );
      }
    }
  }
  window.addEventListener("offline", () =>
    lose?.("Offline. Reconnecting automatically when the connection returns."),
  );
  window.addEventListener("pagehide", () => {
    // Clears the terminal and attachments but keeps a Stop latched, so a
    // back/forward cache return cannot restart Pi on its own.
    teardown();
    observer.disconnect();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    observer.observe($("nativeTerminal"));
    resume();
  });
  // Reattach after the page was hidden, only while the pane is on screen and
  // Pi was not stopped. A collapsed pane waits for a deliberate open.
  function resume() {
    if (active() && visible() && !ended) void connect({ automatic: true });
  }
  return {
    reset,
    connect,
    resume,
    suspend: resetTerminal,
    focus: () => terminal?.focus(),
    started: () => !!terminal,
    // "Don't save this chat": the current session only; true when sent.
    stopMemoryCapture() {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: "memory-capture", enabled: false }));
      return true;
    },
  };
}

// Attachments Pi sent with send_to_operator. Metadata arrives on the terminal
// socket; bytes are fetched privately with the admin key and shown only via
// blob URLs. Nothing is rendered as HTML.
function operatorAttachments($, fetchAttachment) {
  const MAX_BYTES = 8 * 1024 * 1024,
    MAX_ITEMS = 16,
    // Browser-only privacy deadline for detached attachment previews.
    DETACH_MS = 30000,
    IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  let session = "",
    dialogEntry,
    lastHeard = performance.now();
  // Erase deadlines on both the monotonic and wall clocks; either one passing
  // erases (a suspended tab may not advance the monotonic clock).
  const deadlines = { detach: undefined, expiry: undefined };
  const items = new Map();
  const list = $("nativeAttachmentList");
  const dialog = $("attachmentDialog");
  const valid = (item) =>
    item &&
    typeof item === "object" &&
    /^at_[a-f0-9]{32}$/.test(item.id) &&
    typeof item.filename === "string" &&
    item.filename.length > 0 &&
    item.filename.length <= 160 &&
    typeof item.caption === "string" &&
    item.caption.length <= 600 &&
    ["image", "download"].includes(item.preview) &&
    (item.preview !== "image" || IMAGE_TYPES.includes(item.mime_type)) &&
    Number.isSafeInteger(item.byte_count) &&
    item.byte_count > 0 &&
    item.byte_count <= MAX_BYTES &&
    /^[a-f0-9]{64}$/.test(item.sha256);
  const size = (bytes) =>
    bytes < 1024
      ? bytes + " B"
      : bytes < 1024 * 1024
        ? (bytes / 1024).toFixed(1) + " KB"
        : (bytes / 1024 / 1024).toFixed(1) + " MB";
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function notice(text) {
    const node = $("nativeAttachmentsNotice");
    node.textContent = text || "";
    node.hidden = !text;
  }
  function schedule(kind, ms, message) {
    const current = deadlines[kind];
    if (current) clearTimeout(current.timer);
    deadlines[kind] = undefined;
    if (ms === undefined) return;
    const delay = Math.max(0, Math.min(ms, 2 ** 31 - 1));
    deadlines[kind] = {
      at: performance.now() + delay,
      wall: Date.now() + delay,
      message,
      timer: setTimeout(() => clear(message), delay),
    };
  }
  function check() {
    for (const kind of ["detach", "expiry"]) {
      const deadline = deadlines[kind];
      if (
        deadline &&
        (performance.now() >= deadline.at || Date.now() >= deadline.wall)
      )
        return clear(deadline.message);
    }
  }
  function heard() {
    lastHeard = performance.now();
  }
  function detached() {
    const remaining = lastHeard + DETACH_MS - performance.now();
    const current = deadlines.detach;
    if (current && current.at - performance.now() <= remaining) return;
    schedule(
      "detach",
      remaining,
      items.size ? "Attachments erased: the terminal stayed disconnected." : "",
    );
  }
  function expiry(ms) {
    if (ms === null) return schedule("expiry");
    if (typeof ms !== "number" || !Number.isFinite(ms)) return;
    schedule(
      "expiry",
      ms,
      "Attachments erased: Pi's operator context expired. Send Pi a message to continue.",
    );
  }
  function render() {
    $("nativeAttachmentsEmpty").hidden = items.size > 0;
    $("nativeAttachmentCount").textContent = items.size
      ? "(" + items.size + ")"
      : "";
  }
  function clear(message) {
    schedule("detach");
    schedule("expiry");
    session = "";
    closeDialog();
    for (const [key, entry] of items) remove(key, entry);
    list.replaceChildren();
    notice(message);
    render();
  }
  const validSession = (id) =>
    typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
  // An authorized snapshot: the only frame that re-admits retained cards.
  function snapshot(id, snapshotItems, expiresIn) {
    if (!validSession(id)) return clear();
    if (id !== session) {
      clear();
      session = id;
    }
    schedule("detach");
    notice("");
    expiry(expiresIn);
    const current = new Set();
    for (const item of Array.isArray(snapshotItems)
      ? snapshotItems.slice(0, MAX_ITEMS)
      : [])
      if (valid(item)) {
        current.add(item.id);
        add(id, item);
      }
    for (const [key, entry] of items) if (!current.has(key)) remove(key, entry);
    render();
  }
  // Reconnected but not yet re-authorized: nothing new is shown and the erase
  // deadline keeps running.
  function pending(id, reason, expiresIn) {
    if (!validSession(id)) return clear();
    if (id !== session && items.size) clear();
    expiry(expiresIn);
    notice(
      {
        busy: "Waiting for Pi to finish its request before refreshing attachments…",
        unavailable:
          "Studio backend unreachable; attachments refresh when it returns.",
        turn_required:
          "Send Pi a message to re-authorize and refresh attachments.",
      }[reason] || "Attachments are waiting for authorization.",
    );
  }
  function remove(key, entry) {
    entry.controller.abort();
    if (dialogEntry === entry) closeDialog();
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.node.remove();
    items.delete(key);
  }
  function add(id, item, expiresIn) {
    if (id !== session || !valid(item) || items.has(item.id)) return;
    expiry(expiresIn);
    if (items.size >= MAX_ITEMS) return;
    const entry = {
      item,
      url: "",
      loading: undefined,
      controller: new AbortController(),
    };
    const node = (entry.node = element("li", "attachment-card"));
    node.dataset.attachmentId = item.id;
    const image = item.preview === "image";
    let preview;
    if (image) {
      preview = element("button", "attachment-preview");
      preview.type = "button";
      preview.setAttribute("aria-label", "Enlarge " + item.filename);
      preview.disabled = true;
      preview.onclick = () => openDialog(entry);
      const img = element("img");
      img.alt = item.caption || item.filename;
      img.decoding = "async";
      preview.append(img);
      node.append(preview);
    }
    node.append(element("div", "attachment-name", item.filename));
    node.append(
      element(
        "div",
        "attachment-meta",
        (image ? item.mime_type.slice(6).toUpperCase() + " image" : "File") +
          " · " +
          size(item.byte_count),
      ),
    );
    if (item.caption)
      node.append(element("div", "attachment-caption", item.caption));
    const state = element("div", "attachment-state");
    state.setAttribute("role", "status");
    node.append(state);
    const actions = element("div", "attachment-actions");
    if (image) {
      const enlarge = element("button", "secondary", "Enlarge");
      enlarge.type = "button";
      enlarge.disabled = true;
      enlarge.onclick = () => openDialog(entry);
      actions.append(enlarge);
      entry.enlarge = enlarge;
    }
    const download = element("button", "secondary", "Download");
    download.type = "button";
    download.onclick = () => downloadEntry(entry);
    actions.append(download);
    node.append(actions);
    entry.state = state;
    entry.preview = preview;
    items.set(item.id, entry);
    // Snapshots and live frames follow host acceptance order, oldest first.
    // Prepend only new identities: ties/clock changes need no timestamp sort,
    // and reconnect duplicates must not move existing cards or steal focus.
    list.prepend(node);
    render();
    if (image) void load(entry).catch(() => {});
  }
  function show(entry) {
    if (!entry.preview) return;
    entry.preview.querySelector("img").src = entry.url;
    entry.preview.disabled = false;
    entry.enlarge.disabled = false;
  }
  const wait = (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  const hex = (buffer) =>
    Array.from(new Uint8Array(buffer), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  const errorCode = async (response) => {
    try {
      const body = await response.json();
      return typeof body?.error === "string" ? body.error : "";
    } catch {
      return "";
    }
  };
  // One private fetch per attachment; retried only for a recoverable 503.
  // Each disclosure is authorized by the backend, which cannot happen while
  // Pi has a request in flight, so busy is polled steadily for a while;
  // backend outages back off.
  function load(entry) {
    if (entry.url) return Promise.resolve(entry.url);
    if (entry.loading) return entry.loading;
    const signal = entry.controller.signal,
      scope = session;
    const live = () =>
      !signal.aborted &&
      scope === session &&
      items.get(entry.item.id) === entry;
    entry.state.textContent = "Loading…";
    entry.loading = (async () => {
      let unavailable = false,
        outages = 0;
      const busyUntil = performance.now() + 300000;
      for (;;) {
        const response = await fetchAttachment(
          "/api/terminal/attachments/" + scope + "/" + entry.item.id,
          signal,
        );
        if (!live()) {
          await response.body?.cancel().catch(() => {});
          return "";
        }
        if (response.status === 503 || response.status === 409) {
          const code = await errorCode(response);
          if (!live()) return "";
          if (response.status === 409)
            throw new Error(
              code === "ATTACHMENT_TURN_REQUIRED"
                ? "Send Pi a message to re-authorize, then try again."
                : "Studio is busy with another operation. Try again shortly.",
            );
          unavailable = code === "ATTACHMENT_AUTHORIZATION_UNAVAILABLE";
          if (unavailable ? ++outages > 6 : performance.now() > busyUntil)
            break;
          entry.state.textContent = unavailable
            ? "Studio backend unreachable. Retrying…"
            : "Waiting for Pi to finish its request…";
          const after = Number(response.headers.get("retry-after")) || 0;
          await wait(
            Math.min(
              10000,
              Math.max(after * 1000, unavailable ? 2000 * outages : 2000),
            ),
            signal,
          );
          if (!live()) return "";
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error(
            response.status === 404 || response.status === 410
              ? "No longer available. Its session ended."
              : "Unavailable right now. Try again.",
          );
        }
        const declared = Number(response.headers.get("content-length"));
        if (declared > MAX_BYTES) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Rejected: larger than announced.");
        }
        const blob = await response.blob();
        if (!live()) return "";
        if (blob.size !== entry.item.byte_count)
          throw new Error("Rejected: size did not match.");
        // Digest check where WebCrypto exists (secure contexts); otherwise
        // the exact size check above still applies.
        if (globalThis.crypto?.subtle) {
          const digest = hex(
            await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
          );
          if (!live()) return "";
          if (digest !== entry.item.sha256)
            throw new Error("Rejected: content did not match.");
        }
        // The type comes from validated metadata, never the response.
        const type =
          entry.item.preview === "image"
            ? entry.item.mime_type
            : "application/octet-stream";
        entry.url = URL.createObjectURL(new Blob([blob], { type }));
        entry.state.textContent = "";
        show(entry);
        return entry.url;
      }
      throw new Error(
        unavailable
          ? "Studio backend is still unreachable. Try again later."
          : "Pi is still busy. Try again shortly.",
      );
    })().catch((error) => {
      if (live())
        entry.state.textContent =
          error instanceof TypeError
            ? "Unavailable right now. Try again."
            : error.message;
      throw error;
    });
    entry.loading
      .finally(() => {
        if (!entry.url) entry.loading = undefined;
      })
      .catch(() => {});
    return entry.loading;
  }
  function saveAs(entry) {
    const link = document.createElement("a");
    link.href = entry.url;
    link.download = entry.item.filename;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }
  async function downloadEntry(entry) {
    try {
      const url = await load(entry);
      if (url && items.get(entry.item.id) === entry) saveAs(entry);
    } catch {}
  }
  function openDialog(entry) {
    if (!entry.url) return;
    dialogEntry = entry;
    $("attachmentDialogTitle").textContent = entry.item.filename;
    $("attachmentDialogCaption").textContent = entry.item.caption;
    const img = $("attachmentDialogImage");
    img.alt = entry.item.caption || entry.item.filename;
    img.src = entry.url;
    const download = $("attachmentDialogDownload");
    download.href = entry.url;
    download.download = entry.item.filename;
    if (!dialog.open) dialog.showModal();
    $("attachmentDialogClose").focus();
  }
  function closeDialog() {
    dialogEntry = undefined;
    if (dialog.open) dialog.close();
    $("attachmentDialogImage").removeAttribute("src");
    $("attachmentDialogDownload").removeAttribute("href");
  }
  $("attachmentDialogClose").onclick = closeDialog;
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener("close", () => {
    if (dialogEntry) closeDialog();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
  render();
  return { snapshot, pending, add, clear, heard, detached };
}
