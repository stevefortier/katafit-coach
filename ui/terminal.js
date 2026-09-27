function nativeTerminal({ api, authorized, fetchAttachment }) {
  const $ = (id) => document.getElementById(id);
  let terminal,
    fit,
    socket,
    epoch = 0,
    pending = false,
    queued = 0,
    lose;
  // The server heartbeats every 10 s; longer silence means the link is dead.
  const SILENCE_MS = 25000;
  const attachments = operatorAttachments($, fetchAttachment);
  let openTooltip,
    pinned = false;
  const closeTooltip = () => {
    if (!openTooltip) return;
    openTooltip.tip.hidden = true;
    openTooltip.button.setAttribute("aria-expanded", "false");
    openTooltip = undefined;
    pinned = false;
  };
  const positionTooltip = () => {
    if (!openTooltip) return;
    const { button, tip } = openTooltip;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    tip.style.maxWidth = `${width - 16}px`;
    tip.style.maxHeight = `${height - 16}px`;
    const anchor = button.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(left + 8, Math.min(anchor.right - box.width, left + width - box.width - 8))}px`;
    tip.style.top = `${Math.max(top + 8, Math.min(anchor.bottom, top + height - box.height - 8))}px`;
  };
  for (const id of ["nativeConnection", "nativeInfo"]) {
    const button = $(id),
      tip = $(id + "Tooltip");
    const show = () => {
      if (openTooltip?.button !== button) closeTooltip();
      openTooltip = { button, tip };
      tip.hidden = false;
      button.setAttribute("aria-expanded", "true");
      positionTooltip();
    };
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") show();
    });
    button.addEventListener("focus", show);
    button.addEventListener("click", () => {
      if (openTooltip?.button === button && pinned) closeTooltip();
      else {
        show();
        pinned = true;
      }
    });
    const leave = (event) => {
      if (openTooltip?.button !== button) return;
      if (
        button.contains(event.relatedTarget) ||
        tip.contains(event.relatedTarget)
      )
        return;
      if (
        event.type === "pointerleave" &&
        (pinned || document.activeElement === button)
      )
        return;
      closeTooltip();
    };
    button.addEventListener("pointerleave", leave);
    button.addEventListener("focusout", leave);
    tip.addEventListener("pointerleave", leave);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTooltip();
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      openTooltip &&
      !openTooltip.button.contains(event.target) &&
      !openTooltip.tip.contains(event.target)
    )
      closeTooltip();
  });
  window.addEventListener("resize", positionTooltip);
  window.addEventListener("scroll", positionTooltip, true);
  window.visualViewport?.addEventListener("resize", positionTooltip);
  window.visualViewport?.addEventListener("scroll", positionTooltip);
  const status = (state, text) => {
    const labels = {
      stopped: ["Stopped", "■"],
      starting: ["Starting", "◷"],
      connected: ["Connected", "✓"],
      disconnected: ["Disconnected", "○"],
      error: ["Error", "!"],
      unavailable: ["Unavailable", "×"],
      overflow: ["Overflow", "!"],
      stopping: ["Stopping", "◷"],
      "stop-unconfirmed": ["Stop unconfirmed", "?"],
    };
    const [label, icon] = labels[state];
    $("nativeStatus").textContent = text;
    $("nativeConnectionTooltip").textContent = text;
    $("nativeConnection").dataset.state = state;
    $("nativeConnection").setAttribute("aria-label", "Pi connection: " + label);
    $("nativeStateIcon").textContent = icon;
    positionTooltip();
  };
  function reset() {
    resetTerminal();
    attachments.clear();
  }
  function resetTerminal() {
    epoch++;
    // Leaving a live session starts its erase deadline; only an authorized
    // snapshot of the same session (after reconnecting) cancels it.
    if (socket) attachments.detached();
    lose = undefined;
    closeTooltip();
    if (
      ["connected", "starting", "disconnected"].includes(
        $("nativeConnection").dataset.state,
      )
    )
      status(
        "disconnected",
        "Disconnected from this terminal. Start or reconnect Pi to check session availability. No input is replayed.",
      );
    socket?.close();
    socket = undefined;
    terminal?.dispose();
    terminal = undefined;
    fit = undefined;
    $("nativeTerminal").replaceChildren();
    pending = false;
    queued = 0;
    $("nativeStart").disabled = false;
  }
  const resize = () => {
    if (!fit || !$("nativeTerminal").getClientRects().length) return;
    fit.fit();
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
  $("nativeStart").onclick = async () => {
    if (!authorized() || pending) return;
    // Reconnect keeps already shown attachments; the snapshot reconciles them.
    resetTerminal();
    pending = true;
    $("nativeStart").disabled = true;
    const generation = epoch;
    status("starting", "Starting isolated Pi…");
    try {
      await history.prepareStart();
      if (generation !== epoch || !authorized()) return;
      const ticket = await api("terminal/ticket", {});
      if (generation !== epoch || !authorized()) return;
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
              "Connection lost (no response from Studio). Reconnect within 30 seconds or workspace is erased.",
            ),
          SILENCE_MS,
        );
      };
      const markLost = (message) => {
        if (lost) return;
        lost = true;
        clearTimeout(watchdog);
        if (ws.readyState <= WebSocket.OPEN) ws.close();
        if (socket !== ws) return;
        attachments.detached();
        if (generation === epoch) {
          pending = false;
          $("nativeStart").disabled = false;
          if (!failed) status("disconnected", message);
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
        } else if (message.type === "ready") {
          failed = false;
          status("connected", "Connected to isolated Pi.");
          pending = false;
          $("nativeStart").disabled = false;
          resize();
          terminal.focus();
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
        else if (message.type === "history-notice") {
          status("connected", message.message);
          terminal.write("\r\n" + message.message + "\r\n");
        } else if (message.type === "error") {
          if (message.historyReadOnly) void history.refresh();
          failed = true;
          status("error", message.message);
        }
      };
      ws.onclose = (event) => {
        // Policy close means the session ended; its attachments are gone.
        if (event.code === 1008 && socket === ws) attachments.clear();
        markLost(
          "Disconnected. Reconnect within 30 seconds or workspace is erased. No input is replayed.",
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
        $("nativeStart").disabled = false;
        status(
          "unavailable",
          "Native Pi unavailable. Docker and the pinned sandbox image are required.",
        );
      }
    }
  };
  $("nativeStop").onclick = async () => {
    reset();
    status("stopping", "Stopping…");
    try {
      await api("terminal/stop", {});
      status(
        "stopped",
        "Stopped · ephemeral workspace erased. Committed backend actions are not undone.",
      );
    } catch {
      status(
        "stop-unconfirmed",
        "Stop unconfirmed. Do not retry a possibly committed action.",
      );
    }
  };
  window.addEventListener("offline", () =>
    lose?.(
      "Offline. Reconnect within 30 seconds of the last contact or workspace is erased.",
    ),
  );
  window.addEventListener("pagehide", () => {
    reset();
    observer.disconnect();
  });
  const history = operatorHistory($, api, authorized, reset);
  return {
    reset: () => {
      history.clear();
      reset();
    },
    refreshHistory: history.refresh,
  };
}

function operatorHistory($, api, authorized, resetTerminal) {
  let generation = 0,
    selected = new URL(location.href).searchParams.get("conversation"),
    timer,
    expiry;
  const clear = () => {
    generation++;
    clearTimeout(timer);
    clearTimeout(expiry);
    $("nativeHistoryLog").replaceChildren();
    $("nativeHistorySnapshot").textContent = "";
    $("nativeHistoryTitle").value = "";
    $("nativeHistoryTitle").disabled = true;
    $("nativeHistoryRename").disabled = true;
  };
  const notice = (text) => {
    $("nativeHistoryNotice").textContent = text;
  };
  const open = () => {
    $("nativeHistoryPanel").hidden = false;
    $("nativeHistoryToggle").setAttribute("aria-expanded", "true");
  };
  const text = (value) =>
    String(value)
      .replace(
        /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[@-_]/g,
        "",
      )
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) =>
        c === "\n" || c === "\t" ? c : "",
      );
  async function refresh() {
    clear();
    if (!authorized()) return;
    const epoch = generation;
    try {
      const list = await api("terminal/history");
      if (epoch !== generation || !authorized()) return;
      if (selected === null) selected = list.selected;
      const select = $("nativeHistorySelect");
      select.replaceChildren(new Option("New conversation", ""));
      for (const row of list.sessions || [])
        select.add(new Option(row.title, row.id));
      select.value = selected || "";
      $("nativeHistoryDelete").disabled = !selected;
      if (!selected) {
        notice("New conversation uses current persona, skills and settings.");
        return;
      }
      const view = await api("terminal/history/" + selected);
      if (epoch !== generation || !authorized()) return;
      open();
      notice(
        view.status !== "authorized"
          ? view.reason
          : (view.reason
              ? "Read-only: " +
                view.reason +
                ". Start a new conversation to continue."
              : "Saved conversation. Start Pi to resume; no interrupted input is replayed.") +
              " " +
              view.attachments,
      );
      if (view.status !== "authorized") return;
      $("nativeHistoryTitle").value = view.title;
      $("nativeHistoryTitle").disabled = false;
      $("nativeHistoryRename").disabled = false;
      $("nativeHistorySnapshot").textContent = text(
        JSON.stringify(view.snapshot, null, 2),
      );
      for (const entry of view.entries || []) {
        if (entry.type !== "message") continue;
        const node = document.createElement("pre");
        const message = entry.message;
        node.textContent = text(
          message.role +
            (message.details?.provenance === "sandbox_local"
              ? " · " + message.toolName + " · unverified sandbox output"
              : "") +
            "\n" +
            (typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) =>
                    part.type === "text"
                      ? part.text
                      : JSON.stringify(part, null, 2),
                  )
                  .join("\n")),
        );
        $("nativeHistoryLog").append(node);
      }
      expiry = setTimeout(
        () => {
          clear();
          notice("History hidden: refresh current authorization.");
        },
        Math.min(view.expiresAfterMs || 20000, 20000),
      );
      timer = setTimeout(
        refresh,
        Math.min(view.refreshAfterMs || 10000, 10000),
      );
    } catch {
      if (epoch === generation) {
        clear();
        notice(
          "History unavailable. Current authorization is required; retry or start a new conversation.",
        );
      }
    }
  }
  async function choose(id) {
    clear();
    try {
      await api("terminal/history/select", { id });
      resetTerminal();
      selected = id || "";
      const url = new URL(location.href);
      if (id) url.searchParams.set("conversation", id);
      else url.searchParams.delete("conversation");
      window.history.replaceState(null, "", url);
      await refresh();
    } catch {
      notice("Stop Pi before changing conversations.");
    }
  }
  $("nativeHistoryToggle").onclick = () => {
    open();
    refresh();
  };
  $("nativeHistorySelect").onchange = () =>
    choose($("nativeHistorySelect").value || null);
  $("nativeHistoryNew").onclick = () => choose(null);
  $("nativeHistoryRename").onclick = async () => {
    try {
      await api("terminal/history/rename", {
        id: selected,
        title: $("nativeHistoryTitle").value,
      });
      notice("Renamed.");
    } catch {
      clear();
      notice("Rename unavailable; current authorization is required.");
    }
  };
  $("nativeHistoryDelete").onclick = async () => {
    if (
      !selected ||
      !confirm(
        "Delete this saved conversation permanently? Backend actions are not undone.",
      )
    )
      return;
    clear();
    try {
      await api("terminal/history/delete", { id: selected, confirm: true });
      selected = "";
      await refresh();
    } catch {
      notice("Delete failed. Stop Pi before deleting its conversation.");
    }
  };
  window.addEventListener("offline", clear);
  window.addEventListener("pagehide", clear);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clear();
  });
  async function prepareStart() {
    if (selected === null) return;
    const list = await api("terminal/history");
    if (!authorized()) throw new Error("Locked");
    if ((list.selected || "") !== selected)
      await api("terminal/history/select", { id: selected || null });
  }
  return { clear, refresh, prepareStart };
}

// Attachments Pi sent with send_to_operator. Metadata arrives on the terminal
// socket; bytes are fetched privately with the admin key and shown only via
// blob URLs. Nothing is rendered as HTML.
function operatorAttachments($, fetchAttachment) {
  const MAX_BYTES = 8 * 1024 * 1024,
    MAX_ITEMS = 16,
    // Matches the server's reconnect window for an unattended session.
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
    list.append(node);
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
