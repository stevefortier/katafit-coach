function nativeTerminal({ api, authorized }) {
  const $ = (id) => document.getElementById(id);
  let terminal,
    fit,
    socket,
    epoch = 0,
    pending = false,
    queued = 0;
  const status = (text) => ($("nativeStatus").textContent = text);
  function reset() {
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
    reset();
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
        } else if (message.type === "error") status(message.message);
      };
      ws.onclose = () => {
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
