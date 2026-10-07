/* Standalone Coach Dashboard; all values arrive from an authorized snapshot. */
window.CoachDashboard = (() => {
  const $ = (id) => document.getElementById(id);
  // Presentation-only switches: retain the dashboard's authorized scope and DOM.
  const subtabs = [
    ...($("dashboardSubtabs")?.querySelectorAll('[role="tab"]') || []),
  ];
  let stats = null;
  // Scope the viewport lock to the visible map pane, never Gallery/Settings.
  const mapPane = $("dashboardMapPane");
  if (mapPane) {
    let frame;
    const layout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = mapPane.getClientRects().length > 0;
        const root = document.documentElement;
        const changed = active !== root.classList.contains("compact-map");
        root.classList.toggle("compact-map", active);
        if (changed && active) {
          window.scrollTo(0, 0);
          $("workspaceScroll")?.scrollTo(0, 0);
        }
        const height = (selector) =>
          document.querySelector(selector)?.getBoundingClientRect().height || 0;
        root.style.setProperty("--header-offset", height("header") + "px");
        root.style.setProperty(
          "--primary-tabs-height",
          height(".studio-tabs") + "px",
        );
        root.style.setProperty(
          "--roster-height",
          height("#dashboardMemberCards") + "px",
        );
        if (active)
          mapPane.style.height =
            Math.max(0, innerHeight - mapPane.getBoundingClientRect().top - 8) +
            "px";
      });
    };
    const observer = new ResizeObserver(layout);
    for (const node of [
      document.querySelector("header"),
      document.querySelector(".studio-tabs"),
      $("dashboardMemberCards"),
      $("dashboardSubtabs"),
    ])
      if (node) observer.observe(node);
    new MutationObserver(layout).observe($("workspaceScroll"), {
      attributes: true,
      attributeFilter: ["hidden"],
      subtree: true,
    });
    addEventListener("resize", layout);
    layout();
    const inspector = $("dashboardMapSelection"),
      close = $("dashboardInspectorClose");
    const dismiss = () => {
      selectionEpoch++;
      inspector.replaceChildren();
      close.hidden = true;
      $("dashboardMap")
        ?.querySelector('[aria-pressed="true"]')
        ?.focus({ preventScroll: true });
    };
    if (close) {
      close.onclick = dismiss;
      close.onkeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
        }
      };
      inspector.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
        }
      });
      new MutationObserver(() => {
        close.hidden = !inspector.childNodes.length;
      }).observe(inspector, { childList: true });
    }
  }
  function selectPane(tab, focus = false) {
    for (const item of subtabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      item.classList.toggle("secondary", !selected);
      $(item.getAttribute("aria-controls")).hidden = !selected;
    }
    closeMemberTooltip();
    if (tab.id === "dashboard-stats-tab") stats?.select();
    if (focus) tab.focus();
  }
  for (const tab of subtabs) {
    tab.addEventListener("click", () => selectPane(tab));
    tab.addEventListener("keydown", (event) => {
      const index = subtabs.indexOf(tab);
      const next = {
        ArrowRight: (index + 1) % subtabs.length,
        ArrowLeft: (index + subtabs.length - 1) % subtabs.length,
        Home: 0,
        End: subtabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      selectPane(subtabs[next], true);
    });
  }
  const svgNS = "http://www.w3.org/2000/svg";
  const isPhoto = (f) =>
    f &&
    (f._id || f.id) &&
    (f.type === "image" || /^image\/(jpeg|png|webp)$/.test(f.type));
  let epoch = 0;
  let controller;
  let mapController;
  let mapEpoch = 0;
  let leafletMap;
  let mapResizeObserver;
  const avatarUrls = [];
  const avatarCache = new Map();
  const urls = [];
  // Share admission across map, timeline, feed, detail and image reads, including
  // old loads. Leave one of the BFF's four slots available for cleanup/other UI.
  const readQueue = [];
  let activeReads = 0;
  let activeAvatarReads = 0;
  function dashboardFetch(input, options, queuedSignal = options.signal) {
    return new Promise((resolve, reject) => {
      const avatar = input.startsWith("/api/dashboard/avatar?");
      const job = { start, cancel, avatar };
      let started = false;
      function cancel() {
        if (!started) {
          const index = readQueue.indexOf(job);
          if (index !== -1) readQueue.splice(index, 1);
        }
        reject(
          queuedSignal.reason || new DOMException("Aborted", "AbortError"),
        );
      }
      async function start() {
        started = true;
        activeReads++;
        if (avatar) activeAvatarReads++;
        // Selection detail has only a queued signal: once dispatched, retain its
        // existing late-denial handling. Other callers reject promptly on abort.
        if (!options.signal || queuedSignal !== options.signal)
          queuedSignal?.removeEventListener("abort", cancel);
        try {
          // A client abort is not an acknowledgment of server-side cleanup.
          // Drain an admitted read (bounded by the BFF REST deadline) before
          // reusing its slot; never dispatch canceled queued date work.
          const response = await fetch(input, {
            ...options,
            signal: undefined,
          });
          // The BFF buffers upstream reads and releases memberReads before its
          // response arrives. Preserve the original Response/body for live
          // callers; consume canceled results so no unused transport remains.
          if (options.signal?.aborted) await response.arrayBuffer();
          options.signal?.throwIfAborted();
          resolve(response);
        } catch (error) {
          reject(error);
        } finally {
          queuedSignal?.removeEventListener("abort", cancel);
          activeReads--;
          if (avatar) activeAvatarReads--;
          admitReads();
        }
      }
      if (queuedSignal?.aborted) return cancel();
      queuedSignal?.addEventListener("abort", cancel, { once: true });
      readQueue.push(job);
      admitReads();
    });
  }
  function admitReads() {
    while (activeReads < 3 && readQueue.length) {
      // Old-date avatars still own slots while draining. Never let a new-date
      // avatar take the third lane needed by primary/feed/photo/detail reads.
      const index = readQueue.findIndex(
        (job) => !job.avatar || activeAvatarReads < 2,
      );
      if (index === -1) return;
      readQueue.splice(index, 1)[0].start();
    }
  }
  // Authorized roster/avatars belong to the dashboard scope, not the event day.
  // Explicit reload/lock/account changes clear them; confirmed denials remove members.
  let rosterCache = null;
  let rosterReady = Promise.resolve({ note: "" });
  // A confirmed same-load denial cannot be undone by a concurrent roster/map
  // snapshot. A fresh dashboard load is required to recheck this member.
  const suppressedMembers = new Set();
  let selectedMember = null;
  let closeMemberTooltip = () => {};
  let mapMembers = new Map();
  let feedMembers = new Map();
  let filterFeed = () => {};
  let clearGallery = () => {};
  let filterGallery = () => {};
  let filterMap = () => {};
  let selectionEpoch = 0;
  let timelineEpoch = 0;
  let timelinePending = false;
  // HTTP status of the last failed shared day-events read, if any.
  let ledgerFailure = null;
  let timelineInteraction = () => {};
  let timelineController;
  let filterTimeline = () => {};
  let reconcileTimelineSelection = () => {};
  let timelineResize = null;
  // Canonical day ledger shared by map and timeline: {date,start,end,items,users,complete}.
  let ledger = null;
  let ledgerGeneration = 0;
  // Members whose current Position audience a fresh exact read withheld in
  // this ledger generation; only a new page-one load can restore their GPS.
  const withheldMembers = new Set();
  let selectedEventId = null;
  let previewEventId = null;
  let syncMap = () => {};
  let refreshMap = () => {};
  let revealEvent = () => {};
  let forgetMember = () => {};
  // Only a true 401/403 means access was denied; 429, 5xx and network
  // failures are transient and must never be treated as revoked sharing.
  const httpError = (message, status) =>
    Object.assign(new Error(message), { status });
  const denied = (error) => error?.status === 401 || error?.status === 403;
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  let clearDateNavigation = () => {};
  // Local civil dates: never parse YYYY-MM-DD as UTC or add 24-hour durations.
  function civilDate(year, month, day) {
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(12, 0, 0, 0);
    return date;
  }
  function dateValue(date) {
    return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function bindDateNavigation(adminKey) {
    const input = $("dashboardMapDate"),
      button = $("dashboardCalendarButton"),
      calendar = $("dashboardCalendar");
    const previous = $("dashboardMapPrevious"),
      next = $("dashboardMapNext"),
      today = $("dashboardMapToday");
    const loadId = epoch;
    let committedDate = input.value,
      displayedMonth = input.value.slice(0, 7);
    const live = () => loadId === epoch;
    const localToday = () => dateValue(new Date());
    const close = () => {
      if (calendar?.matches(":popover-open")) calendar.hidePopover();
      button?.setAttribute("aria-expanded", "false");
    };
    function sync() {
      input.max = localToday();
      if (next) next.disabled = input.value >= input.max;
      if (button) {
        const [y, m, d] = input.value.split("-").map(Number);
        button.textContent = civilDate(y, m, d).toLocaleDateString(undefined, {
          weekday: "long",
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      }
    }
    function commit(value, force = false) {
      if (!live()) return;
      // Native entry, calendar, arrows and Today all share this admission fence.
      if (!validDay(value) || value > localToday()) {
        input.value = committedDate;
        sync();
        return;
      }
      input.value = value;
      sync();
      if (!force && value === committedDate) return;
      committedDate = value;
      void loadMap(adminKey);
    }
    function stepDay(amount) {
      const [y, m, d] = input.value.split("-").map(Number);
      const date = civilDate(y, m, d);
      date.setDate(date.getDate() + amount);
      if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
      commit(dateValue(date));
    }
    function renderCalendar(focusDate = input.value) {
      if (!calendar || !live()) return;
      const [y, m] = displayedMonth.split("-").map(Number);
      const first = civilDate(y, m, 1),
        length = civilDate(y, m + 1, 0).getDate();
      $("dashboardCalendarMonth").textContent = first.toLocaleDateString(
        undefined,
        { month: "long", year: "numeric" },
      );
      $("dashboardCalendarNext").disabled =
        displayedMonth >= localToday().slice(0, 7);
      $("dashboardCalendarPrevious").disabled = y === 1 && m === 1;
      const days = $("dashboardCalendarDays");
      days.replaceChildren();
      for (const name of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
        days.append(text("span", name));
      for (let i = 0; i < first.getDay(); i++) days.append(text("span", ""));
      for (let d = 1; d <= length; d++) {
        const date = civilDate(y, m, d),
          value = dateValue(date),
          day = text("button", String(d));
        day.type = "button";
        day.dataset.calendarDate = value;
        day.disabled = value > localToday();
        day.setAttribute(
          "aria-label",
          date.toLocaleDateString(undefined, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
        );
        day.setAttribute("aria-pressed", String(value === input.value));
        if (value === localToday()) day.setAttribute("aria-current", "date");
        day.onclick = () => {
          commit(value);
          close();
          button.focus({ preventScroll: true });
        };
        day.onkeydown = (event) => {
          const amount = {
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -7,
            ArrowDown: 7,
            Home: -date.getDay(),
            End: 6 - date.getDay(),
          }[event.key];
          if (amount === undefined) return;
          event.preventDefault();
          const target = civilDate(y, m, d + amount),
            targetValue = dateValue(target);
          if (targetValue > localToday() || target.getFullYear() < 1) return;
          displayedMonth = targetValue.slice(0, 7);
          renderCalendar(targetValue);
          days.querySelector(`[data-calendar-date="${targetValue}"]`)?.focus();
        };
        days.append(day);
      }
      if (calendar.matches(":popover-open")) {
        const anchor = button.getBoundingClientRect();
        calendar.style.left =
          Math.max(
            4,
            Math.min(anchor.left, innerWidth - calendar.offsetWidth - 4),
          ) + "px";
        calendar.style.top =
          Math.max(
            4,
            Math.min(
              anchor.bottom + 4,
              innerHeight - calendar.offsetHeight - 4,
            ),
          ) + "px";
      }
      if (focusDate)
        days
          .querySelector(`[data-calendar-date="${focusDate}"]`)
          ?.focus({ preventScroll: true });
    }
    function moveMonth(amount) {
      const [y, m] = displayedMonth.split("-").map(Number);
      const date = civilDate(y, m + amount, 1),
        value = dateValue(date);
      if (
        date.getFullYear() < 1 ||
        date.getFullYear() > 9999 ||
        value.slice(0, 7) > localToday().slice(0, 7)
      )
        return;
      displayedMonth = value.slice(0, 7);
      renderCalendar(null);
    }
    if (button)
      button.onclick = () => {
        if (!live()) return;
        if (calendar.matches(":popover-open")) {
          close();
          return;
        }
        displayedMonth = input.value.slice(0, 7);
        calendar.showPopover();
        button.setAttribute("aria-expanded", "true");
        renderCalendar();
      };
    if (calendar) {
      calendar.ontoggle = () =>
        button.setAttribute(
          "aria-expanded",
          String(calendar.matches(":popover-open")),
        );
      calendar.onkeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          button.focus({ preventScroll: true });
        }
      };
      $("dashboardCalendarPrevious").onclick = () => moveMonth(-1);
      $("dashboardCalendarNext").onclick = () => moveMonth(1);
    }
    if (previous) previous.onclick = () => stepDay(-1);
    if (next) next.onclick = () => stepDay(1);
    if (today)
      today.onclick = () => {
        commit(localToday());
        close();
        button?.focus({ preventScroll: true });
      };
    input.onchange = () => commit(input.value, true);
    clearDateNavigation = () => {
      close();
      input.onchange = null;
      for (const control of [
        previous,
        next,
        today,
        button,
        $("dashboardCalendarPrevious"),
        $("dashboardCalendarNext"),
      ])
        if (control) control.onclick = null;
      if (calendar) {
        calendar.onkeydown = null;
        calendar.ontoggle = null;
        $("dashboardCalendarDays").replaceChildren();
      }
    };
    sync();
  }

  function clear() {
    stats?.clear();
    stats = null;
    clearGallery();
    clearGallery = () => {};
    filterGallery = () => {};
    window.CoachImageViewer?.close("gallery");
    closeMemberTooltip();
    clearDateNavigation();
    clearDateNavigation = () => {};
    if ($("dashboardMapDate")) $("dashboardMapDate").onchange = null;
    epoch++;
    controller?.abort();
    controller = undefined;
    mapEpoch++;
    mapController?.abort();
    mapController = undefined;
    timelineEpoch++;
    timelinePending = false;
    timelineInteraction(false);
    timelineInteraction = () => {};
    timelineController?.abort();
    timelineResize?.disconnect();
    timelineResize = null;
    if ($("dashboardTimeline")) $("dashboardTimeline").onkeydown = null;
    selectionEpoch++;
    $("dashboardTimeline")?.replaceChildren();
    filterTimeline = () => {};
    disposeMap();
    $("dashboardMap")?.replaceChildren();
    $("dashboardMapSelection")?.replaceChildren();
    $("dashboardMemberCards")?.replaceChildren();
    selectedMember = null;
    mapMembers = new Map();
    feedMembers = new Map();
    rosterCache = null;
    rosterReady = Promise.resolve({ note: "" });
    avatarCache.clear();
    for (const url of avatarUrls.splice(0)) URL.revokeObjectURL(url);
    suppressedMembers.clear();
    filterFeed = () => {};
    filterMap = () => {};
    forgetMember = () => {};
    if ($("dashboardMapStatus")) $("dashboardMapStatus").textContent = "";
    $("dashboardMapStatus")?.removeAttribute("data-tone");
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    $("dashboardCharts").replaceChildren();
    $("dashboardCoverage").replaceChildren();
    $("dashboardCoverage").hidden = true;
    $("dashboardStatus").textContent = "Open Dojo to load shared data.";
    $("dashboardStatus").removeAttribute("data-tone");
  }
  function disposeMap() {
    mapResizeObserver?.disconnect();
    mapResizeObserver = undefined;
    leafletMap?.remove();
    leafletMap = undefined;
  }
  function renderMemberCards() {
    closeMemberTooltip();
    const target = $("dashboardMemberCards");
    if (!target) return;
    const heading = $("dashboardMemberHeading");
    if (heading)
      heading.textContent = mapMembers.size
        ? "Dojo members"
        : "Members in loaded shared data";
    const rosterScrollLeft =
      target.querySelector(".dashboard-member-rail")?.scrollLeft || 0;
    target.replaceChildren();
    const rail = text("div", "", "dashboard-member-rail");
    const members = new Map(
      [...feedMembers, ...mapMembers].filter(
        ([id]) => !suppressedMembers.has(id),
      ),
    );
    const stat = (value, unit, max) => {
      if (
        unit === "" &&
        typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0 &&
        value <= max
      )
        return `${value}`;
      if (
        unit !== "" &&
        unit !== "weight" &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value > 0 &&
        value <= max
      )
        return `${unit === "%" ? Number(value.toFixed(1)) : value} ${unit}`;
      if (
        unit === "weight" &&
        value &&
        typeof value === "object" &&
        typeof value.value === "number" &&
        Number.isFinite(value.value) &&
        value.value > 0 &&
        value.value <= max &&
        ["kg", "lb", "lbs"].includes(value.unit)
      )
        return `${value.value} ${value.unit}`;
      return "Unavailable";
    };
    const makeCard = (id, user, all = false) => {
      const button = text(
        "button",
        "",
        all ? "dashboard-member-all" : "dashboard-member-card",
      );
      button.type = "button";
      button.setAttribute("aria-pressed", String(selectedMember === id));
      const entry = all ? null : text("div", "", "dashboard-member-entry");
      entry?.append(button);
      const name = all ? "Select\nAll" : user.display_name || "Member";
      const nameNode = text("strong", name);
      nameNode.title = name;
      button.append(nameNode);
      if (!all) {
        const portrait = text("span", "", "dashboard-member-portrait");
        portrait.dataset.memberId = id;
        portrait.textContent = (name.match(/[\p{L}\p{N}]+/gu) || ["M"])
          .slice(-2)
          .map((s) => s[0].toUpperCase())
          .join("");
        const avatar = avatarCache.get(id);
        if (avatar) {
          const image = text("img", "", "dashboard-roster-image");
          image.alt = "";
          image.src = avatar;
          image.onerror = () => image.remove();
          portrait.prepend(image);
        }
        button.prepend(portrait);
        const stats = mapMembers.has(id) ? user.stats : undefined;
        for (const [label, value] of [
          ["Weight", stat(stats?.weight, "weight", 2000)],
          ["Height", stat(stats?.height_cm, "cm", 300)],
          [
            "Body fat",
            stat(
              stats?.body_fat_estimate?.source === "ai" &&
                stats?.body_fat_estimate?.estimated === true &&
                stats?.body_fat_estimate?.value === stats?.body_fat_percent
                ? stats.body_fat_percent
                : null,
              "%",
              100,
            ),
          ],
          ["Age", stat(stats?.age_years, "", 130)],
        ]) {
          const row = text("span", `${label}: ${value}`);
          row.title = row.textContent;
          button.append(row);
          if (label !== "Body fat" || value === "Unavailable") continue;
          row.className = "dashboard-member-bodyfat";
          // A sibling native button keeps the member's selection button valid
          // and prevents pointer/keyboard provenance reads from selecting it.
          const info = text("button", "ⓘ", "dashboard-member-info");
          info.type = "button";
          info.setAttribute(
            "aria-label",
            `About body fat estimate for ${name}`,
          );
          const tooltip = text(
            "div",
            "Body fat is estimated from progress photos.",
            "dashboard-member-tooltip",
          );
          tooltip.id = `dashboard-bodyfat-${id}`;
          tooltip.setAttribute("role", "tooltip");
          tooltip.setAttribute("popover", "auto");
          info.setAttribute("aria-describedby", tooltip.id);
          let pinned = false;
          let hideTimer;
          let floatingEvents;
          let focusFrame;
          const cancelHide = () => clearTimeout(hideTimer);
          const hide = () => {
            cancelHide();
            cancelAnimationFrame(focusFrame);
            pinned = false;
            floatingEvents?.abort();
            floatingEvents = null;
            if (tooltip.matches(":popover-open")) tooltip.hidePopover();
            if (closeMemberTooltip === hide) closeMemberTooltip = () => {};
          };
          const show = () => {
            cancelHide();
            if (!tooltip.matches(":popover-open")) {
              closeMemberTooltip();
              closeMemberTooltip = hide;
              tooltip.showPopover();
              floatingEvents = new AbortController();
              const options = { signal: floatingEvents.signal, capture: true };
              document.addEventListener("scroll", hide, options);
              window.addEventListener("resize", hide, options);
            }
            const anchor = info.getBoundingClientRect();
            const bounds = tooltip.getBoundingClientRect();
            tooltip.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8))}px`;
            tooltip.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, innerHeight - bounds.height - 8))}px`;
          };
          info.addEventListener("pointerenter", (event) => {
            if (event.pointerType === "mouse") show();
          });
          const leave = () => {
            if (!pinned && document.activeElement !== info)
              hideTimer = setTimeout(hide, 160);
          };
          info.addEventListener("pointerleave", leave);
          tooltip.addEventListener("pointerenter", cancelHide);
          tooltip.addEventListener("pointerleave", leave);
          info.addEventListener("focus", () => {
            if (!info.matches(":focus-visible")) return;
            // Native Tab may scroll the horizontal rail after focus dispatch.
            // Open after that scroll, rather than instantly dismissing a fresh
            // keyboard preview via the floating tooltip's scroll listener.
            focusFrame = requestAnimationFrame(() => {
              focusFrame = requestAnimationFrame(() => {
                if (
                  info.isConnected &&
                  document.activeElement === info &&
                  info.matches(":focus-visible")
                )
                  show();
              });
            });
          });
          info.addEventListener("blur", hide);
          info.addEventListener("click", () => {
            if (pinned) hide();
            else {
              show();
              pinned = true;
            }
          });
          info.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              hide();
            }
          });
          tooltip.addEventListener("toggle", () => {
            // Explicit hide already cleaned up. Its delayed closing event must
            // not cancel a newer keyboard focus's pending reveal.
            if (!tooltip.matches(":popover-open") && floatingEvents) hide();
          });
          entry.append(info, tooltip);
        }
      }
      button.addEventListener("click", () => {
        selectedMember = id;
        selectionEpoch++;
        $("dashboardMapSelection")?.replaceChildren();
        highlightEvent(null);
        renderMemberCards();
        filterMap();
        filterFeed();
        filterTimeline();
      });
      rail.append(entry || button);
    };
    makeCard(null, {}, true);
    target.append(rail);
    for (const [id, user] of members) makeCard(id, user);
    // Keep the selected offscreen member in view across selection/cache renders;
    // the browser clamps naturally if an authorization denial shrinks the rail.
    rail.scrollLeft = rosterScrollLeft;
    stats?.select();
  }
  function svg(tag, attributes) {
    const node = document.createElementNS(svgNS, tag);
    for (const [name, value] of Object.entries(attributes))
      node.setAttribute(name, String(value));
    return node;
  }
  function chart(series) {
    const card = text("article", "", "dashboard-chart");
    card.append(
      text("h4", `${series.member_name} — ${series.label} (${series.unit})`),
    );
    const points =
      series.label === "Body fat (photo estimate)"
        ? series.points.map((p) => ({
            ...p,
            value: Number(p.value.toFixed(1)),
          }))
        : series.points;
    if (!points.length) {
      card.append(text("p", "No shared data in this period.", "hint"));
      return card;
    }
    const range = points.map((p) => p.value);
    const min = Math.min(...range),
      max = Math.max(...range);
    const span = max - min || 1;
    const graph = svg("svg", {
      viewBox: "0 0 600 210",
      role: "img",
      "aria-label": `${series.member_name}, ${series.label} in ${series.unit}: ${points.map((p) => `${p.date} ${p.value}`).join("; ")}`,
    });
    const axis = (value, attributes) => {
      const label = svg("text", {
        fill: "#c9c9c9",
        "font-size": 11,
        ...attributes,
      });
      label.textContent = String(value);
      return label;
    };
    graph.append(
      svg("line", { x1: 55, y1: 140, x2: 575, y2: 140, stroke: "#777" }),
      svg("line", { x1: 55, y1: 25, x2: 55, y2: 140, stroke: "#777" }),
      axis(`${max} ${series.unit}`, { x: 52, y: 26, "text-anchor": "end" }),
      axis(`${min} ${series.unit}`, { x: 52, y: 140, "text-anchor": "end" }),
      axis(series.unit === "workouts" ? "Workouts" : series.label, {
        x: 55,
        y: 14,
      }),
      axis(points[0].date, { x: 55, y: 158 }),
      axis(points[points.length - 1].date, {
        x: 575,
        y: 158,
        "text-anchor": "end",
      }),
      axis("Date (UTC)", { x: 315, y: 184, "text-anchor": "middle" }),
    );
    const days = points.map((p) => Date.parse(`${p.date}T00:00:00Z`));
    const elapsed = days[days.length - 1] - days[0];
    const coords = points.map((p, i) => [
      55 + (elapsed > 0 ? ((days[i] - days[0]) * 520) / elapsed : 260),
      130 - ((p.value - min) / span) * 95,
    ]);
    if (points.length > 1)
      graph.append(
        svg("polyline", {
          points: coords.map((p) => p.join(",")).join(" "),
          fill: "none",
          stroke: "#ddd",
          "stroke-width": 2,
        }),
      );
    const tooltip = text("div", "", "dashboard-tooltip");
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    const show = (dot, point) => {
      tooltip.textContent = `${series.member_name} · ${point.date} · ${point.value} ${series.unit}`;
      tooltip.hidden = false;
      const rect = card.getBoundingClientRect();
      const target = dot.getBoundingClientRect();
      tooltip.style.left = `${card.scrollLeft + Math.max(0, Math.min(target.left - rect.left, card.clientWidth - tooltip.offsetWidth))}px`;
      tooltip.style.top = `${Math.max(0, target.top - rect.top - tooltip.offsetHeight - 8)}px`;
    };
    coords.forEach(([x, y], i) => {
      const dot = svg("circle", {
        cx: x,
        cy: y,
        r: 5,
        fill: "#fff",
        tabindex: 0,
        "aria-label": `${series.member_name}: ${points[i].date}, ${points[i].value} ${series.unit}`,
      });
      dot.addEventListener("mouseenter", () => show(dot, points[i]));
      dot.addEventListener("focus", () => show(dot, points[i]));
      dot.addEventListener("mouseleave", () => {
        if (document.activeElement !== dot) tooltip.hidden = true;
      });
      dot.addEventListener("blur", () => {
        tooltip.hidden = true;
      });
      graph.append(dot);
    });
    const valueLabel = (p) => `${p.date} · ${p.value} ${series.unit}`;
    card.append(
      graph,
      tooltip,
      text(
        "p",
        `Range: ${min}–${max} ${series.unit} · ${points.length} recorded periods`,
        "hint",
      ),
    );
    const values = text("ul", "", "dashboard-values");
    for (const point of points.slice(-4).reverse())
      values.append(text("li", valueLabel(point)));
    card.append(values);
    if (points.length > 4) {
      const older = document.createElement("details");
      older.append(text("summary", `Show ${points.length - 4} earlier points`));
      const list = text("ul", "", "dashboard-values");
      for (const point of points.slice(0, -4).reverse())
        list.append(text("li", valueLabel(point)));
      older.append(list);
      card.append(older);
    }
    return card;
  }
  function validDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const instant = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(instant) &&
      new Date(instant).toISOString().slice(0, 10) === value
    );
  }
  function position(value) {
    const latitude = value?.latitude,
      longitude = value?.longitude;
    return (
      typeof latitude === "number" &&
      Number.isFinite(latitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      typeof longitude === "number" &&
      Number.isFinite(longitude) &&
      longitude >= -180 &&
      longitude <= 180
    );
  }
  const safeActivityData = (value, depth = 0) => {
    if (depth >= 6) return "[nested detail omitted]";
    if (typeof value === "string") return value.slice(0, 500);
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    )
      return value;
    if (Array.isArray(value))
      return value
        .slice(0, 50)
        .map((item) => safeActivityData(item, depth + 1));
    if (!value || typeof value !== "object") return undefined;
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/secret|token|password|credential|authorization|api[_-]?key|email/i.test(
              key,
            ),
        )
        .slice(0, 40)
        .map(([key, item]) => [key, safeActivityData(item, depth + 1)]),
    );
  };
  // Current subject state is optional enrichment for a historical ledger event.
  // It never supplies, moves or reauthorizes the event's recorded time or location.
  function subjectDetail(detail) {
    const rows = [
      text("h4", "Current subject activity"),
      text("p", detail.name || detail.type || "Activity"),
      text(
        "p",
        [detail.type, detail.status, detail.created_at]
          .filter(Boolean)
          .join(" · "),
        "hint",
      ),
    ];
    if (
      detail.type === "workout" &&
      Number.isFinite(detail.workout_progress?.completed_sets)
    )
      rows.push(
        text("p", `Completed sets: ${detail.workout_progress.completed_sets}`),
      );
    if (detail.type === "meal") {
      for (const [field, unit] of [
        ["calories", "kcal"],
        ["protein", "g"],
      ])
        if (Number.isFinite(detail.nutrition_summary?.[field]))
          rows.push(
            text("p", `${field}: ${detail.nutrition_summary[field]} ${unit}`),
          );
    }
    if (detail.type === "metric") {
      for (const point of (Array.isArray(detail.data?.measurements)
        ? detail.data.measurements
        : []
      ).slice(0, 8))
        if (
          typeof point?.type_id === "string" &&
          Number.isFinite(point.value) &&
          typeof point.unit === "string"
        )
          rows.push(
            text("p", `${point.type_id}: ${point.value} ${point.unit}`),
          );
    }
    const data = safeActivityData(detail.data || {});
    const rendered = JSON.stringify(data, null, 2);
    if (rendered && rendered !== "{}") {
      const more = text("details");
      more.append(
        text("summary", "Activity data"),
        text(
          "pre",
          rendered.slice(0, 32000) +
            (rendered.length > 32000 ? "\n[detail truncated]" : ""),
        ),
      );
      rows.push(more);
    }
    rows.push(
      text(
        "p",
        "Current subject state is separate from this event; the event's recorded time and location remain authoritative.",
        "hint",
      ),
    );
    return rows;
  }
  // Only an event's own validated, currently shared ledger fix is a location.
  function eventPosition(item) {
    const fix = item?.position;
    return fix?.availability === "available" &&
      position(fix) &&
      !withheldMembers.has(item.user_id)
      ? fix
      : null;
  }
  function eventLocation(item) {
    const fix = eventPosition(item);
    const line = text(
      "p",
      fix
        ? `Event location: ${fix.latitude}, ${fix.longitude}${Number.isFinite(fix.accuracy) ? ` (±${fix.accuracy} m)` : ""} · recorded with this event, not live tracking.`
        : item?.position?.reason === "private" ||
            withheldMembers.has(item?.user_id)
          ? "No shared location for this event."
          : "No available location for this event.",
      "hint",
    );
    line.dataset.eventLocation = "";
    return line;
  }
  // A private Position DTO is member-scoped authority: every loaded fix for
  // that member leaves the map, while the permitted timeline rows remain.
  function withholdMember(memberId) {
    withheldMembers.add(memberId);
    syncMap();
    const shown = ledger?.items.get(selectedEventId);
    if (shown?.user_id === memberId)
      $("dashboardMapSelection")
        .querySelector("[data-event-location]")
        ?.replaceWith(eventLocation(shown));
  }
  const memberName = (memberId) =>
    ledger?.users.get(memberId)?.display_name || "Member";
  function highlightEvent(eventId) {
    selectedEventId = eventId;
    for (const node of document.querySelectorAll(
      ".dashboard-timeline-mark, .dashboard-event-dot, .dashboard-map-choice",
    ))
      node.setAttribute(
        "aria-pressed",
        String(!!eventId && node.dataset.eventId === eventId),
      );
    refreshMap();
  }
  // Scroll the selected individual occurrence into view.
  function revealTimelineEvent(eventId) {
    const mark = [
      ...document.querySelectorAll(".dashboard-timeline-mark"),
    ].find((node) => node.dataset.eventId === eventId);
    mark?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  // A confirmed 401/403 removes everything loaded for that member at once.
  function denyMember(memberId) {
    suppressedMembers.add(memberId);
    mapMembers.delete(memberId);
    rosterCache?.delete(memberId);
    const url = avatarCache.get(memberId);
    if (url) {
      URL.revokeObjectURL(url);
      avatarCache.delete(memberId);
    }
    forgetMember(memberId);
    filterTimeline();
    syncMap();
    renderMemberCards();
  }
  // One shared selected ledger event for map and timeline. Selection freshly
  // reauthorizes that exact event; subject detail is optional enrichment.
  // The timeline stays selectable without the map: absent a ledger, the day
  // window comes from the selected local date.
  async function selectEvent(
    item,
    adminKey,
    pan = false,
    name = memberName(item.user_id),
  ) {
    if (suppressedMembers.has(item.user_id)) return;
    const choice = ++selectionEpoch,
      day = mapEpoch,
      loadId = epoch,
      generation = ledgerGeneration;
    let scope = ledger;
    if (!scope) {
      const date = $("dashboardMapDate").value;
      const [year, month, dayOfMonth] = date.split("-").map(Number);
      const start = new Date(0);
      start.setFullYear(year, month - 1, dayOfMonth);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      scope = { date, start, end };
    }
    const selection = $("dashboardMapSelection");
    highlightEvent(item.id);
    selection.replaceChildren(
      ...eventSnapshot(item, name),
      eventLocation(item),
      text("p", "Checking current event access…"),
    );
    const read = async (path) => {
      const response = await dashboardFetch(
        path,
        {
          headers: { Authorization: `Bearer ${adminKey}` },
          cache: "no-store",
          redirect: "error",
        },
        mapController?.signal,
      );
      if (!response.ok)
        throw httpError("Dashboard read failed", response.status);
      return response.json();
    };
    const current = () =>
      loadId === epoch &&
      day === mapEpoch &&
      generation === ledgerGeneration &&
      choice === selectionEpoch;
    let fresh;
    try {
      const data = await read(
        `/api/dashboard/event?${new URLSearchParams({ event_id: item.id, date: scope.date, start: scope.start.toISOString(), end: scope.end.toISOString() })}`,
      );
      fresh = Array.isArray(data?.events) && data.events[0];
      const exact =
        data.events.length === 1 &&
        fresh?.id === item.id &&
        fresh.user_id === item.user_id &&
        fresh.occurred_at === item.occurred_at;
      // Like a late denial, a validated private Position withdrawal still
      // applies behind a newer selection, but never across a reload or date.
      if (
        exact &&
        fresh.position?.availability === "unavailable" &&
        fresh.position.reason === "private" &&
        loadId === epoch &&
        day === mapEpoch &&
        generation === ledgerGeneration
      )
        withholdMember(item.user_id);
      if (!exact) throw httpError("Event unavailable", 404);
      if (!current()) return;
    } catch (error) {
      // A denial applies even after the selection changed; never across a reload.
      // Purging redraws the timeline, so decide whether to report it first.
      const shown = current();
      if (loadId === epoch && denied(error)) denyMember(item.user_id);
      if (
        error.status === 409 &&
        loadId === epoch &&
        day === mapEpoch &&
        generation === ledgerGeneration
      ) {
        void loadTimeline(adminKey, null, 1);
        if (shown)
          selection.replaceChildren(
            text(
              "p",
              "Event authority changed (409); the day is reloading from the first page.",
            ),
          );
        return;
      }
      if (denied(error)) {
        if (shown)
          selection.replaceChildren(
            text(
              "p",
              `Event access denied (${error.status}); this member's events, locations and loaded details were removed.`,
            ),
          );
        return;
      }
      if (
        error.status === 404 &&
        loadId === epoch &&
        day === mapEpoch &&
        generation === ledgerGeneration
      ) {
        // Empty exact reads do not disclose why; the event leaves both views,
        // even behind a newer selection, which is left as it is.
        ledger?.items.delete(item.id);
        filterTimeline();
        syncMap();
        if (shown)
          selection.replaceChildren(
            text(
              "p",
              "Event unavailable (404); it was removed from the map and timeline.",
            ),
          );
        return;
      }
      if (!current()) return;
      selection.replaceChildren(
        ...eventSnapshot(item, name),
        text(
          "p",
          `Event access could not be rechecked${error.status ? ` (${error.status})` : ""}.`,
        ),
      );
      return;
    }
    // The fresh ledger row is authoritative: withheld Position removes the
    // event's geometry while its permitted timeline occurrence remains.
    ledger?.items.set(item.id, fresh);
    if (eventPosition(item) && !eventPosition(fresh)) syncMap();
    selection.replaceChildren(
      ...eventSnapshot(fresh, name),
      eventLocation(fresh),
      text("p", "Event access rechecked for this read.", "hint"),
    );
    if (pan) revealEvent(fresh);
    if (
      !Object.hasOwn(activityColors, fresh.subject?.type) ||
      !/^[0-9a-f]{24}$/.test(fresh.subject?.id || "")
    )
      return;
    const pending = text("p", "Checking current subject activity…", "hint");
    selection.append(pending);
    try {
      const envelope = await read(
        `/api/dashboard/activity?${new URLSearchParams({ id: fresh.subject.id })}`,
      );
      if (!current()) return;
      if (
        envelope.owner?._id !== item.user_id ||
        envelope.activity?._id !== fresh.subject.id ||
        envelope.activity?.user_id !== item.user_id
      )
        throw httpError("Subject unavailable", 404);
      pending.replaceWith(...subjectDetail(envelope.activity));
    } catch (error) {
      const shown = current();
      if (loadId === epoch && denied(error)) denyMember(item.user_id);
      if (!shown) return;
      if (denied(error))
        selection.replaceChildren(
          text(
            "p",
            `Activity access denied (${error.status}); this member's events, locations and loaded details were removed.`,
          ),
        );
      // A missing current subject never removes its historical ledger event.
      else
        pending.textContent = `Current subject activity unavailable${error.status ? ` (${error.status})` : ""}; this historical event remains.`;
    }
  }
  const activityColors = {
    workout: "#ef4444",
    meal: "#22c55e",
    media: "#8b5cf6",
    metric: "#3b82f6",
    survey: "#f59e0b",
    status_change: "#6b7280",
  };
  // 50 pages × the BFF's fixed limit of 100 bounds one load at 5,000 events.
  const TIMELINE_MAX_PAGES = 50;
  // A member's located events farther apart than this are not connected.
  const GAP_HOURS = 4;
  const eventCategory = (item) => item.event_type?.split(".")[0] || "other";
  const eventColor = (item) => activityColors[eventCategory(item)] || "#6b7280";
  function eventLabel(kind) {
    return typeof kind === "string" ? kind.replace(/[._]/g, " ") : "Event";
  }
  function eventSnapshot(item, name) {
    const heading = text(
      "h3",
      `${name} · ${eventLabel(item.event_type)}`,
      "dashboard-event-detail",
    );
    heading.dataset.memberId = item.user_id;
    const rows = [
      heading,
      text(
        "p",
        `Occurred: ${new Date(item.occurred_at).toLocaleString([], { timeZoneName: "short" })} · ${item.occurred_at}`,
      ),
      text(
        "p",
        `Subject: ${item.subject?.type || "Unavailable"} · ${item.subject?.id || "Unavailable"}`,
      ),
      text(
        "p",
        `Actor: ${item.actor_type || "Unavailable"} · Source: ${item.source || "Unavailable"}`,
      ),
    ];
    const details = item.details || {};
    if (
      Number.isSafeInteger(details.exercise_index) &&
      details.exercise_index >= 0 &&
      Number.isSafeInteger(details.set_index) &&
      details.set_index >= 0
    )
      rows.push(
        text(
          "p",
          `Exercise ${details.exercise_index + 1} · Set ${details.set_index + 1}`,
        ),
      );
    if (
      Number.isFinite(details.previous_quantity) &&
      Number.isFinite(details.quantity) &&
      typeof details.previous_unit === "string" &&
      details.previous_unit.length <= 128 &&
      typeof details.unit === "string" &&
      details.unit.length <= 128
    )
      rows.push(
        text(
          "p",
          `${details.previous_quantity} ${details.previous_unit} → ${details.quantity} ${details.unit}`,
        ),
      );
    // Render only bounded scalar DTO fields, never raw source documents, HTML or URLs.
    const allowed = new Set([
      "from_status",
      "to_status",
      "food_id",
      "food_index",
      "change",
      "instance_id",
      "legacy_index",
      "quantity",
      "unit",
      "previous_quantity",
      "previous_unit",
      "changed_fields",
      "question_count",
      "answered_count",
      "file_count",
      "accepted_count",
      "rejected_count",
      "measurement_count",
      "exercise_count",
      "set_count",
      "food_count",
      "event_id",
      "session_id",
      "sequence",
      "platform",
      "observed_at",
      "start_reason",
      "exercise_id",
      "set_id",
      "set_index",
      "exercise_index",
    ]);
    for (const [key, value] of Object.entries(item.details || {})) {
      if (!allowed.has(key)) continue;
      const values = Array.isArray(value) ? value.slice(0, 100) : [value];
      const safe = values.filter(
        (v) =>
          (typeof v === "string" && v.length <= 1024) ||
          typeof v === "boolean" ||
          (typeof v === "number" && Number.isFinite(v)),
      );
      if (safe.length)
        rows.push(text("p", `${eventLabel(key)}: ${safe.join(", ")}`));
    }
    rows.push(
      text(
        "p",
        "Authorized historical event snapshot. The subject may have changed or been deleted; live activity detail is not required.",
        "hint",
      ),
    );
    return rows;
  }
  function renderEventTimeline(target, items, users, start, end, adminKey) {
    timelineInteraction(false);
    let renderEpoch = timelineEpoch;
    const category = eventCategory;
    const name = (item) => users.get(item.user_id)?.display_name || "Member";
    const time = (item) =>
      new Date(item.occurred_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });
    const label = (item) =>
      `${name(item)} · ${eventLabel(item.event_type)} · ${time(item)}`;
    let selectedCategory = null,
      zoom = 1,
      gesture = null,
      suppressPointerClick = false;
    const toolbar = text("div", "", "dashboard-timeline-toolbar");
    const filters = text("div", "", "dashboard-timeline-legend");
    filters.setAttribute("aria-label", "Filter event category");
    const scroll = text("div", "", "dashboard-timeline-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute(
      "aria-label",
      "Day event timeline; drag events to scrub, drag time labels to pan",
    );
    const track = text("div", "", "dashboard-timeline-track");
    scroll.append(track);
    const interactive = () =>
      renderEpoch === timelineEpoch && !timelinePending && scroll.isConnected;
    const tooltip = text("div", "", "dashboard-timeline-tooltip");
    tooltip.hidden = true;
    tooltip.setAttribute("role", "tooltip");
    tooltip.id = "dashboardTimelineTooltip";
    const highlightPreviewSlice = (eventId) => {
      for (const mark of track.querySelectorAll(".dashboard-timeline-mark"))
        mark.dataset.preview = String(mark.dataset.eventId === eventId);
    };
    const dismiss = () => {
      highlightPreviewSlice(null);
      tooltip.replaceChildren();
      tooltip.hidden = true;
      tooltip.removeAttribute("data-event-id");
      previewEventId = null;
      refreshMap();
    };
    const preview = (item, x, y) => {
      if (!interactive() || !item) return;
      tooltip.dataset.eventId = item.id;
      highlightPreviewSlice(item.id);
      const snapshot = eventSnapshot(item, name(item));
      tooltip.replaceChildren(
        text("div", label(item)),
        text("div", (snapshot[4]?.textContent || "").slice(0, 120), "hint"),
      );
      tooltip.hidden = false;
      tooltip.style.width = `${Math.min(280, innerWidth - 24)}px`;
      const card = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(12, Math.min(innerWidth - card.width - 12, x - card.width / 2))}px`;
      tooltip.style.top = `${Math.max(12, Math.min(innerHeight - card.height - 12, y + 16))}px`;
      previewEventId = eventPosition(item) ? item.id : null;
      refreshMap();
      if (previewEventId) revealEvent(item);
    };
    const previewMark = (item, mark) => {
      const rect = mark.getBoundingClientRect();
      preview(item, rect.left + rect.width / 2, rect.bottom);
    };
    const nearest = (x) => {
      const rect = track.getBoundingClientRect();
      const stamp =
        +start +
        Math.max(0, Math.min(1, (x - rect.left) / rect.width)) *
          (+end - +start);
      return visibleItems().reduce(
        (best, item) =>
          !best ||
          Math.abs(Date.parse(item.occurred_at) - stamp) <
            Math.abs(Date.parse(best.occurred_at) - stamp)
            ? item
            : best,
        null,
      );
    };
    const cancelGesture = () => {
      const old = gesture;
      gesture = null;
      if (old && track.hasPointerCapture(old.id))
        track.releasePointerCapture(old.id);
      dismiss();
    };
    // The event band scrubs. The time-label band pans at every zoom level;
    // toolbar pan buttons and native horizontal scrolling remain available.
    track.onpointerdown = (event) => {
      if (!interactive()) return;
      if (event.pointerType !== "touch") {
        suppressPointerClick = false;
        return;
      }
      suppressPointerClick = true;
      gesture = {
        id: event.pointerId,
        mode:
          event.clientY - track.getBoundingClientRect().top >= 41
            ? "pan"
            : "scrub",
        x: event.clientX,
        left: scroll.scrollLeft,
      };
      track.setPointerCapture(event.pointerId);
      if (gesture.mode === "scrub")
        preview(nearest(event.clientX), event.clientX, event.clientY);
      else dismiss();
      event.preventDefault();
    };
    track.onpointermove = (event) => {
      if (!interactive()) return;
      if (gesture?.id === event.pointerId) {
        if (gesture.mode === "pan")
          scroll.scrollLeft = gesture.left + gesture.x - event.clientX;
        else preview(nearest(event.clientX), event.clientX, event.clientY);
      } else if (event.pointerType !== "touch")
        preview(nearest(event.clientX), event.clientX, event.clientY);
    };
    track.onpointerup = (event) => {
      if (gesture?.id !== event.pointerId) return;
      const item = gesture.mode === "scrub" ? nearest(event.clientX) : null;
      cancelGesture();
      if (item) select(item);
    };
    track.onpointercancel = () => {
      if (interactive()) cancelGesture();
    };
    track.onlostpointercapture = () => {
      if (interactive() && gesture) cancelGesture();
    };
    track.onclick = (event) => {
      if (event.detail > 0 && !suppressPointerClick)
        select(nearest(event.clientX));
    };
    track.onpointerleave = () => {
      if (interactive() && !gesture) dismiss();
    };
    scroll.onscroll = () => {
      if (interactive()) dismiss();
    };
    const visibleItems = () =>
      [...items.values()]
        .filter(
          (item) =>
            !suppressedMembers.has(item.user_id) &&
            (!selectedMember || selectedMember === item.user_id) &&
            (!selectedCategory || selectedCategory === category(item)),
        )
        .sort(
          (a, b) =>
            Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
            a.id.localeCompare(b.id),
        );
    const select = (item) => {
      if (!interactive() || !item) return;
      if (!visibleItems().some((event) => event.id === item.id)) return;
      void selectEvent(item, adminKey, true, name(item));
      dismiss();
    };
    const draw = () => {
      const focused = document.activeElement;
      const focusedEventId =
        interactive() &&
        focused?.classList.contains("dashboard-timeline-mark") &&
        track.contains(focused)
          ? focused.getAttribute("data-event-id")
          : null;
      cancelGesture();
      for (const [id, item] of items)
        if (suppressedMembers.has(item.user_id)) items.delete(id);
      const events = visibleItems();
      const visibleIds = new Set(events.map((item) => item.id));
      const selected = $("dashboardMapSelection").querySelector(
        ".dashboard-event-detail",
      );
      if (
        (selectedEventId &&
          !events.some((item) => item.id === selectedEventId)) ||
        (selected &&
          (suppressedMembers.has(selected.dataset.memberId) ||
            (selectedMember && selectedMember !== selected.dataset.memberId)))
      ) {
        selectionEpoch++;
        highlightEvent(null);
        $("dashboardMapSelection").replaceChildren();
      }
      for (const chip of filters.children)
        chip.setAttribute(
          "aria-pressed",
          String((chip.dataset.category || null) === selectedCategory),
        );
      track.replaceChildren();
      const width = Math.max(160, scroll.clientWidth - 32) * zoom;
      track.style.width = `${width}px`;
      const fraction = (stamp) => (stamp - +start) / (+end - +start);
      const now = Date.now();
      if (now >= +start && now < +end) {
        const future = text("div", "", "dashboard-timeline-future");
        future.style.left = `${fraction(now) * 100}%`;
        track.append(future);
        const marker = text("span", "", "dashboard-timeline-now");
        const nowLabel = text("span", "Now");
        nowLabel.style.position = "absolute";
        // Preserve the exact time anchor while keeping the label inside the
        // full-day viewport, including the last minute before midnight.
        nowLabel.style[fraction(now) > 0.5 ? "right" : "left"] = "4px";
        marker.style.width = "0";
        marker.style.paddingLeft = "0";
        marker.append(nowLabel);
        marker.style.left = `${fraction(now) * 100}%`;
        marker.setAttribute(
          "aria-label",
          `Now ${new Date(now).toLocaleTimeString()}`,
        );
        track.append(marker);
      }
      // Keep one unique, inspectable occurrence node for every loaded authorized event.
      for (const item of [...items.values()].sort(
        (a, b) =>
          Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
          a.id.localeCompare(b.id),
      )) {
        const mark = text("button", "", "dashboard-timeline-mark");
        mark.type = "button";
        mark.dataset.eventId = item.id;
        mark.dataset.activityId = item.subject?.id || "";
        mark.dataset.memberId = item.user_id;
        mark.dataset.eventType = item.event_type;
        mark.style.left = `${fraction(Date.parse(item.occurred_at)) * 100}%`;
        mark.style.top = "13px";
        mark.style.backgroundColor =
          activityColors[category(item)] || "#6b7280";
        mark.setAttribute("aria-label", label(item));
        mark.setAttribute("aria-pressed", String(selectedEventId === item.id));
        mark.classList.toggle(
          "dashboard-timeline-future-event",
          now >= +start && now < +end && Date.parse(item.occurred_at) > now,
        );
        mark.hidden = !visibleIds.has(item.id);
        mark.setAttribute("aria-describedby", tooltip.id);
        mark.onfocus = () => {
          if (mark.isConnected) previewMark(item, mark);
        };
        mark.onblur = () => {
          if (mark.isConnected && interactive()) dismiss();
        };
        mark.onclick = (event) => {
          if (event.detail === 0 && mark.isConnected) select(item);
        };
        track.append(mark);
      }
      const step =
        Math.max(
          1,
          Math.ceil(
            (+end - +start) / 3600000 / Math.max(1, Math.floor(width / 64)),
          ),
        ) * 3600000;
      const ticks = [];
      for (let tick = +start; tick < +end; tick += step) {
        if (tick === +start || ((+end - tick) / (+end - +start)) * width >= 52)
          ticks.push(tick);
      }
      ticks.push(+end);
      for (const tick of ticks) {
        const tickLabel = text(
          "span",
          new Date(tick).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
          "dashboard-timeline-tick",
        );
        tickLabel.style.left = `${fraction(tick) * 100}%`;
        tickLabel.setAttribute(
          "aria-label",
          `${tick === +end ? "Next midnight" : "Local time"} ${new Date(tick).toLocaleString([], { timeZoneName: "short" })}`,
        );
        if (tick === +start)
          tickLabel.classList.add("dashboard-timeline-start");
        if (tick === +end) tickLabel.classList.add("dashboard-timeline-end");
        track.append(tickLabel);
      }
      toolbar.querySelector(".dashboard-timeline-zoom-label").textContent =
        zoom === 1 ? "Full day" : `${zoom}× zoom`;
      toolbar.querySelector('[data-action="Zoom in"]').disabled = zoom === 128;
      toolbar.querySelector('[data-action="Zoom out"]').disabled = zoom === 1;
      // Redrawing scale/markers must not send the next keyboard activation to
      // the page. Never restore an old or filtered authority inventory's focus.
      if (focusedEventId && visibleIds.has(focusedEventId) && interactive()) {
        const replacement = [
          ...track.querySelectorAll(".dashboard-timeline-mark"),
        ].find(
          (mark) => mark.dataset.eventId === focusedEventId && !mark.hidden,
        );
        replacement?.focus({ preventScroll: true });
      }
    };
    for (const type of [null, ...new Set([...items.values()].map(category))]) {
      const chip = text(
        "button",
        type
          ? type === "status_change"
            ? "Readiness"
            : eventLabel(type)
          : "All events",
      );
      chip.type = "button";
      chip.dataset.category = type || "";
      if (type) {
        const swatch = text("i", "", "dashboard-timeline-swatch");
        swatch.style.backgroundColor = activityColors[type] || "#6b7280";
        swatch.setAttribute("aria-hidden", "true");
        chip.prepend(swatch);
      }
      chip.onclick = () => {
        if (!interactive()) return;
        selectedCategory = type;
        draw();
      };
      filters.append(chip);
    }
    for (const action of [
      "Previous event",
      "Next event",
      "Pan earlier",
      "Zoom out",
      "Zoom in",
      "Full day",
      "Pan later",
    ]) {
      const button = text(
        "button",
        {
          "Previous event": "‹",
          "Next event": "›",
          "Full day": "↺",
          "Pan earlier": "←",
          "Zoom out": "−",
          "Zoom in": "+",
          "Pan later": "→",
        }[action] || action,
      );
      button.type = "button";
      button.dataset.action = action;
      button.setAttribute("aria-label", action);
      button.onclick = () => {
        if (!interactive()) return;
        if (action === "Previous event" || action === "Next event") {
          const events = visibleItems();
          const index = events.findIndex((item) => item.id === selectedEventId);
          const next =
            index < 0
              ? action === "Next event"
                ? 0
                : events.length - 1
              : index + (action === "Next event" ? 1 : -1);
          const item = events[next];
          if (item) {
            select(item);
            revealTimelineEvent(item.id);
          }
          return;
        }
        if (action.startsWith("Pan")) {
          scroll.scrollBy({
            left:
              (action === "Pan earlier" ? -1 : 1) * scroll.clientWidth * 0.75,
          });
          return;
        }
        const oldZoom = zoom,
          center =
            (scroll.scrollLeft + scroll.clientWidth / 2) / track.offsetWidth;
        zoom =
          action === "Full day"
            ? 1
            : action === "Zoom in"
              ? Math.min(128, zoom * 2)
              : Math.max(1, zoom / 2);
        if (oldZoom !== zoom) {
          draw();
          scroll.scrollLeft =
            zoom === 1
              ? 0
              : center * track.offsetWidth - scroll.clientWidth / 2;
        }
      };
      toolbar.append(button);
    }
    toolbar.append(text("span", "", "dashboard-timeline-zoom-label"));
    target.append(filters, toolbar, scroll, tooltip);
    target.onkeydown = (event) => {
      if (!interactive()) return;
      if (event.key === "Escape") {
        dismiss();
        event.preventDefault();
      } else if (
        (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
        !event.target.closest(
          ".dashboard-timeline-toolbar, .dashboard-timeline-legend",
        )
      ) {
        const buttons = [
          ...track.querySelectorAll("button:not([hidden])"),
        ].sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
        const index = buttons.indexOf(document.activeElement);
        const next =
          index < 0
            ? event.key === "ArrowRight"
              ? 0
              : buttons.length - 1
            : Math.max(
                0,
                Math.min(
                  buttons.length - 1,
                  index + (event.key === "ArrowRight" ? 1 : -1),
                ),
              );
        buttons[next]?.focus({ preventScroll: true });
        buttons[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
        event.preventDefault();
      }
    };
    filterTimeline = draw;
    reconcileTimelineSelection = (item) => {
      if (!interactive()) return;
      if (selectedMember && selectedMember !== item.user_id) {
        selectedMember = null;
        renderMemberCards();
        filterFeed();
        filterMap(false);
      }
      if (selectedCategory && selectedCategory !== category(item)) {
        selectedCategory = null;
        draw();
      }
    };
    draw();
    // Recompute the time scale after viewport changes, without leaked observers.
    timelineResize?.disconnect();
    timelineResize = new ResizeObserver(() => {
      if (scroll.isConnected) draw();
    });
    timelineResize.observe(scroll);
    timelineInteraction = (enabled) => {
      cancelGesture();
      for (const region of [scroll, filters, toolbar]) region.inert = !enabled;
      if (enabled && scroll.isConnected) {
        // A transient read failure deliberately restores this retained
        // inventory's interaction epoch, never an obsolete async completion.
        renderEpoch = timelineEpoch;
        draw();
        timelineResize.observe(scroll);
      }
    };
  }
  // `restarts` counts page-one reloads after a 409 authority change (at most two).
  async function loadTimeline(adminKey, resume = null, restarts = 0) {
    const target = $("dashboardTimeline");
    if (!target) return;
    selectionEpoch++;
    $("dashboardMapSelection").replaceChildren();
    if (restarts) highlightEvent(null);
    const id = ++timelineEpoch;
    timelinePending = true;
    ledgerFailure = null;
    timelineInteraction(false);
    timelineController?.abort();
    timelineController = new AbortController();
    const signal = timelineController.signal,
      date = $("dashboardMapDate").value;
    const live = () => id === timelineEpoch && !signal.aborted;
    // Changed authority invalidates the retained inventory, not only its geometry.
    if (target.dataset.date !== date || restarts) {
      target.replaceChildren();
      timelineInteraction = () => {};
      filterTimeline = () => {};
    }
    target.dataset.date = date;
    for (const old of target.querySelectorAll(":scope > p, :scope > button"))
      old.remove();
    timelineResize?.disconnect();
    for (const tooltip of target.querySelectorAll(
      ".dashboard-timeline-tooltip",
    )) {
      tooltip.replaceChildren();
      tooltip.hidden = true;
    }
    if (!resume) {
      // A new page-one read never mixes with an older inventory or geometry.
      ledgerGeneration++;
      ledger = null;
    }
    syncMap();
    const status = text("p", "Loading authorized day events…", "hint");
    status.setAttribute("role", "status");
    target.append(status);
    if (!validDay(date)) {
      timelinePending = false;
      status.textContent = "Choose a valid event date.";
      return;
    }
    const [year, month, day] = date.split("-").map(Number);
    const start = new Date(0);
    start.setFullYear(year, month - 1, day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const users = new Map(resume?.users),
      items = resume?.items || new Map();
    let cursor = resume?.cursor,
      pages = 0;
    // Render loaded events; `failure` marks a transiently interrupted partial day.
    const publish = (failure = null) => {
      timelinePending = false;
      ledger = { date, start, end, items, users, complete: !cursor };
      status.textContent = failure
        ? `Timeline read failed (${failure.status}); partial day. Retry to continue loading.`
        : cursor
          ? "More events available; partial day. Load more to continue."
          : "Complete loaded pages.";
      status.hidden = !cursor;
      target.replaceChildren(status);
      renderEventTimeline(target, items, users, start, end, adminKey);
      if (cursor) {
        const more = text(
          "button",
          failure ? "Retry timeline" : "Load more events",
        );
        more.type = "button";
        more.onclick = () => {
          more.disabled = true;
          void loadTimeline(adminKey, { users, items, cursor });
        };
        target.append(more);
      }

      filterTimeline();
      syncMap();
    };
    try {
      const seenCursors = new Set();
      do {
        const query = new URLSearchParams({
          date,
          start: start.toISOString(),
          end: end.toISOString(),
        });
        if (cursor) query.set("cursor", cursor);
        const response = await dashboardFetch(
          `/api/dashboard/timeline?${query}`,
          {
            headers: { Authorization: `Bearer ${adminKey}` },
            signal,
            cache: "no-store",
            redirect: "error",
          },
        );
        if (!response.ok)
          throw httpError("Timeline read failed", response.status);
        const data = await response.json();
        if (!live()) return;
        if (
          !Array.isArray(data.users) ||
          !Array.isArray(data.events) ||
          typeof data.hasMore !== "boolean"
        )
          throw new Error("Invalid timeline response");
        // Validate the whole page and continuation before accepting new
        // authority. A malformed successful HTTP response is a failed reload,
        // not permission to undo an existing member-wide Position withdrawal.
        if (
          data.hasMore &&
          (typeof data.nextCursor !== "string" ||
            !data.nextCursor ||
            data.nextCursor === cursor ||
            seenCursors.has(data.nextCursor))
        )
          throw new Error("Timeline display limit or nonadvancing cursor");
        const pageIds = new Set();
        for (const item of data.events) {
          const stamp = Date.parse(item?.occurred_at);
          if (
            !item ||
            typeof item.id !== "string" ||
            typeof item.user_id !== "string" ||
            !Number.isFinite(stamp) ||
            stamp < +start ||
            stamp >= +end ||
            items.has(item.id) ||
            pageIds.has(item.id)
          )
            throw new Error("Invalid timeline event");
          pageIds.add(item.id);
        }
        if (!resume && pages === 0) withheldMembers.clear();

        for (const user of data.users) users.set(user._id, user);
        const newlyPrivate = new Set();
        for (const item of data.events) {
          items.set(item.id, item);
          if (
            item.position?.availability === "unavailable" &&
            item.position.reason === "private" &&
            !withheldMembers.has(item.user_id)
          )
            newlyPrivate.add(item.user_id);
        }
        for (const memberId of newlyPrivate) withholdMember(memberId);
        pages++;
        cursor = data.hasMore ? data.nextCursor : undefined;
        if (cursor) seenCursors.add(cursor);
        // Page serially to the terminal cursor so every event (and its GPS) loads,
        // within an explicit safety bound; beyond it the day stays visibly partial.
      } while (cursor && pages < TIMELINE_MAX_PAGES);
      if (!live()) return;
      publish();
    } catch (error) {
      if (!live()) return;
      if (error.status === 409 && restarts < 2)
        return void loadTimeline(adminKey, null, restarts + 1);
      // A transient failure after progress keeps the loaded events as a visibly
      // partial day (no connections); retry resumes at the failed cursor.
      if (
        error.status &&
        !denied(error) &&
        error.status !== 409 &&
        cursor &&
        (pages || resume)
      )
        return publish(error);
      timelinePending = false;
      ledgerFailure = error.status || 0;
      if (denied(error) || error.status === 409) {
        ledgerGeneration++;
        ledger = null;
        highlightEvent(null);
        $("dashboardMapSelection").replaceChildren();
        selectionEpoch++;
        filterTimeline = () => {};
        timelineResize?.disconnect();
        target.replaceChildren(status);
        timelineInteraction = () => {};
      } else {
        timelineInteraction(true);
      }
      status.textContent =
        error.status === 409
          ? "Timeline unavailable (409): event authority changed while loading; try again."
          : `Timeline unavailable${error.status ? ` (${error.status})` : ""}; try again.${!denied(error) && target.querySelector(".dashboard-timeline-track") ? " Retained events are stale; authorization could not be refreshed." : ""}`;
      const retry = text("button", "Retry timeline");
      retry.type = "button";
      retry.onclick = () => void loadTimeline(adminKey);
      target.append(retry);
      syncMap();
    }
  }
  function loadRoster(adminKey) {
    const signal = controller.signal,
      id = epoch;
    const live = () => !signal.aborted && id === epoch;
    const request = async (path) => {
      const response = await dashboardFetch(`/api/${path}`, {
        headers: { Authorization: `Bearer ${adminKey}` },
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok)
        throw httpError(
          denied(response)
            ? `Authorized map read denied (${response.status}).`
            : `Map read failed (${response.status}); try again shortly.`,
          response.status,
        );
      return response.json();
    };
    const startAvatars = () => {
      // No per-activity reads; bound requests per load and concurrent BFF reads.
      // Remaining members retain their initials badge rather than silently requesting 5000 images.
      const avatarMembers = [...mapMembers.keys()].filter((id) =>
        /^[0-9a-f]{24}$/.test(id),
      );
      const avatarQueue = avatarMembers.slice(0, 80);
      let avatarIndex = 0;
      const readAvatar = async () => {
        while (live() && avatarIndex < avatarQueue.length) {
          const memberId = avatarQueue[avatarIndex++];
          try {
            const response = await dashboardFetch(
              `/api/dashboard/avatar?${new URLSearchParams({ id: memberId })}`,
              {
                headers: { Authorization: `Bearer ${adminKey}` },
                signal,
                cache: "no-store",
                redirect: "error",
              },
            );
            if (
              !response.ok ||
              !/^image\/(jpeg|png|webp)$/.test(
                response.headers.get("content-type")?.split(";")[0] || "",
              )
            )
              continue;
            const blob = await response.blob();
            if (
              !live() ||
              suppressedMembers.has(memberId) ||
              !mapMembers.has(memberId) ||
              blob.size > 1024 * 1024 ||
              !blob.size
            )
              continue;
            const url = URL.createObjectURL(blob);
            avatarUrls.push(url);
            avatarCache.set(memberId, url);
            for (const pin of $("dashboardMemberCards").querySelectorAll(
              ".dashboard-member-portrait",
            )) {
              if (pin.dataset.memberId !== memberId) continue;
              const image = text("img", "", "dashboard-roster-image");
              image.alt = "";
              image.src = url;
              image.onerror = () => image.remove();
              pin.prepend(image);
            }
          } catch {
            /* revoked access, aborted scope, or unavailable image: initials remain */
          }
        }
      };
      for (let worker = 0; worker < Math.min(2, avatarQueue.length); worker++)
        void readAvatar();
    };
    // The roster is not date-scoped: request it at once so authorized member
    // cards never wait on, or disappear with, the event read or Leaflet.
    rosterReady = request("dashboard/members")
      .then((roster) => {
        if (!Array.isArray(roster?.members))
          throw new Error("Invalid member roster.");
        return {
          members: new Map(
            roster.members
              .filter((m) => typeof m?._id === "string")
              .map((m) => [m._id, m]),
          ),
        };
      })
      .catch((error) => ({ error }))
      .then(({ members, error }) => {
        if (!live()) return { note: "" };
        const code = error?.status ? ` (${error.status})` : "";
        let note = "Member cards use the separately authorized roster.";
        if (members) rosterCache = members;
        else if (denied(error)) {
          rosterCache = null;
          note = `Member roster access denied${code}; roster stats removed.`;
        } else
          note = rosterCache
            ? `Member roster refresh failed${code}; showing previously loaded members.`
            : `Member roster unavailable${code}; member cards show loaded shared data only.`;
        mapMembers = new Map(
          [...(rosterCache || [])].filter(([id]) => !suppressedMembers.has(id)),
        );
        renderMemberCards();
        startAvatars();
        return { note };
      });
  }
  async function loadMap(adminKey) {
    selectionEpoch++;
    // A new date replaces every mark, so only the shared selection is reset.
    selectedEventId = null;
    syncMap = () => {};
    refreshMap = () => {};
    revealEvent = () => {};
    mapEpoch++;
    mapController?.abort();
    mapController = new AbortController();
    // Map and timeline share this one complete day-events reader.
    void loadTimeline(adminKey);
    const signal = mapController.signal,
      id = mapEpoch;
    const live = () => !signal.aborted && id === mapEpoch;
    const map = $("dashboardMap"),
      selection = $("dashboardMapSelection"),
      status = $("dashboardMapStatus");
    if (!map || !selection || !status) return;
    disposeMap();
    filterMap = () => {};
    map.replaceChildren();
    selection.replaceChildren();
    status.removeAttribute("data-tone");
    let rosterNote = "";
    let showStatus = () => {};
    void rosterReady.then(({ note }) => {
      if (!live()) return;
      rosterNote = rosterCache ? "" : ` ${note}`;
      showStatus();
    });
    const fail = async (message) => {
      showStatus = () => {};
      status.dataset.tone = "error";
      status.textContent = message;
      const { note } = await rosterReady;
      if (live()) status.textContent = `${message} ${note}`;
    };
    const date = $("dashboardMapDate").value;
    if (!validDay(date)) return fail("Choose a valid event date.");
    status.textContent = `Loading authorized event locations for ${date} (event occurrence time in your device timezone)…`;
    if (!window.L) return fail("Map unavailable: Leaflet could not load.");
    const L = window.L;
    const instance = L.map(map, { zoomControl: true, worldCopyJump: true });
    leafletMap = instance;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(instance);
    instance.setView([0, 0], 2); // Neutral initial view; never request device location.
    const overlay = text("div", "", "dashboard-map-overlay");
    map.append(overlay);
    let chooserOwner = null;
    const chooser = text("div", "", "dashboard-map-chooser");
    chooser.hidden = true;
    chooser.setAttribute("role", "group");
    chooser.setAttribute("aria-label", "Events at this recorded location");
    map.after(chooser);
    const closeChooser = (restore = true) => {
      chooser.hidden = true;
      chooser.replaceChildren();
      if (restore && chooserOwner?.isConnected)
        chooserOwner.focus({ preventScroll: true });
      chooserOwner = null;
    };
    // Dispose with the date-owned map, including a detached chooser's handlers.
    signal.addEventListener(
      "abort",
      () => {
        closeChooser(false);
        chooser.remove();
      },
      { once: true },
    );
    chooser.onkeydown = (event) => {
      if (!live()) return;
      if (event.key === "Escape") {
        closeChooser();
        event.preventDefault();
      } else if (
        ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key)
      ) {
        const choices = [...chooser.querySelectorAll(".dashboard-map-choice")];
        const step = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
        choices[
          Math.max(
            0,
            Math.min(
              choices.length - 1,
              choices.indexOf(document.activeElement) + step,
            ),
          )
        ]?.focus();
        event.preventDefault();
      }
    };
    let dots = [],
      links = [],
      groups = [],
      fitted = false,
      initialView;
    const initials = (memberId) =>
      (memberName(memberId).match(/[\p{L}\p{N}]+/gu) || ["M"])
        .slice(-2)
        .map((word) => word[0].toUpperCase())
        .join("");
    const clock = (item) =>
      new Date(item.occurred_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    const scoped = () => (ledger?.date === date ? ledger : null);
    showStatus = () => {
      if (!live()) return;
      const day = scoped();
      status.removeAttribute("data-tone");
      if (!day) {
        if (!timelinePending && ledgerFailure !== null)
          status.dataset.tone = "error";
        status.textContent = timelinePending
          ? `Loading authorized event locations for ${date} (event occurrence time in your device timezone)…${rosterNote}`
          : `Event locations ${denied({ status: ledgerFailure }) ? "denied" : "unavailable"}${ledgerFailure ? ` (${ledgerFailure})` : ""} for ${date}; the day's authorized events could not be loaded.${rosterNote}`;
      } else {
        const total = [...day.items.values()].filter(
          (item) => !suppressedMembers.has(item.user_id),
        ).length;
        status.textContent = `${date} event occurrence time (device timezone) · ${dots.length} of ${total} authorized events have a shared location${day.complete ? " · complete day as loaded (not live)." : " · partial day: not every event is loaded, so event connections are hidden."}${rosterNote}`;
      }
    };
    const choose = (original, generation) => {
      const item = scoped()?.items.get(original.id);
      if (
        !live() ||
        generation !== ledgerGeneration ||
        !item ||
        !eventPosition(item) ||
        suppressedMembers.has(item.user_id)
      )
        return;
      reconcileTimelineSelection(item);
      void selectEvent(item, adminKey);
      revealTimelineEvent(item.id);
    };
    const openChooser = (group) => {
      if (
        !live() ||
        group.generation !== ledgerGeneration ||
        !group.pins.some(({ item }) =>
          eventPosition(scoped()?.items.get(item.id)),
        )
      )
        return;
      closeChooser(false);
      chooserOwner = group.marker;
      chooser.hidden = false;
      const close = text("button", "Close location chooser");
      close.type = "button";
      close.onclick = () => closeChooser();
      chooser.append(
        text(
          "p",
          `Events recorded at ${group.fix.latitude}, ${group.fix.longitude}`,
          "hint",
        ),
        close,
      );
      for (const { item } of group.pins.filter(visible)) {
        const choice = text(
          "button",
          `${clock(item)} · ${initials(item.user_id)} · ${memberName(item.user_id)} · ${eventLabel(item.event_type)}`,
          "dashboard-map-choice",
        );
        choice.type = "button";
        choice.dataset.eventId = item.id;
        choice.setAttribute(
          "aria-pressed",
          String(item.id === selectedEventId),
        );
        choice.style.borderLeftColor = eventColor(item);
        choice.onclick = () => {
          if (!live()) return;
          closeChooser();
          choose(item, group.generation);
        };
        chooser.append(choice);
      }
      chooser.querySelector(".dashboard-map-choice")?.focus();
    };
    const visible = ({ item }) =>
      !suppressedMembers.has(item.user_id) &&
      (!selectedMember || item.user_id === selectedMember);
    // Rebuild the event layer from the canonical ledger.
    syncMap = () => {
      if (!live()) return;
      closeChooser(false);
      overlay.replaceChildren();
      const day = scoped();
      const generation = ledgerGeneration;
      const ordered = day
        ? [...day.items.values()]
            .filter((item) => !suppressedMembers.has(item.user_id))
            .sort(
              (a, b) =>
                Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
                a.id.localeCompare(b.id),
            )
        : [];
      const paths = svg("svg", { class: "dashboard-map-connections" });
      paths.setAttribute("aria-hidden", "true");
      overlay.append(paths);
      dots = [];
      links = [];
      const anchors = new Map(),
        last = new Map();
      for (const item of ordered) {
        const fix = eventPosition(item);
        if (!fix) {
          // Without a shared location the order through this event is unknown.
          last.delete(item.user_id);
          continue;
        }
        const marker = text(
          "button",
          "",
          "dashboard-map-marker dashboard-event-dot",
        );
        marker.type = "button";
        marker.dataset.eventId = item.id;
        marker.dataset.memberId = item.user_id;
        marker.style.backgroundColor = eventColor(item);
        marker.setAttribute(
          "aria-label",
          `${memberName(item.user_id)} · ${eventLabel(item.event_type)} · ${clock(item)}`,
        );
        marker.setAttribute(
          "aria-pressed",
          String(item.id === selectedEventId),
        );
        marker.onclick = () => choose(item, generation);
        const dot = { item, fix, marker };
        dots.push(dot);
        const key = `${fix.latitude},${fix.longitude}`;
        if (!anchors.has(key)) anchors.set(key, []);
        anchors.get(key).push(dot);
        const before = last.get(item.user_id);
        last.set(item.user_id, dot);
        // Unloaded pages could hide a location-less event: connect complete days only.
        if (
          !day.complete ||
          !before ||
          Date.parse(item.occurred_at) - Date.parse(before.item.occurred_at) >
            GAP_HOURS * 3600000
        )
          continue;
        // Colored by the destination event's category.
        const line = svg("line", {
          class: "dashboard-map-connection",
          stroke: eventColor(item),
        });
        line.dataset.memberId = item.user_id;
        line.dataset.from = before.item.id;
        line.dataset.to = item.id;
        paths.append(line);
        links.push({ from: before, to: dot, line });
      }
      groups = [];
      for (const pins of anchors.values()) {
        if (pins.length < 2) continue;
        const marker = text(
          "button",
          "",
          "dashboard-map-marker dashboard-map-group",
        );
        marker.type = "button";
        const group = { fix: pins[0].fix, pins, marker, generation };
        marker.onclick = () => openChooser(group);
        groups.push(group);
      }
      overlay.append(
        ...dots.map(({ marker }) => marker),
        ...groups.map(({ marker }) => marker),
      );
      if (!fitted && dots.length) {
        fitted = true;
        fitPins(dots);
        initialView = {
          center: instance.getCenter(),
          zoom: instance.getZoom(),
        };
      }
      refreshMap();
      showStatus();
    };
    const project = (fix, near) =>
      instance.latLngToContainerPoint([
        fix.latitude,
        fix.longitude + 360 * Math.round((near - fix.longitude) / 360),
      ]);
    const offscreen = (point) =>
      point.x < 0 ||
      point.x > map.clientWidth ||
      point.y < 0 ||
      point.y > map.clientHeight;
    const placePins = () => {
      if (!live()) return;
      const center = instance.getCenter().lng;
      for (const { fix, marker } of dots) {
        const point = project(fix, center);
        marker.hidden = offscreen(point);
        marker.style.left = `${point.x}px`;
        marker.style.top = `${point.y}px`;
      }
      for (const { from, to, line } of links) {
        // Unwrap the destination beside its origin: the shortest arc in one world copy.
        const a = project(from.fix, center),
          b = project(to.fix, instance.containerPointToLatLng(a).lng);
        line.setAttribute("x1", a.x);
        line.setAttribute("y1", a.y);
        line.setAttribute("x2", b.x);
        line.setAttribute("y2", b.y);
      }
      for (const group of groups) {
        const active = group.pins.filter(visible);
        const point = project(group.fix, center);
        group.marker.hidden = active.length < 2 || offscreen(point);
        group.marker.style.left = `${point.x}px`;
        group.marker.style.top = `${point.y}px`;
        group.marker.textContent = String(active.length);
        group.marker.dataset.count = String(active.length);
        group.marker.setAttribute(
          "aria-label",
          `${active.length} events at this recorded location; choose an event`,
        );
        // Selected and previewed events keep their exact dots above the location badge.
        if (active.length > 1)
          for (const { item, marker } of active)
            if (item.id !== selectedEventId && item.id !== previewEventId)
              marker.hidden = true;
      }
    };
    // A selected event emphasizes its member's sequence and dims, never hides,
    // everyone else; the explicit member filter keeps hiding other members.
    refreshMap = () => {
      if (!live()) return;
      const focus = ledger?.items.get(selectedEventId)?.user_id;
      const dim = (memberId) => !!focus && memberId !== focus;
      for (const { item, marker } of dots) {
        marker.classList.toggle("dashboard-filtered", !visible({ item }));
        marker.classList.toggle("dashboard-map-dim", dim(item.user_id));
        marker.dataset.preview = String(item.id === previewEventId);
        marker.style.zIndex = item.id === previewEventId ? "6" : "";
        marker.setAttribute(
          "aria-pressed",
          String(item.id === selectedEventId),
        );
      }
      for (const { to, line } of links) {
        line.classList.toggle("dashboard-filtered", !visible(to));
        line.classList.toggle("dashboard-map-dim", dim(to.item.user_id));
      }
      for (const { pins, marker } of groups)
        marker.classList.toggle(
          "dashboard-map-dim",
          !!focus && pins.every(({ item }) => dim(item.user_id)),
        );
      placePins();
    };
    // Pan only when the event is offscreen, to its nearest world copy; keep zoom.
    revealEvent = (item) => {
      const fix = eventPosition(item);
      if (!live() || !fix) return;
      const center = instance.getCenter().lng;
      if (offscreen(project(fix, center)))
        instance.panTo(
          [
            fix.latitude,
            fix.longitude + 360 * Math.round((center - fix.longitude) / 360),
          ],
          { animate: false },
        );
    };
    filterMap = (clearSelection = true) => {
      closeChooser(false);
      if (clearSelection) {
        selectionEpoch++;
        selection.replaceChildren();
        highlightEvent(null);
      }
      if (clearSelection && initialView)
        instance.setView(initialView.center, initialView.zoom);
      refreshMap();
    };
    instance.on("move zoom resize", placePins);
    const fitPins = (pins) => {
      if (!pins.length) return;
      const longitudes = pins
        .map(({ fix }) => (fix.longitude + 360) % 360)
        .sort((a, b) => a - b);
      let arcStart = longitudes[0];
      if (longitudes.length > 1) {
        let largestGap = -1;
        for (let i = 0; i < longitudes.length; i++) {
          const next =
            i + 1 < longitudes.length ? longitudes[i + 1] : longitudes[0] + 360;
          if (next - longitudes[i] > largestGap) {
            largestGap = next - longitudes[i];
            // Avoid rounding endpoint + 360 back past the endpoint.
            arcStart = longitudes[(i + 1) % longitudes.length];
          }
        }
      }
      const coords = pins.map(({ fix }) => {
        const wrapped = (fix.longitude + 360) % 360;
        return [fix.latitude, wrapped < arcStart ? wrapped + 360 : wrapped];
      });
      if (coords.length === 1)
        instance.setView([pins[0].fix.latitude, pins[0].fix.longitude], 16, {
          animate: false,
        });
      else
        instance.fitBounds(L.latLngBounds(coords), {
          padding: [
            Math.min(48, map.clientWidth / 4),
            Math.min(48, map.clientHeight / 4),
          ],
          maxZoom: 16,
          animate: false,
        });
    };
    let userViewChanged = false;
    instance.on("dragstart", () => {
      userViewChanged = true;
    });
    const markUserView = () => {
      userViewChanged = true;
    };
    map.addEventListener(
      "keydown",
      (event) => {
        if (
          [
            "+",
            "-",
            "=",
            "_",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
          ].includes(event.key)
        )
          markUserView();
      },
      { capture: true, signal },
    );
    map.addEventListener("dblclick", markUserView, { capture: true, signal });
    map.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length > 1) markUserView();
      },
      { passive: true, signal },
    );
    map.addEventListener(
      "touchmove",
      (event) => {
        if (event.touches.length > 1) markUserView();
      },
      { passive: true, signal },
    );
    map.addEventListener(
      "wheel",
      () => {
        userViewChanged = true;
      },
      { passive: true },
    );
    map
      .querySelector(".leaflet-control-zoom")
      ?.addEventListener("click", () => {
        userViewChanged = true;
      });
    mapResizeObserver = new ResizeObserver(() => {
      if (!map.getClientRects().length) return;
      instance.invalidateSize();
      placePins();
      const shown = dots.filter(visible);
      // A desktop fit may leave every event offscreen when the map narrows.
      // Refit only then, preserving deliberate user panning when one is visible.
      if (
        shown.length &&
        (!userViewChanged ||
          shown.every(({ fix }) =>
            offscreen(project(fix, instance.getCenter().lng)),
          ))
      ) {
        fitPins(shown);
        if (!selectedMember)
          initialView = {
            center: instance.getCenter(),
            zoom: instance.getZoom(),
          };
        placePins();
      }
    });
    mapResizeObserver.observe(map);
    syncMap();
  }
  function startGallery({ request, detailFor, live, signal, users, revoked }) {
    const host = $("dashboardGallery");
    if (!host) return; // Legacy embedders without Gallery remain supported.
    const status = text("p", "Loading historical media…", "hint");
    status.setAttribute("role", "status");
    const grid = text("div", "", "dashboard-gallery-history");
    const more = text("button", "Load older photos", "secondary");
    more.type = "button";
    const sentinel = text("div", "", "dashboard-gallery-sentinel");
    host.replaceChildren(text("h3", "Gallery"), status, grid, more, sentinel);
    const paneVisible = () => host.getClientRects().length > 0;
    const entries = new Map();
    const frames = new WeakMap();
    const seenCursors = new Set();
    let cursor,
      loading = false,
      stopped = false,
      failed = false;
    let scope = 0,
      emptyPages = 0,
      pageFailure = false,
      pageSummary = "Loading historical media…";
    let scopeController = new AbortController();
    const visible = (entry) =>
      !revoked.has(entry.activity.user_id) &&
      (!selectedMember || selectedMember === entry.activity.user_id);
    const imageObserver = new IntersectionObserver(
      (changes) => {
        for (const change of changes)
          if (change.isIntersecting && paneVisible()) {
            const frame = frames.get(change.target);
            if (frame) {
              if (visible(frame.entry)) void loadFrame(frame);
            } else {
              const entry = entries.get(change.target.dataset.activityId);
              if (entry && visible(entry) && !entry.error) void hydrate(entry);
            }
          }
      },
      { rootMargin: "400px" },
    );
    const pageObserver = new IntersectionObserver(
      (changes) => {
        if (
          paneVisible() &&
          changes.some((change) => change.isIntersecting) &&
          !failed
        )
          void page();
      },
      { rootMargin: "300px" },
    );
    function settleImages() {
      window.CoachImageViewer?.refresh("gallery");
      const error = [...entries.values()]
        .filter(visible)
        .flatMap((entry) => [
          entry.error,
          ...(entry.frames || []).map((frame) => frame.error),
        ])
        .find(Boolean);
      if (error) return report(error);
      if (!pageFailure) {
        failed = emptyPages >= 5;
        status.textContent = pageSummary;
        more.hidden = stopped;
        more.textContent = "Load older photos";
      }
    }
    function report(error, fromPage = false) {
      if (fromPage) pageFailure = true;
      failed = true;
      status.textContent = `Gallery paused: ${error.message} Use Retry.`;
      more.hidden = false;
      more.textContent = "Retry";
    }
    async function hydrate(entry) {
      if (entry.loading || entry.done || !live() || !visible(entry)) return;
      entry.loading = true;
      const generation = scope;
      try {
        const envelope = await detailFor(entry.activity._id);
        if (!live() || generation !== scope || !visible(entry)) return;
        const detail = envelope?.activity;
        if (
          !detail ||
          detail._id !== entry.activity._id ||
          detail.user_id !== entry.activity.user_id ||
          envelope.owner?._id !== detail.user_id ||
          detail.type !== "media"
        )
          throw new Error("Invalid media detail.");
        if (
          !["complete", "completed"].includes(detail.status) ||
          detail.is_template === true
        ) {
          entry.done = true;
          entry.node.remove();
          settleImages();
          return;
        }
        if (!entry.frames) {
          entry.frames = (
            Array.isArray(detail.data?.files) ? detail.data.files : []
          )
            .filter(isPhoto)
            .map((photo, index, photos) => {
              const button = text(
                "button",
                "Loading photo…",
                "dashboard-photo",
              );
              button.type = "button";
              const caption = `Photo ${index + 1} of ${photos.length} · ${users.get(detail.user_id)?.display_name || "Member"} · ${detail.completed_at || detail.created_at || "Date unavailable"}`;
              button.setAttribute("aria-label", caption);
              entry.node.append(button);
              const frame = { photo, button, caption, entry };
              frames.set(button, frame);
              imageObserver.observe(button);
              return frame;
            });
          entry.placeholder.remove();
          if (!entry.frames.length) entry.node.remove();
        }
        entry.done = true;
        imageObserver.unobserve(entry.node);
        settleImages();
      } catch (error) {
        if (!live() || generation !== scope || !visible(entry)) return;
        // Newly denied reads do not poll or retroactively revoke acquired pixels.
        entry.error = error;
        report(error);
      } finally {
        entry.loading = false;
        if (live() && generation !== scope && visible(entry) && !entry.done) {
          imageObserver.unobserve(entry.node);
          imageObserver.observe(entry.node);
        }
      }
    }
    const viewerEntry = (frame) => ({
      key: frame,
      url: frame.url,
      filename: frame.photo.name || "Progress photo",
      caption: frame.caption,
    });
    const viewerEntries = () =>
      [...entries.values()]
        .filter((entry) => visible(entry) && entry.node.isConnected)
        .flatMap((entry) => (entry.frames || []).map(viewerEntry));
    function loadFrame(frame) {
      if (frame.loading) return frame.loading;
      const pending = readFrame(frame);
      if (frame.loading) frame.loading = pending;
      return pending;
    }
    async function readFrame(frame) {
      const { entry } = frame;
      if (
        !live() ||
        frame.loading ||
        frame.url ||
        frame.error ||
        !visible(entry)
      )
        return;
      frame.loading = true;
      const generation = scope;
      try {
        frame.blob ||= await request(
          "dashboard/photo?" +
            new URLSearchParams({
              activity_id: entry.activity._id,
              file_id: frame.photo._id || frame.photo.id,
            }),
          true,
          scopeController.signal,
        );
        if (!live() || generation !== scope || !visible(entry)) return;
        frame.url = URL.createObjectURL(frame.blob);
        frame.blob = null;
        urls.push(frame.url);
        const image = document.createElement("img");
        image.alt = frame.caption;
        image.loading = "lazy";
        image.src = frame.url;
        image.addEventListener("error", () => {
          if (live())
            frame.button.replaceChildren(
              text("span", "Photo could not be decoded."),
            );
        });
        frame.button.replaceChildren(image);
        frame.button.onclick = () => {
          if (live() && visible(entry))
            window.CoachImageViewer?.open({
              ...viewerEntry(frame),
              owner: "gallery",
              trigger: frame.button,
              getEntries: viewerEntries,
              acquire: async (target) => {
                await loadFrame(target);
                return live() && visible(target.entry) ? target.url : "";
              },
            });
        };
        imageObserver.unobserve(frame.button);
        settleImages();
      } catch (error) {
        if (!live() || generation !== scope) return;
        frame.error = error;
        imageObserver.unobserve(frame.button);
        if (generation === scope && visible(entry)) report(error);
      } finally {
        frame.loading = false;
        if (
          live() &&
          generation !== scope &&
          visible(entry) &&
          !frame.url &&
          !frame.error
        ) {
          imageObserver.unobserve(frame.button);
          imageObserver.observe(frame.button);
        }
      }
    }
    async function page() {
      if (!live() || loading || stopped) return;
      loading = true;
      failed = false;
      pageFailure = false;
      more.disabled = true;
      const generation = scope;
      try {
        const query = cursor ? new URLSearchParams({ cursor }) : null;
        const data = await request(
          "dashboard/gallery" + (query ? "?" + query : ""),
          false,
          scopeController.signal,
        );
        if (!live() || generation !== scope) return;
        if (!Array.isArray(data.users) || !Array.isArray(data.activities))
          throw new Error("Invalid gallery page.");
        if (
          !Object.prototype.hasOwnProperty.call(data, "nextCursor") &&
          data.inDojo !== false
        ) {
          stopped = true;
          more.hidden = true;
          pageSummary =
            "Gallery unavailable: backend does not support filtered cursor pagination.";
          status.textContent = pageSummary;
          return;
        }
        for (const user of data.users)
          if (!revoked.has(user._id)) users.set(user._id, user);
        let added = 0;
        for (const activity of data.activities) {
          if (
            activity.type !== "media" ||
            !["complete", "completed"].includes(activity.status) ||
            revoked.has(activity.user_id) ||
            entries.has(activity._id)
          )
            continue;
          const node = text("article", "", "dashboard-gallery-entry");
          node.dataset.activityId = activity._id;
          const placeholder = text(
            "p",
            "Photos load near the viewport.",
            "hint",
          );
          node.append(
            text(
              "h4",
              `${users.get(activity.user_id)?.display_name || "Member"} · ${activity.completed_at || activity.created_at || "Date unavailable"}`,
            ),
            placeholder,
          );
          const entry = { activity, node, placeholder };
          entries.set(activity._id, entry);
          node.hidden = !visible(entry);
          grid.append(node);
          imageObserver.observe(node);
          if (visible(entry)) added++;
        }
        const next = data.nextCursor;
        const advancing =
          typeof next === "string" &&
          next.length > 0 &&
          !seenCursors.has(next) &&
          next !== cursor;
        if (data.hasMore && advancing) {
          seenCursors.add(next);
          cursor = next;
          emptyPages = added ? 0 : emptyPages + 1;
          status.textContent = `${entries.size} loaded media activities · partial history. Scroll or load older photos.`;
          more.hidden = false;
          more.textContent = "Load older photos";
          if (emptyPages >= 5) {
            failed = true;
            status.textContent +=
              " Automatic paging paused after 5 empty pages; continue manually.";
          }
        } else {
          stopped = true;
          more.hidden = true;
          status.textContent = `${entries.size} loaded media activities · ${data.hasMore ? "paging stopped: server cursor did not advance" : "end of bounded server feed"}. Not a complete history.`;
        }
        pageSummary = status.textContent;
        settleImages();
      } catch (error) {
        if (live() && generation === scope) report(error, true);
      } finally {
        loading = false;
        more.disabled = false;
        if (live() && paneVisible() && generation !== scope) void page();
        else if (live() && paneVisible() && !stopped && !failed) {
          const rect = sentinel.getBoundingClientRect();
          if (rect.top < innerHeight + 300 && rect.bottom > -300) void page();
        }
      }
    }
    more.onclick = () => {
      failed = false;
      emptyPages = 0;
      more.textContent = "Load older photos";
      for (const entry of entries.values())
        if (visible(entry)) {
          if (entry.error) {
            entry.error = null;
            void hydrate(entry);
          }
          for (const frame of entry.frames || [])
            if (frame.error) {
              frame.error = null;
              imageObserver.observe(frame.button);
            }
        }
      void page();
    };
    filterGallery = () => {
      scope++;
      scopeController.abort();
      scopeController = new AbortController();
      window.CoachImageViewer?.close("gallery");
      for (const entry of entries.values()) {
        entry.node.hidden = !visible(entry);
        imageObserver.unobserve(entry.node);
        if (visible(entry) && !entry.done && !entry.error)
          imageObserver.observe(entry.node);
        for (const frame of entry.frames || []) {
          imageObserver.unobserve(frame.button);
          if (visible(entry) && !frame.url && !frame.error)
            imageObserver.observe(frame.button);
        }
      }
      // Selection changes which retained failures belong to the current view.
      // Reconcile without retrying details or replaying acquired photo bytes.
      settleImages();
    };
    clearGallery = () => {
      scope++;
      scopeController.abort();
      imageObserver.disconnect();
      pageObserver.disconnect();
      host.replaceChildren();
    };
    signal.addEventListener("abort", clearGallery, { once: true });
    pageObserver.observe(sentinel);
    void page();
  }
  async function load(_api, adminKey) {
    clear();
    controller = new AbortController();
    stats = window.CoachStats?.attach({
      host: $("dashboardStats"),
      request: (path, signal) =>
        dashboardFetch(path, {
          headers: { Authorization: "Bearer " + adminKey },
          signal,
          cache: "no-store",
          redirect: "error",
        }),
      getMembers: () =>
        [...mapMembers.values()].filter((m) => !suppressedMembers.has(m._id)),
      getSelected: () => selectedMember,
      onDenial: (id) => forgetMember(id),
    });
    loadRoster(adminKey);
    if ($("dashboardMapDate")?.type === "date") {
      const dateInput = $("dashboardMapDate");
      const today = new Date();
      dateInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      bindDateNavigation(adminKey);
      void loadMap(adminKey);
    }
    const id = epoch;
    const signal = controller.signal;
    const live = () => id === epoch && !signal.aborted;
    const request = async (path, binary = false, queuedSignal = signal) => {
      const response = await dashboardFetch(
        "/api/" + path,
        {
          headers: { Authorization: "Bearer " + adminKey },
          signal,
          cache: "no-store",
          redirect: "error",
        },
        queuedSignal,
      );
      if (!response.ok)
        throw httpError(
          denied(response)
            ? `REST request denied (${response.status}). Renew the saved Coach credential with ordinary REST access if needed.`
            : `REST request failed (${response.status}); try again shortly.`,
          response.status,
        );
      return binary ? response.blob() : response.json();
    };
    const details = new Map();
    const detailFor = (activityId) => {
      if (!details.has(activityId)) {
        const acquired = request(
          "dashboard/activity?" + new URLSearchParams({ id: activityId }),
        );
        details.set(activityId, acquired);
        acquired.catch(() => {
          if (details.get(activityId) === acquired) details.delete(activityId);
        });
      }
      return details.get(activityId);
    };
    const users = new Map(),
      activities = new Map(),
      series = new Map();
    let detailError = null;
    const revoked = new Set();
    forgetMember = (memberId) => {
      suppressedMembers.add(memberId);
      filterTimeline();
      syncMap();
      revoked.add(memberId);
      users.delete(memberId);
      feedMembers.delete(memberId);
      for (const [key, activity] of activities)
        if (activity.user_id === memberId) activities.delete(key);
      for (const [key, value] of series)
        if (value.member_id === memberId) series.delete(key);
      filterFeed();
    };
    const addPoint = (activity, label, unit, value, average = false) => {
      if (!Number.isFinite(value)) return;
      const stamp = activity.completed_at || activity.created_at;
      if (!stamp || !Number.isFinite(Date.parse(stamp))) return;
      const date = new Date(stamp).toISOString().slice(0, 10);
      const key = JSON.stringify([activity.user_id, label, unit]);
      if (!series.has(key))
        series.set(key, {
          member_id: activity.user_id,
          member_name: users.get(activity.user_id)?.display_name || "Member",
          label,
          unit,
          days: new Map(),
          average,
        });
      const days = series.get(key).days;
      const prior = days.get(date) || { sum: 0, count: 0 };
      days.set(date, { sum: prior.sum + value, count: prior.count + 1 });
    };
    function renderCharts() {
      const graphs = $("dashboardCharts");
      graphs.replaceChildren();
      graphs.append(
        text("h3", "Activity trends"),
        text(
          "p",
          "Loaded activities only, not a complete history or adherence. UTC completion day (creation-date fallback). Nutrition uses available recorded summaries; missing values are not zero. Weight uses explicit recorded units or verified Health Connect stored lb. Body fat is a photo-inferred range midpoint estimate, not a manual measurement.",
          "hint",
        ),
      );
      const grid = text("div", "", "dashboard-graphs");
      for (const s of series.values()) {
        if (selectedMember && s.member_id !== selectedMember) continue;
        grid.append(
          chart({
            ...s,
            points: [...s.days]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, p]) => ({
                date,
                value: s.average ? p.sum / p.count : p.sum,
              })),
          }),
        );
      }
      graphs.append(grid);
      if (!grid.childElementCount)
        graphs.append(
          text(
            "p",
            "Trend measurements unavailable in the loaded activities.",
            "hint",
          ),
        );
    }
    async function renderActivity(activity) {
      if (revoked.has(activity.user_id)) return;
      if (["complete", "completed"].includes(activity.status)) {
        if (activity.type === "workout") {
          addPoint(activity, "Completed workouts", "workouts", 1);
          addPoint(
            activity,
            "Completed sets",
            "sets",
            activity.workout_progress?.completed_sets,
          );
        }
        if (activity.type === "meal") {
          addPoint(activity, "Logged meals", "meals", 1);
          if (!activity.nutrition_summary_unavailable) {
            addPoint(
              activity,
              "Recorded calories",
              "kcal",
              activity.nutrition_summary?.calories,
            );
            addPoint(
              activity,
              "Recorded protein",
              "g",
              activity.nutrition_summary?.protein,
            );
          }
        }
      }
      if (
        !["media", "metric"].includes(activity.type) ||
        !["complete", "completed"].includes(activity.status)
      )
        return;
      // Feed files are preview refs, not complete inventories. Detail is a new
      // ordinary backend fetch, not a local sharing/source-proof decision.
      try {
        const envelope = await detailFor(activity._id);
        if (!live() || revoked.has(activity.user_id)) return;
        const detail = envelope?.activity;
        if (
          !detail ||
          detail._id !== activity._id ||
          detail.user_id !== activity.user_id ||
          detail.type !== activity.type ||
          envelope.owner?._id !== activity.user_id ||
          !detail.data ||
          typeof detail.data !== "object"
        )
          throw new Error("Invalid activity response.");
        if (!["complete", "completed"].includes(detail.status)) return;
        if (activity.type === "metric") {
          for (const m of Array.isArray(detail.data.measurements)
            ? detail.data.measurements
            : []) {
            let value = m?.value;
            if (
              typeof value === "string" &&
              value.length <= 20 &&
              /^[+]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())
            )
              value = Number(value.trim());
            if (
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value <= 0 ||
              value > 2000
            )
              continue;
            let unit = m.unit;
            let pointActivity = detail;
            if (
              m.type_id === "weight" &&
              ["kg", "lb", "lbs"].includes(unit) &&
              (unit !== "kg" || value <= 1000)
            ) {
              // Explicit recorded units remain distinct series.
            } else if (
              m.type_id === "weight" &&
              unit == null &&
              detail.source?.provider === "health_connect"
            ) {
              const leaf = m.health_connect;
              const stamp = detail.completed_at || detail.created_at;
              if (
                !stamp ||
                !Number.isFinite(Date.parse(stamp)) ||
                typeof leaf?.date !== "string" ||
                !/^\d{4}-\d{2}-\d{2}$/.test(leaf.date)
              )
                continue;
              const time = Date.parse(`${leaf.date}T00:00:00Z`);
              const day = new Date(stamp).toISOString().slice(0, 10);
              if (
                !Number.isFinite(time) ||
                new Date(time).toISOString().slice(0, 10) !== leaf.date ||
                Math.abs(time - Date.parse(`${day}T00:00:00Z`)) > 86400000 ||
                leaf.value !== m.value
              )
                continue;
              // The verified import stores converted lb, not source kg.
              unit = "lb";
              pointActivity = {
                ...detail,
                completed_at: `${leaf.date}T00:00:00Z`,
              };
            } else continue;
            addPoint(pointActivity, m.type_id, unit, value, true);
          }
          return;
        }
        // Match Stats' canonical photoBodyFatReadings semantics. REST serializes
        // its Date as a string; do not use best_estimate or manual fat metrics.
        const stamp = detail.completed_at || detail.created_at;
        if (
          detail.is_template !== true &&
          typeof stamp === "string" &&
          Number.isFinite(Date.parse(stamp))
        ) {
          for (const file of Array.isArray(detail.data.files)
            ? detail.data.files
            : []) {
            if (
              !(
                file?.type === "image" ||
                ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
                  file?.type,
                )
              ) ||
              file.isPlaceholder ||
              (file.inferenceStatus != null &&
                file.inferenceStatus !== "completed")
            )
              continue;
            const inferences = Array.isArray(file.inferences)
              ? file.inferences
              : [];
            const result = inferences.at(-1)?.result;
            const range =
              result?.estimated_body_fat_range || result?.estimated_body_fat;
            const namedFile = result?.photo_validation?.file_id;
            const sessionFiles = result?._session?.file_ids;
            if (
              (namedFile != null && String(namedFile) !== String(file._id)) ||
              (sessionFiles != null &&
                (!Array.isArray(sessionFiles) ||
                  !sessionFiles.map(String).includes(String(file._id)))) ||
              !range ||
              typeof range !== "object" ||
              Array.isArray(range)
            )
              continue;
            const valid = (n) =>
              typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 100;
            const number = (n) =>
              typeof n === "string" &&
              n.length <= 24 &&
              /^[+]?(?:\d+\.?\d*|\.\d+)$/.test(n.trim())
                ? Number(n.trim())
                : n;
            const lo = number(range.lower_bound),
              hi = number(range.upper_bound);
            if ((lo != null && !valid(lo)) || (hi != null && !valid(hi)))
              continue;
            const lower = lo ?? hi;
            const upper = hi ?? lo;
            if (
              !valid(lower) ||
              !valid(upper) ||
              lower > upper ||
              lower <= 1 !== upper <= 1
            )
              continue;
            const midpoint = (lower + upper) / 2;
            addPoint(
              detail,
              "Body fat (photo estimate)",
              "%",
              (midpoint * 100) / (midpoint > 1 ? 100 : 1),
              true,
            );
          }
        }
      } catch (error) {
        if (live()) {
          if (denied(error)) {
            // Fail closed: purge this member's cached detail-derived charts
            // and photos, and skip their later details this load. The map
            // snapshot may be stale too; drop it rather than retaining
            // coordinates after a fresh authorization denial.
            denyMember(activity.user_id);
            void loadMap(adminKey);
          }
          detailError ||= error.message;
          $("dashboardStatus").dataset.tone = "error";
          $("dashboardStatus").textContent =
            `Partial dashboard — activity details could not be loaded: ${detailError}`;
        }
      }
    }
    filterFeed = () => {
      if (!live()) return;
      renderCharts();
      filterGallery();
    };
    let before,
      loading = false;
    const more = text("button", "Load older activities", "secondary");
    async function page() {
      if (loading || !live()) return;
      loading = true;
      more.disabled = true;
      $("dashboardStatus").removeAttribute("data-tone");
      $("dashboardStatus").textContent = "Loading shared dashboard…";
      try {
        const data = await request(
          "dashboard" + (before ? "?" + new URLSearchParams({ before }) : ""),
        );
        if (!live()) return;
        if (!Array.isArray(data.users) || !Array.isArray(data.activities))
          throw new Error("Invalid feed response.");
        for (const user of data.users)
          if (!revoked.has(user._id)) users.set(user._id, user);
        feedMembers = users;
        renderMemberCards();
        filterMap(false);
        const added = [];
        for (const activity of data.activities) {
          if (revoked.has(activity.user_id)) continue;
          if (activities.has(activity._id)) continue;
          if (activities.size >= 200) break;
          activities.set(activity._id, activity);
          added.push(activity);
        }
        for (const activity of added) {
          await renderActivity(activity);
          if (!live()) return;
        }
        renderCharts();
        const next = data.oldestDate;
        const canLoad =
          data.hasMore &&
          typeof next === "string" &&
          next !== before &&
          activities.size < 200;
        before = next;
        more.hidden = !canLoad;
        if (detailError) $("dashboardStatus").dataset.tone = "error";
        else $("dashboardStatus").removeAttribute("data-tone");
        $("dashboardStatus").textContent = detailError
          ? `Partial dashboard — activity details could not be loaded: ${detailError}`
          : data.hasMore
            ? "More activities available — partial history shown."
            : "Loaded bounded feed history; not a complete history.";
        const coverage = $("dashboardCoverage");
        coverage.hidden = false;
        coverage.replaceChildren(
          text(
            "span",
            `${users.size} people in loaded feed · ${activities.size} loaded activities (200 activity limit). Not a complete roster. Gallery loads historical media independently.`,
          ),
        );
        if (activities.size >= 200)
          coverage.append(
            text(
              "span",
              "Display limit reached; use Coach for a narrower period.",
            ),
          );
      } catch (error) {
        if (live()) {
          $("dashboardStatus").dataset.tone = "error";
          $("dashboardStatus").textContent = error.message;
        }
      } finally {
        loading = false;
        more.disabled = false;
      }
    }
    more.addEventListener("click", () => void page());
    $("dashboardCharts").before(more);
    signal.addEventListener("abort", () => more.remove(), { once: true });
    startGallery({ request, detailFor, live, signal, users, revoked });
    await page();
  }
  return { clear, load };
})();
