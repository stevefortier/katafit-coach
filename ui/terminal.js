function nativeTerminal({ api, authorized }) {
  const $ = (id) => document.getElementById(id);
  let terminal,
    fit,
    socket,
    epoch = 0,
    pending = false,
    queued = 0;
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
    epoch++;
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
    reset();
    pending = true;
    $("nativeStart").disabled = true;
    const generation = epoch;
    status("starting", "Starting isolated Pi…");
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
      let failed = false;
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
        } else if (message.type === "error") {
          failed = true;
          status("error", message.message);
        }
      };
      ws.onclose = () => {
        if (generation === epoch) {
          pending = false;
          $("nativeStart").disabled = false;
          if (!failed)
            status(
              "disconnected",
              "Disconnected. Reconnect within 30 seconds or workspace is erased. No input is replayed.",
            );
        }
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
  window.addEventListener("pagehide", () => {
    reset();
    observer.disconnect();
  });
  return { reset };
}
