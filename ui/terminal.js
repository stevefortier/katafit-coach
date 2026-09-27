function nativeTerminal({ api, authorized, fetchAttachment }) {
  const $ = (id) => document.getElementById(id);
  let terminal,
    fit,
    socket,
    epoch = 0,
    pending = false,
    queued = 0;
  const status = (text) => ($("nativeStatus").textContent = text);
  const attachments = operatorAttachments($, fetchAttachment);
  function reset() {
    resetTerminal();
    attachments.clear();
  }
  function resetTerminal() {
    epoch++;
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
    status("Starting isolated Pi…");
    try {
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
      terminal.onData((data) => {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536)
          ws.send(JSON.stringify({ type: "input", data }));
      });
      ws.onopen = () => ws.send(JSON.stringify({ ticket: ticket.ticket }));
      ws.onmessage = (event) => {
        if (generation !== epoch) return;
        const message = JSON.parse(event.data);
        if (message.type === "output") {
          queued += message.data.length;
          if (queued > 256 * 1024) {
            ws.close();
            status(
              "Terminal output overflow. Reconnect; input is never replayed.",
            );
            return;
          }
          terminal.write(message.data, () => {
            queued -= message.data.length;
          });
        } else if (message.type === "ready") {
          status("Connected · ephemeral workspace · /model · /mcp");
          pending = false;
          $("nativeStart").disabled = false;
          resize();
          terminal.focus();
        } else if (message.type === "attachments")
          attachments.snapshot(message.session, message.items);
        else if (message.type === "attachment")
          attachments.add(message.session, message.item);
        else if (message.type === "attachments-cleared") attachments.clear();
        else if (message.type === "error") status(message.message);
      };
      ws.onclose = (event) => {
        // Policy close means the session ended; its attachments are gone.
        if (event.code === 1008) attachments.clear();
        if (generation === epoch) {
          pending = false;
          $("nativeStart").disabled = false;
          status(
            "Disconnected. Reconnect within 30 seconds or workspace is erased. No input is replayed.",
          );
        }
      };
      ws.onerror = () => {
        if (generation === epoch) status("Native terminal connection failed.");
      };
    } catch {
      if (generation === epoch) {
        pending = false;
        $("nativeStart").disabled = false;
        status(
          "Native Pi unavailable. Docker and the pinned sandbox image are required.",
        );
      }
    }
  };
  $("nativeStop").onclick = async () => {
    reset();
    status("Stopping…");
    try {
      await api("terminal/stop", {});
      status(
        "Stopped · ephemeral workspace erased. Committed backend actions are not undone.",
      );
    } catch {
      status("Stop unconfirmed. Do not retry a possibly committed action.");
    }
  };
  window.addEventListener("pagehide", () => {
    reset();
    observer.disconnect();
  });
  return { reset };
}

// Attachments Pi sent with send_to_operator. Metadata arrives on the terminal
// socket; bytes are fetched privately with the admin key and shown only via
// blob URLs. Nothing is rendered as HTML.
function operatorAttachments($, fetchAttachment) {
  const MAX_BYTES = 8 * 1024 * 1024,
    MAX_ITEMS = 16,
    IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  let session = "",
    controller = new AbortController(),
    dialogEntry;
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
  function render() {
    $("nativeAttachmentsEmpty").hidden = items.size > 0;
    $("nativeAttachmentCount").textContent = items.size
      ? "(" + items.size + ")"
      : "";
  }
  function clear() {
    controller.abort();
    controller = new AbortController();
    session = "";
    closeDialog();
    for (const entry of items.values())
      if (entry.url) URL.revokeObjectURL(entry.url);
    items.clear();
    list.replaceChildren();
    render();
  }
  function snapshot(id, snapshotItems) {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) return clear();
    if (id !== session) {
      clear();
      session = id;
    }
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
  function remove(key, entry) {
    if (dialogEntry === entry) closeDialog();
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.node.remove();
    items.delete(key);
  }
  function add(id, item) {
    if (id !== session || !valid(item) || items.has(item.id)) return;
    if (items.size >= MAX_ITEMS) return;
    const entry = { item, url: "", loading: undefined, gone: false };
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
    if (image)
      void load(entry).then(
        (url) => {
          if (!url || items.get(item.id) !== entry) return;
          preview.querySelector("img").src = url;
          preview.disabled = false;
          entry.enlarge.disabled = false;
        },
        () => {},
      );
  }
  // One private fetch per attachment; retried only while Pi is busy (503).
  function load(entry) {
    if (entry.url) return Promise.resolve(entry.url);
    if (entry.loading) return entry.loading;
    const signal = controller.signal,
      scope = session;
    entry.state.textContent = "Loading…";
    entry.loading = (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await fetchAttachment(
          "/api/terminal/attachments/" + scope + "/" + entry.item.id,
          signal,
        );
        if (signal.aborted || scope !== session) {
          await response.body?.cancel();
          return "";
        }
        if (response.status === 503) {
          await response.body?.cancel();
          entry.state.textContent = "Waiting for Pi to finish its request…";
          await new Promise((resolve) =>
            setTimeout(resolve, 2000 * (attempt + 1)),
          );
          if (signal.aborted) return "";
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            response.status === 404 || response.status === 410
              ? "No longer available. Its session ended."
              : "Unavailable right now. Try again.",
          );
        }
        const declared = Number(response.headers.get("content-length"));
        if (declared > MAX_BYTES) {
          await response.body?.cancel();
          throw new Error("Rejected: larger than announced.");
        }
        const blob = await response.blob();
        if (signal.aborted || scope !== session) return "";
        if (blob.size !== entry.item.byte_count)
          throw new Error("Rejected: size did not match.");
        const type =
          entry.item.preview === "image"
            ? entry.item.mime_type
            : "application/octet-stream";
        entry.url = URL.createObjectURL(new Blob([blob], { type }));
        entry.state.textContent = "";
        return entry.url;
      }
      throw new Error("Pi is still busy. Try again shortly.");
    })().catch((error) => {
      if (!signal.aborted)
        entry.state.textContent =
          error instanceof TypeError
            ? "Unavailable right now. Try again."
            : error.message;
      throw error;
    });
    entry.loading.finally(() => {
      if (!entry.url) entry.loading = undefined;
    });
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
  render();
  return { snapshot, add, clear };
}
