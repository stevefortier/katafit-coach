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
  // True once the current map shows a day's events or the operator moved it;
  // only such a view is worth keeping across day changes.
  let mapViewSettled = false;
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
  // Retained member rail and its keyed cards (see renderMemberCards).
  let memberRail = null;
  let memberCards = new Map();
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
  let focusMapMember = () => {};
  let focusMapEvent = () => {};
  // The timeline's selected event category while its legend is shown.
  let timelineCategory = () => null;
  let forgetMember = () => {};
  // Latest known recorded GPS per member (dashboard scope, not the selected
  // day or category): memberId -> {latitude, longitude, captured_at, ...}.
  // This is a last recorded fix, never live tracking.
  let latestPositions = new Map();
  let renderLatest = () => {};
  let latestNote = "";
  // Members whose latest position could not be proven (bounded scan): never
  // shown as absence. Retry is a bounded, operator-initiated re-read.
  let latestIncomplete = [];
  let latestRetry = null;
  // Authority ordering: each read takes a sequence number when it starts and
  // each observed Position/scope denial takes one when it is applied, so a
  // positive response that started before a newer denial never resurrects.
  let authoritySeq = 0;
  const positionPrivateAt = new Map();
  let latestScopeDeniedAt = 0;
  // Ten minutes: at or under, a pin is fresh; strictly older is faded.
  const LATEST_FRESH_MS = 10 * 60 * 1000;
  // Camera focus never zooms past street level (OSM tiles stop at 19).
  const FOCUS_ZOOM = 18;
  // A deliberate focus flies there (pan and zoom together) in about this long.
  const FOCUS_FLIGHT_SECONDS = 0.5;
  // A repeated pointer activation of the same member card or event, keyed
  // to survive the re-render a first activation causes: the platform's click
  // count, or a quick nearby repeat for taps that do not count. Every repeat
  // counts, so a triple click still ends focused rather than re-selected.
  // Keyboard clicks (detail 0) never count: Shift+Enter is the equivalent.
  let lastActivation = null;
  function doubleActivation(key, event) {
    if (event.type === "click" && event.detail === 0) return false;
    const prior = lastActivation;
    lastActivation = {
      key,
      at: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
    };
    return (
      prior?.key === key &&
      (event.detail >= 2 ||
        (event.timeStamp - prior.at <= 500 &&
          Math.hypot(event.clientX - prior.x, event.clientY - prior.y) <= 24))
    );
  }
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
    memberRail = null;
    memberCards = new Map();
    selectedMember = null;
    mapMembers = new Map();
    feedMembers = new Map();
    rosterCache = null;
    rosterReady = Promise.resolve({ note: "" });
    latestPositions = new Map();
    latestNote = "";
    latestIncomplete = [];
    latestRetry = null;
    positionPrivateAt.clear();
    latestScopeDeniedAt = 0;
    renderLatest = () => {};
    avatarCache.clear();
    for (const url of avatarUrls.splice(0)) URL.revokeObjectURL(url);
    suppressedMembers.clear();
    filterFeed = () => {};
    filterMap = () => {};
    forgetMember = () => {};
    $("dashboardLatestStatus")?.replaceChildren();
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
    // Leaflet ends a zoom animation from a timer it never cancels; a map
    // removed mid-zoom must not run it on its removed panes.
    if (leafletMap) leafletMap._animatingZoom = false;
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
    // Cards are keyed by member and updated in place. Chromium drops a click
    // whose pressed node is removed or re-inserted before mouseup, so a roster
    // or feed arrival, a selection or another member's denial must never
    // replace or move a card it does not need to. The retained rail also keeps
    // its scroll position; the browser clamps it if a denial shrinks the rail.
    if (memberRail?.parentNode !== target) {
      target.replaceChildren();
      memberRail = text("div", "", "dashboard-member-rail");
      memberCards = new Map();
      target.append(memberRail);
    }
    const rail = memberRail;
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
    const setText = (node, value) => {
      if (node.textContent !== value) node.textContent = value;
      if (node.title !== value) node.title = value;
    };
    // Body-fat tooltip for one card; its listeners only read retained nodes.
    const makeInfo = (id) => {
      // A sibling native button keeps the member's selection button valid
      // and prevents pointer/keyboard provenance reads from selecting it.
      const info = text("button", "ⓘ", "dashboard-member-info");
      info.type = "button";
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
      return { info, tooltip, hide };
    };
    // Built once per member; listeners read only the stable id and current state.
    const makeCard = (id, all) => {
      const button = text(
        "button",
        "",
        all ? "dashboard-member-all" : "dashboard-member-card",
      );
      button.type = "button";
      const entry = all ? null : text("div", "", "dashboard-member-entry");
      entry?.append(button);
      const nameNode = text("strong", "");
      button.append(nameNode);
      const select = () => {
        selectedMember = id;
        selectionEpoch++;
        $("dashboardMapSelection")?.replaceChildren();
        highlightEvent(null);
        renderMemberCards();
        filterMap(true, all);
        filterFeed();
        filterTimeline();
        renderLatest();
      };
      button.addEventListener("click", (event) => {
        select();
        // Every surface of this member's selection button shares one gesture.
        if (!all && doubleActivation(`member:${id}`, event)) focusMapMember(id);
      });
      if (all)
        return {
          node: button,
          update: () => {
            button.setAttribute("aria-pressed", String(selectedMember === id));
            setText(nameNode, "Select\nAll");
          },
        };
      button.setAttribute("aria-keyshortcuts", "Shift+Enter");
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || !event.shiftKey) return;
        event.preventDefault();
        select();
        focusMapMember(id);
      });
      const portrait = text("span", "", "dashboard-member-portrait");
      portrait.dataset.memberId = id;
      const initials = document.createTextNode("");
      portrait.append(initials);
      button.prepend(portrait);
      const labels = ["Weight", "Height", "Body fat", "Age"];
      const rows = labels.map(() => button.appendChild(text("span", "")));
      let bodyFatInfo = null;
      const update = (user) => {
        button.setAttribute("aria-pressed", String(selectedMember === id));
        const name = user.display_name || "Member";
        setText(nameNode, name);
        const letters = (name.match(/[\p{L}\p{N}]+/gu) || ["M"])
          .slice(-2)
          .map((s) => s[0].toUpperCase())
          .join("");
        if (initials.data !== letters) initials.data = letters;
        // Keep the current authorized avatar only; a revoked or replaced URL
        // is removed at once.
        const avatar = avatarCache.get(id);
        let image = null;
        for (const node of portrait.querySelectorAll(":scope > img")) {
          if (!image && avatar && node.getAttribute("src") === avatar)
            image = node;
          else node.remove();
        }
        if (avatar && !image) {
          image = text("img", "", "dashboard-roster-image");
          image.alt = "";
          image.src = avatar;
          image.onerror = () => image.remove();
          portrait.prepend(image);
        }
        const stats = mapMembers.has(id) ? user.stats : undefined;
        const values = [
          stat(stats?.weight, "weight", 2000),
          stat(stats?.height_cm, "cm", 300),
          stat(
            stats?.body_fat_estimate?.source === "ai" &&
              stats?.body_fat_estimate?.estimated === true &&
              stats?.body_fat_estimate?.value === stats?.body_fat_percent
              ? stats.body_fat_percent
              : null,
            "%",
            100,
          ),
          stat(stats?.age_years, "", 130),
        ];
        labels.forEach((label, index) =>
          setText(rows[index], `${label}: ${values[index]}`),
        );
        const bodyFat = values[2] !== "Unavailable";
        if (bodyFat) rows[2].className = "dashboard-member-bodyfat";
        else rows[2].removeAttribute("class");
        if (bodyFat) {
          bodyFatInfo ||= makeInfo(id);
          bodyFatInfo.info.setAttribute(
            "aria-label",
            `About body fat estimate for ${name}`,
          );
          if (bodyFatInfo.info.parentNode !== entry)
            entry.append(bodyFatInfo.info, bodyFatInfo.tooltip);
        } else if (bodyFatInfo) {
          bodyFatInfo.hide();
          bodyFatInfo.info.remove();
          bodyFatInfo.tooltip.remove();
          bodyFatInfo = null;
        }
      };
      return { node: entry, update };
    };
    // Denied or departed members first, so no retained card is moved past them.
    for (const [id, card] of memberCards)
      if (id !== null && !members.has(id)) {
        card.node.remove();
        memberCards.delete(id);
      }
    let previous = null;
    for (const [id, user] of [[null, {}], ...members]) {
      let card = memberCards.get(id);
      if (!card) memberCards.set(id, (card = makeCard(id, id === null)));
      card.update(user);
      // Insert only new or out-of-order cards; never re-append one in place.
      const next = previous ? previous.nextSibling : rail.firstChild;
      if (next !== card.node) rail.insertBefore(card.node, next);
      previous = card.node;
    }
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
  // Position-only denial of the latest pin; the member's identity and
  // authorized photo stay (they are separately authorized by the roster).
  function withdrawLatest(memberId) {
    positionPrivateAt.set(memberId, ++authoritySeq);
    latestPositions.delete(memberId);
    renderLatest();
  }
  // Whole-dojo/roster/timeline denial: every latest pin, chooser and
  // association goes, and any read started earlier is discarded.
  function denyLatestScope(status) {
    latestScopeDeniedAt = ++authoritySeq;
    latestPositions = new Map();
    latestIncomplete = [];
    latestRetry = null;
    latestNote = `Latest known positions removed: dojo access denied${status ? ` (${status})` : ""}.`;
    renderLatest();
  }
  // A whole-dojo denial observed by the latest reader revokes the loaded day
  // too (the reverse of a timeline denial clearing latest): ledger, GPS,
  // selection/detail and choosers go, and a pending day read is discarded.
  // Only a fresh explicit reload (date change or dashboard reload) re-reads.
  function denyDojoScope(status) {
    denyLatestScope(status);
    timelineEpoch++;
    timelineController?.abort();
    timelinePending = false;
    ledgerFailure = status || 0;
    ledgerGeneration++;
    ledger = null;
    highlightEvent(null);
    selectionEpoch++;
    $("dashboardMapSelection")?.replaceChildren();
    timelineInteraction(false);
    timelineInteraction = () => {};
    filterTimeline = () => {};
    timelineResize?.disconnect();
    const target = $("dashboardTimeline");
    if (target) {
      delete target.dataset.date;
      const note = text(
        "p",
        `Timeline removed: dojo access denied${status ? ` (${status})` : ""}. Reload the dashboard or choose a date to reauthorize.`,
        "hint",
      );
      note.setAttribute("role", "status");
      target.replaceChildren(note);
    }
    syncMap();
  }
  function withholdMember(memberId) {
    withheldMembers.add(memberId);
    withdrawLatest(memberId);
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
    latestPositions.delete(memberId);
    filterTimeline();
    syncMap();
    renderLatest();
    renderMemberCards();
  }
  // One shared selected ledger event for map and timeline. Selection freshly
  // reauthorizes that exact event; subject detail is optional enrichment.
  // The timeline stays selectable without the map: absent a ledger, the day
  // window comes from the selected local date. `focus` (a timeline repeat
  // activation) moves the camera only after this exact read authorizes the
  // event and the selection is still current.
  async function selectEvent(
    item,
    adminKey,
    name = memberName(item.user_id),
    focus = false,
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
    if (focus) focusMapEvent(fresh);
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
  const EVENT_CATEGORIES = [
    "meal",
    "workout",
    "metric",
    "survey",
    "media",
    "app",
    "status_change",
  ];
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
    // The exact rendered mark under the pointer takes priority over the
    // coordinate's nearest event, so dense marks keep their identity. Marks at
    // the same instant stack exactly; that stack resolves to its first event,
    // as `nearest` does, whatever the z-order (twins remain keyboard reachable).
    const markItem = (node) => {
      const mark = node?.closest?.(".dashboard-timeline-mark");
      const hit =
        mark && !mark.hidden && track.contains(mark)
          ? items.get(mark.dataset.eventId)
          : null;
      if (!hit) return null;
      const at = Date.parse(hit.occurred_at);
      return (
        visibleItems().find((item) => Date.parse(item.occurred_at) === at) ||
        hit
      );
    };
    const pointed = (event) => markItem(event.target) || nearest(event.clientX);
    // A repeat activation of the same event asks for map focus, which waits
    // for that selection's fresh exact read (selectEvent) to authorize it.
    const activate = (item, event) => {
      if (!item || !interactive()) return;
      select(item, doubleActivation(`event:${item.id}`, event));
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
        // The touched mark, kept until the finger moves into a scrub.
        mark: markItem(event.target),
      };
      track.setPointerCapture(event.pointerId);
      if (gesture.mode === "scrub")
        preview(
          gesture.mark || nearest(event.clientX),
          event.clientX,
          event.clientY,
        );
      else dismiss();
      event.preventDefault();
    };
    track.onpointermove = (event) => {
      if (!interactive()) return;
      if (gesture?.id === event.pointerId) {
        if (gesture.mode === "pan")
          scroll.scrollLeft = gesture.left + gesture.x - event.clientX;
        else {
          if (Math.abs(event.clientX - gesture.x) > 10) gesture.mark = null;
          preview(
            gesture.mark || nearest(event.clientX),
            event.clientX,
            event.clientY,
          );
        }
      } else if (event.pointerType !== "touch")
        preview(pointed(event), event.clientX, event.clientY);
    };
    track.onpointerup = (event) => {
      if (gesture?.id !== event.pointerId) return;
      const item =
        gesture.mode === "scrub"
          ? gesture.mark || nearest(event.clientX)
          : null;
      cancelGesture();
      activate(item, event);
    };
    track.onpointercancel = () => {
      if (interactive()) cancelGesture();
    };
    track.onlostpointercapture = () => {
      if (interactive() && gesture) cancelGesture();
    };
    track.onclick = (event) => {
      if (event.detail === 0 || suppressPointerClick) return;
      activate(pointed(event), event);
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
    const select = (item, focus = false) => {
      if (!interactive() || !item) return;
      if (!visibleItems().some((event) => event.id === item.id)) return;
      void selectEvent(item, adminKey, name(item), focus);
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
        mark.setAttribute("aria-keyshortcuts", "Shift+Enter");
        mark.onkeydown = (event) => {
          if (event.key !== "Enter" || !event.shiftKey || !interactive())
            return;
          event.preventDefault();
          select(item, true);
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
    // The legend keeps every standard category, so changing day never reflows
    // the page; categories without events that day are shown disabled.
    const present = new Set([...items.values()].map(category));
    for (const type of [null, ...new Set([...EVENT_CATEGORIES, ...present])]) {
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
      chip.disabled = Boolean(type) && !present.has(type);
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
    timelineCategory = () => (scroll.isConnected ? selectedCategory : null);
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
    const authorityStart = ++authoritySeq;
    timelinePending = true;
    ledgerFailure = null;
    timelineInteraction(false);
    timelineController?.abort();
    timelineController = new AbortController();
    const signal = timelineController.signal,
      date = $("dashboardMapDate").value;
    const live = () => id === timelineEpoch && !signal.aborted;
    const [year, month, day] = validDay(date)
      ? date.split("-").map(Number)
      : [];
    const start = new Date(0);
    start.setFullYear(year, month - 1, day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    // Changed authority invalidates the retained inventory, not only its geometry.
    const replaced = target.dataset.date !== date || restarts;
    // Hold a shown timeline's shape with an empty, inert day while it loads.
    const placeholder =
      replaced &&
      validDay(date) &&
      Boolean(target.querySelector(".dashboard-timeline-track"));
    if (replaced) {
      target.replaceChildren();
      timelineInteraction = () => {};
      filterTimeline = () => {};
      if (placeholder) {
        renderEventTimeline(target, new Map(), new Map(), start, end, adminKey);
        timelineInteraction(false);
        timelineInteraction = () => {};
        filterTimeline = () => {};
      }
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
    const status = text(
      "p",
      "Loading authorized day events…",
      "hint dashboard-timeline-loading",
    );
    status.setAttribute("role", "status");
    target.append(status);
    if (!validDay(date)) {
      timelinePending = false;
      status.className = "hint";
      status.textContent = "Choose a valid event date.";
      return;
    }
    const users = new Map(resume?.users),
      items = resume?.items || new Map();
    let cursor = resume?.cursor,
      pages = 0;
    // Render loaded events; `failure` marks a transiently interrupted partial day.
    const publish = (failure = null) => {
      timelinePending = false;
      ledger = { date, start, end, items, users, complete: !cursor };
      status.className = "hint";
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
        if (!resume && pages === 0) {
          withheldMembers.clear();
          // A Position denial observed after this read began still holds.
          for (const [memberId, at] of positionPrivateAt)
            if (at > authorityStart) withheldMembers.add(memberId);
        }

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
      status.className = "hint";
      // A failed new day keeps no placeholder that could pass for an empty day.
      if (placeholder) target.replaceChildren(status);
      if (denied(error)) denyLatestScope(error.status);
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
            renderLatest();
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
          denyLatestScope(error.status);
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
    focusMapMember = () => {};
    focusMapEvent = () => {};
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
    // Another day (or a reload) keeps the view the operator was looking at
    // instead of flashing the world view while the new day loads.
    const keptView =
      leafletMap && mapViewSettled
        ? { center: leafletMap.getCenter(), zoom: leafletMap.getZoom() }
        : null;
    mapViewSettled = Boolean(keptView);
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
    // Neutral initial view; never request device location.
    if (keptView)
      instance.setView(keptView.center, keptView.zoom, { animate: false });
    else instance.setView([0, 0], 2);
    const overlay = text("div", "", "dashboard-map-overlay");
    // Markers are not Leaflet layers: their (double) activations must never
    // reach Leaflet's click handling or its double-click/double-tap zoom.
    for (const type of ["click", "dblclick"])
      overlay.addEventListener(type, (event) => event.stopPropagation());
    // A press that panned the map was a drag: like Leaflet does for its own
    // layers, its click never activates the mark that moved under the pointer.
    // Keyboard clicks (detail 0) never come from a drag.
    const dragClick = (event) => {
      if (event.detail && instance.dragging?.moved()) event.stopPropagation();
    };
    overlay.addEventListener("click", dragClick, true);
    // Latest known positions: a stable layer under the day's event dots,
    // independent of the selected day/category and of the timeline.
    const latestLayer = text("div", "", "dashboard-latest-overlay");
    latestLayer.setAttribute("role", "group");
    latestLayer.setAttribute(
      "aria-label",
      "Latest known recorded member positions (not live)",
    );
    for (const type of ["click", "dblclick"])
      latestLayer.addEventListener(type, (event) => event.stopPropagation());
    latestLayer.addEventListener("click", dragClick, true);
    map.append(latestLayer);
    map.append(overlay);
    // Native map motion. Each overlay lays its marks out at exact container
    // pixels for one view (its frame). Leaflet's pan, pinch and resize then
    // move the whole overlay with one shared transform relative to that
    // frame (marks counter-scale to keep their CSS size), so a gesture frame
    // writes O(1) styles plus marks crossing the viewport edge or another
    // world copy. A zoom animation moves each mark once, like Leaflet's own
    // markers, on the tiles' CSS transition. Settling re-lays out exactly.
    const viewOrigin = () =>
      instance
        .getPixelOrigin()
        .add(instance.containerPointToLayerPoint([0, 0]));
    const copyShift = (lng, near) => 360 * Math.round((near - lng) / 360);
    // worldCopyJump may move the whole view by whole worlds (shift); the
    // transform absorbs that so marks stay in their frame's world copy.
    const frameTransform = (frame, zoom, origin, lng) => {
      const s = instance.getZoomScale(zoom, frame.zoom),
        shift = copyShift(frame.lng, lng);
      return {
        s,
        shift,
        x: s * (frame.origin.x + (shift / 360) * frame.world) - origin.x,
        y: s * frame.origin.y - origin.y,
      };
    };
    // Leaflet's zoom transition (leaflet.css .leaflet-zoom-anim).
    const ZOOM_MS = 250,
      ZOOM_EASE = "cubic-bezier(0, 0, 0.25, 1)";
    const zoomAnimating = () =>
      !!instance.getPane("mapPane")?.classList.contains("leaflet-zoom-anim");
    // One clock for this map's zoom animation. Every tile level, Leaflet
    // marker and overlay mark runs its own CSS transform transition, and the
    // browser resolves each start independently, so one level can start a
    // frame after another and paint the same place elsewhere. Once every
    // zoomanim handler has written its target (the transitions then exist,
    // still pending), all of them start at the zoomanim frame; marks joining
    // mid-zoom use the same instant.
    let zoomStart = null;
    instance.on("zoomanim", () => {
      zoomStart = document.timeline.currentTime;
      queueMicrotask(() => {
        for (const running of map.getAnimations({ subtree: true }))
          if (["transform", "translate"].includes(running.transitionProperty))
            running.startTime = zoomStart;
      });
    });
    const motionLayer = (
      layer,
      margin,
      extra = () => false,
      svg = () => null,
    ) => {
      // One animation state per layer: the frame marks are laid out in, and
      // while Leaflet's zoom animation paints, its start transform, target
      // transform and clock. Any layout during that animation keeps all of
      // them: marks are placed in the start frame and join the running
      // animation, so a data or authority change never jumps to the target.
      const state = { frame: null, anim: null, transform: "", scale: 1 };
      let marks = [];
      // Nodes carrying an animation translate (or svg transform) to clear on
      // settle, whichever mark object owns them by then; their travel and
      // the animation that joined them to Leaflet's zoom.
      const moved = new Set(),
        traveling = new WeakMap(),
        joined = new WeakMap();
      const outside = (t, mark, size) => {
        const x = t.s * mark.x + t.x,
          y = t.s * mark.y + t.y;
        return (
          x < -margin ||
          x > size.x + margin ||
          y < -margin ||
          y > size.y + margin
        );
      };
      const apply = (t) => {
        const transform =
          t.s === 1 && !t.x && !t.y
            ? ""
            : `translate(${t.x}px, ${t.y}px) scale(${t.s})`;
        if (transform !== state.transform) {
          state.transform = transform;
          layer.style.transform = transform;
        }
        if (t.s !== state.scale) {
          state.scale = t.s;
          if (t.s === 1) layer.style.removeProperty("--dashboard-map-unscale");
          else layer.style.setProperty("--dashboard-map-unscale", `${1 / t.s}`);
        }
      };
      const position = (mark) => {
        if (mark.left !== mark.x) {
          mark.left = mark.x;
          mark.node.style.left = `${mark.x}px`;
        }
        if (mark.top !== mark.y) {
          mark.top = mark.y;
          mark.node.style.top = `${mark.y}px`;
        }
      };
      const capture = () => {
        const zoom = instance.getZoom();
        return {
          zoom,
          lng: instance.getCenter().lng,
          origin: viewOrigin(),
          world:
            instance.project([0, 180], zoom).x -
            instance.project([0, -180], zoom).x,
        };
      };
      const now = () =>
        state.frame &&
        frameTransform(
          state.frame,
          instance.getZoom(),
          viewOrigin(),
          instance.getCenter().lng,
        );
      // A mark's travel (in the layer's start-scaled pixels) from its start
      // to its target position during the animation.
      const travel = (mark) => {
        const { t, target } = state.anim;
        return `${(target.s * mark.x + target.x - (t.s * mark.x + t.x)) / t.s}px ${(target.s * mark.y + target.y - (t.s * mark.y + t.y)) / t.s}px`;
      };
      const sweep = () => {
        const { t, target } = state.anim;
        return `translate(${(target.x - t.x) / t.s}px, ${(target.y - t.y) / t.s}px) scale(${target.s / t.s})`;
      };
      // Join the running zoom: identical easing, duration and start (the
      // map's zoom clock), so the node is where a mark laid out at the
      // animation's start would be.
      const join = (node, property, value) => {
        moved.add(node);
        // No CSS transition: the replaced one stops at this style change.
        node.style.transition = "none";
        node.style[property] = value;
        joined.get(node)?.cancel();
        const from =
          property === "translate" ? "0px 0px" : "translate(0px, 0px) scale(1)";
        const running = node.animate(
          [{ [property]: from }, { [property]: value }],
          { duration: ZOOM_MS, easing: ZOOM_EASE },
        );
        running.startTime = zoomStart;
        joined.set(node, running);
        traveling.set(node, value);
      };
      const settle = () => {
        for (const node of moved) {
          joined.get(node)?.cancel();
          joined.delete(node);
          traveling.delete(node);
          node.style.transition = "";
          node.style.translate = "";
          if (node instanceof SVGElement) node.style.transform = "";
        }
        moved.clear();
      };
      const motion = {
        marks: () => marks,
        // Change visibility only where it changed: hidden by the owner's
        // rule, or outside the map at both the current and target view.
        // During a zoom animation that is its start and target transforms,
        // and a revealed mark joins the animation in flight.
        cull(t = state.anim?.t || now(), target = state.anim?.target || null) {
          if (!t) return;
          const size = instance.getSize(),
            revealed = [];
          for (const mark of marks) {
            const hidden =
              extra(mark) ||
              (outside(t, mark, size) &&
                (!target || outside(target, mark, size)));
            if (mark.node.hidden === hidden) continue;
            mark.node.hidden = hidden;
            if (!hidden && state.anim) revealed.push(mark);
          }
          if (!state.anim || !zoomAnimating()) return;
          const idle = revealed.filter(
            (mark) => !mark.node.getAnimations().length,
          );
          for (const mark of idle) join(mark.node, "translate", travel(mark));
        },
        // Unrounded container pixels in the current frame, at the world copy
        // nearest `near` (latLngToContainerPoint rounds, which scaling
        // during a pinch would magnify).
        at(fix, near) {
          return instance
            .project(
              [fix.latitude, fix.longitude + copyShift(fix.longitude, near)],
              state.frame.zoom,
            )
            .subtract(state.frame.origin);
        },
        // Exact container pixels at the current view (nearest world copy).
        // While Leaflet's zoom animation paints, Leaflet already reports its
        // target view, but the screen still shows the animation: marks are
        // laid out in the animation's start frame instead and join it.
        layout(next = marks, after = () => {}) {
          marks = next;
          if (state.anim && zoomAnimating()) return motion.relayout(after);
          state.frame = capture();
          const center = state.frame.lng;
          state.anim = null;
          settle();
          apply({ s: 1, x: 0, y: 0 });
          for (const mark of marks) {
            mark.k = copyShift(mark.fix.longitude, center);
            const point = motion.at(mark.fix, center);
            mark.x = point.x;
            mark.y = point.y;
            position(mark);
          }
          after(center);
          motion.cull();
        },
        relayout(after) {
          const { target, lng } = state.anim;
          // Marks wrap to the world copy nearest the animation's target.
          for (const mark of marks) {
            mark.k = copyShift(mark.fix.longitude, lng) - target.shift;
            const point = instance
              .project(
                [mark.fix.latitude, mark.fix.longitude + mark.k],
                state.frame.zoom,
              )
              .subtract(state.frame.origin);
            mark.x = point.x;
            mark.y = point.y;
            mark.travel = travel(mark);
          }
          // Read every running animation before any write (one style flush).
          const idle = marks.map(
            (mark) =>
              traveling.get(mark.node) !== mark.travel ||
              !mark.node.getAnimations().length,
          );
          const paths = svg(),
            sweeping = paths && sweep(),
            redraw =
              paths &&
              (traveling.get(paths) !== sweeping ||
                !paths.getAnimations().length);
          marks.forEach((mark, i) => {
            position(mark);
            if (idle[i]) join(mark.node, "translate", mark.travel);
          });
          after(lng);
          if (redraw) join(paths, "transform", sweeping);
          motion.cull();
        },
        // One shared transform per native move; marks are rewritten only to
        // wrap to the world copy nearest the view.
        follow(shifted = () => {}) {
          if (!state.frame || state.anim) return;
          const t = now();
          apply(t);
          const center = instance.getCenter().lng;
          for (const mark of marks) {
            const k = copyShift(mark.fix.longitude, center) - t.shift;
            if (k === mark.k) continue;
            mark.x += ((k - mark.k) / 360) * state.frame.world;
            mark.k = k;
            position(mark);
            shifted(mark);
          }
          motion.cull(t);
        },
        // A focus flight changes zoom continuously over many levels; one
        // shared scale far from the layout frame would magnify the browser's
        // layout rounding of each mark (1/64px) into visible drift, so each
        // whole level travelled re-lays out exactly instead.
        drifted() {
          return (
            !!state.frame &&
            !state.anim &&
            Math.abs(instance.getZoom() - state.frame.zoom) >= 1
          );
        },
        // Leaflet's zoomanim fires before the map moves to its target view.
        animate(event) {
          if (!state.frame) state.frame = capture();
          const t = state.anim?.t || now();
          const size = instance.getSize(),
            layerZero = instance.containerPointToLayerPoint([0, 0]);
          const target = frameTransform(
            state.frame,
            event.zoom,
            instance
              .project(event.center, event.zoom)
              .subtract(size.divideBy(2))
              .subtract(layerZero)
              .round()
              .add(layerZero),
            event.center.lng,
          );
          apply(t);
          state.anim = { t, target, lng: event.center.lng };
          // Marks entering the view get a painted start before they move.
          let shown = false;
          for (const mark of marks)
            if (
              mark.node.hidden &&
              !extra(mark) &&
              !(outside(t, mark, size) && outside(target, mark, size))
            ) {
              mark.node.hidden = false;
              shown = true;
            }
          if (shown) void layer.offsetWidth;
          for (const mark of marks) {
            moved.add(mark.node);
            mark.travel = travel(mark);
            traveling.set(mark.node, mark.travel);
            mark.node.style.translate = mark.travel;
          }
          const paths = svg();
          if (paths) {
            moved.add(paths);
            traveling.set(paths, sweep());
            paths.style.transform = traveling.get(paths);
          }
          motion.cull(t, target);
        },
        // The current on-screen container point of a laid-out mark.
        point(mark) {
          const t = now() || { s: 1, x: 0, y: 0 };
          return { x: t.s * mark.x + t.x, y: t.s * mark.y + t.y };
        },
      };
      return motion;
    };
    const latestCaption = text("p", "", "dashboard-latest-caption");
    latestCaption.setAttribute("aria-live", "polite");
    // Keep warnings and Retry outside the geographic hit area: an error must
    // never cover event dots or latest-position photo pins.
    const latestStatus = $("dashboardLatestStatus");
    if (latestStatus) latestStatus.replaceChildren(latestCaption);
    const latestChooser = text("div", "", "dashboard-latest-chooser");
    latestChooser.hidden = true;
    latestChooser.setAttribute("role", "group");
    latestChooser.setAttribute(
      "aria-label",
      "Members whose latest known positions overlap here",
    );
    for (const type of ["click", "dblclick"])
      latestChooser.addEventListener(type, (event) => event.stopPropagation());
    map.append(latestChooser);
    const ageText = (ms) => {
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return "just now";
      if (minutes < 60) return `${minutes} min ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return `${hours} h ago`;
      return `${Math.floor(hours / 24)} days ago`;
    };
    // Age from the validated capture instant only, re-evaluated against the
    // device clock; a capture ahead of the clock is shown as such, never "fresh".
    const latestAge = (fix) => {
      const age = Date.now() - Date.parse(fix.captured_at);
      if (age < -60000)
        return { fresh: false, note: "capture time is ahead of this device" };
      if (age <= LATEST_FRESH_MS)
        return { fresh: true, note: ageText(Math.max(0, age)) };
      return { fresh: false, note: ageText(age) };
    };
    const latestName = (memberId) =>
      mapMembers.get(memberId)?.display_name ||
      latestPositions.get(memberId)?.display_name ||
      "Member";
    const latestInitials = (name) =>
      (name.match(/[\p{L}\p{N}]+/gu) || ["M"])
        .slice(-2)
        .map((s) => s[0].toUpperCase())
        .join("");
    // One member's own round photo (or initials); never another member's.
    const latestPhoto = (memberId) => {
      const photo = text("span", "", "dashboard-latest-photo");
      const url = avatarCache.get(memberId);
      if (url) {
        const image = text("img", "", "dashboard-latest-image");
        image.alt = "";
        image.src = url;
        image.onerror = () => {
          image.remove();
          photo.textContent = latestInitials(latestName(memberId));
        };
        photo.append(image);
      } else photo.textContent = latestInitials(latestName(memberId));
      return photo;
    };
    const latestLabel = (memberId, fix) =>
      `${latestName(memberId)}, latest known position recorded ${latestAge(fix).note} (${new Date(fix.captured_at).toLocaleString()})`;
    const selectFromPin = (memberId) => {
      // Ordinary selection: identical to a member card, never the camera.
      selectedMember = memberId;
      selectionEpoch++;
      $("dashboardMapSelection")?.replaceChildren();
      highlightEvent(null);
      renderMemberCards();
      filterMap(true, false);
      filterFeed();
      filterTimeline();
      renderLatest();
    };
    // The latest pin explicitly focused, valid until the next deliberate
    // camera change (cameraEpoch); resizes and day publication keep it.
    let latestFocus = null;
    const latestFocusHeld = () =>
      !!latestFocus && latestFocus.epoch === cameraEpoch;
    // The one deliberate focus still steering the camera (requested by a
    // double activation or Shift+Enter), until the camera arrives. Its
    // target is re-derived from current state (`resolve` re-checks
    // selection, filter, ledger and denial; captured coordinates are never
    // reused). Any other camera change, navigation, selection, date or
    // authority change retires it at once: the camera stays where painted.
    let focusing = null;
    const focusCurrent = (intent) =>
      live() &&
      intent.epoch === cameraEpoch &&
      intent.choice === selectionEpoch &&
      (!intent.ledger || intent.generation === ledgerGeneration)
        ? intent.resolve() || null
        : null;
    // `failed`: the target is gone (denied, deselected, unloaded), so its
    // note and held latest focus go too; otherwise something deliberate
    // superseded it, which owns the camera from here. `ended`: that camera
    // write already stopped the flight and ended the movement.
    const retireFocus = (failed = false, ended = false) => {
      const intent = focusing;
      if (!intent) return;
      focusing = null;
      if (intent.flying && !ended) {
        // Stop where the camera is painted and end the movement like Leaflet
        // ends its own (world-copy width, latest grouping, exact layout); a
        // native zoom that interrupted it ends the movement itself.
        instance._stop();
        if (!zoomAnimating()) instance._moveEnd(true);
      }
      if (failed && latestFocus?.epoch === intent.epoch) latestFocus = null;
      if (failed || intent.flying) {
        focusNote = "";
        showStatus();
      }
    };
    // Reduced motion, or a camera already there, jumps; otherwise one native
    // Leaflet flight (pan and zoom together) from the painted view.
    const flyCamera = (center, zoom, instant) => {
      const here = instance.getZoom();
      const there =
        Math.abs(here - zoom) < 1e-6 &&
        instance
          .project(instance.getCenter(), zoom)
          .distanceTo(instance.project(center, zoom)) < 0.5;
      if (
        instant ||
        there ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        instance.setView(center, zoom, { animate: false });
        return false;
      }
      instance.flyTo(center, zoom, { duration: FOCUS_FLIGHT_SECONDS });
      return true;
    };
    // Start (or, when its current target changed mid-flight, restart from
    // the painted view) the flight of this intent.
    const steerFocus = (intent) => {
      if (focusing !== intent) return;
      const target = focusCurrent(intent);
      if (!target) return retireFocus(true);
      const key = JSON.stringify(target);
      if (intent.flying && key === intent.key) return;
      intent.key = key;
      const { center, zoom } = intent.view(target);
      intent.to = { center, zoom };
      focusNote = intent.note(target);
      intent.flying = flyCamera(center, zoom, intent.instant);
      if (!intent.flying) focusing = null;
      showStatus();
    };
    // Every rerender after a state change re-checks the flight.
    const checkFocus = () => {
      const intent = focusing;
      if (!intent) return;
      if (!focusCurrent(intent)) retireFocus(true);
      else if (intent.flying) steerFocus(intent);
    };
    // Leaflet ends a flight with zoomend at its target. Any other zoomend
    // during it is a camera write that stopped it (setView stops a flight),
    // whichever handler runs first.
    instance.on("zoomend", () => {
      const intent = focusing;
      if (!intent?.flying) return;
      const { center, zoom } = intent.to;
      if (
        Math.abs(instance.getZoom() - zoom) < 1e-6 &&
        instance
          .project(instance.getCenter(), zoom)
          .distanceTo(instance.project(center, zoom)) < 0.5
      )
        focusing = null;
      else retireFocus(false, true);
    });
    const focusCamera = ({ resolve, view, note, latest, ledger, instant }) => {
      markUserView();
      const intent = {
        epoch: cameraEpoch,
        choice: selectionEpoch,
        generation: ledgerGeneration,
        ledger: !!ledger,
        resolve,
        view,
        note,
        instant: !!instant,
        flying: false,
        key: null,
      };
      focusing = intent;
      if (latest) latestFocus = { memberId: latest, epoch: cameraEpoch };
      // Leaflet drops a view change requested during a zoom animation (a
      // wheel zoom still settling) and its end overwrites one set meanwhile:
      // the focus starts once that animation ends.
      if (zoomAnimating()) instance.once("zoomend", () => steerFocus(intent));
      else steerFocus(intent);
    };
    // An exact recorded point at street level, in the world copy nearest
    // the view.
    const pointView = (point) => {
      const near = instance.getCenter().lng;
      return {
        center: L.latLng(
          point.latitude,
          point.longitude + 360 * Math.round((near - point.longitude) / 360),
        ),
        zoom: FOCUS_ZOOM,
      };
    };
    // Explicit focus follows the established camera protocol (focusCamera):
    // a deliberate view, FOCUS_ZOOM, the world copy nearest the view, and
    // re-derivation from current authority until the camera arrives.
    const focusLatest = (memberId) => {
      if (!live()) return;
      const current = () =>
        selectedMember === memberId &&
        !suppressedMembers.has(memberId) &&
        latestPositions.get(memberId);
      if (!current()) return;
      focusCamera({
        resolve: current,
        view: pointView,
        note: () =>
          `Map centered on ${latestName(memberId)}'s latest known recorded position (not live).`,
        latest: memberId,
      });
    };
    let latestPins = [];
    const latestProject = (fix, near) =>
      instance.latLngToContainerPoint([
        fix.latitude,
        fix.longitude + 360 * Math.round((near - fix.longitude) / 360),
      ]);
    const latestMotion = motionLayer(latestLayer, 24);
    let chooserIds = null;
    const closeLatestChooser = () => {
      chooserIds = null;
      latestChooser.hidden = true;
      latestChooser.replaceChildren();
    };
    const latestOwner = () =>
      chooserIds &&
      latestPins.find((pin) =>
        pin.group.some((g) => g.memberId === chooserIds[0]),
      )?.node;
    // Kept inside the map: a narrow map or an edge anchor never clips a choice.
    const placeLatestChooser = (owner) => {
      const pin = latestPins.find((p) => p.node === owner);
      const { x, y } = pin ? latestMotion.point(pin) : { x: 0, y: 0 };
      const w = latestChooser.offsetWidth,
        h = latestChooser.offsetHeight;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      latestChooser.style.left = `${clamp(x - w / 2, 4, Math.max(4, map.clientWidth - w - 4))}px`;
      const below = y + 8;
      latestChooser.style.top = `${clamp(below + h <= map.clientHeight - 4 ? below : y - 64 - h, 4, Math.max(4, map.clientHeight - h - 4))}px`;
    };
    const openLatestChooser = (group, owner, focusId = null) => {
      latestChooser.replaceChildren();
      chooserIds = group.map((g) => g.memberId);
      for (const { memberId, fix } of group) {
        const { fresh, note } = latestAge(fix);
        const choice = text("button", "", "dashboard-latest-choice");
        choice.type = "button";
        choice.dataset.memberId = memberId;
        choice.classList.toggle("dashboard-latest-stale", !fresh);
        choice.classList.toggle(
          "dashboard-latest-unselected",
          !latestSelected(memberId),
        );
        choice.setAttribute("aria-label", latestLabel(memberId, fix));
        choice.setAttribute("aria-keyshortcuts", "Shift+Enter");
        choice.title = latestLabel(memberId, fix);
        const words = text("span", "", "dashboard-latest-choice-text");
        words.append(
          text("span", latestName(memberId), "dashboard-latest-choice-name"),
          text("span", note, "dashboard-latest-choice-age"),
        );
        choice.append(latestPhoto(memberId), words);
        choice.addEventListener("click", (event) => {
          const repeat = doubleActivation(`latest:${memberId}`, event);
          closeLatestChooser();
          selectFromPin(memberId);
          if (repeat) focusLatest(memberId);
        });
        choice.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            const node = latestOwner();
            closeLatestChooser();
            node?.focus({ preventScroll: true });
          } else if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            closeLatestChooser();
            selectFromPin(memberId);
            focusLatest(memberId);
          } else if (
            ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            const choices = [...latestChooser.querySelectorAll("button")];
            const step = ["ArrowDown", "ArrowRight"].includes(event.key)
              ? 1
              : -1;
            choices[
              Math.max(
                0,
                Math.min(choices.length - 1, choices.indexOf(choice) + step),
              )
            ]?.focus({ preventScroll: true });
          }
        });
        latestChooser.append(choice);
      }
      latestChooser.hidden = false;
      placeLatestChooser(owner);
      (
        (focusId &&
          latestChooser.querySelector(`[data-member-id="${focusId}"]`)) ||
        (focusId === null && latestChooser.querySelector("button"))
      )?.focus({ preventScroll: true });
    };
    // Exact coordinates are the anchor; pins whose anchors would overlap on
    // screen share one neutral aggregate marker and a chooser listing every
    // identity with its own photo, age and selection state.
    const placeLatest = () => {
      if (live()) latestMotion.layout(latestPins);
    };
    // Every member is selected under All; otherwise only the chosen member.
    const latestSelected = (memberId) =>
      !selectedMember || selectedMember === memberId;
    // Appearance follows selection only; age is the written note.
    const ageLatest = () => {
      if (!live()) return;
      for (const pin of latestPins) {
        pin.node.classList.toggle(
          "dashboard-latest-unselected",
          !pin.group.some(({ memberId }) => latestSelected(memberId)),
        );
        const ages = pin.group.map(({ fix }) => latestAge(fix));
        const stale = ages.filter((a) => !a.fresh).length;
        const labels = pin.group.map(({ memberId, fix }) =>
          latestLabel(memberId, fix),
        );
        pin.node.classList.toggle(
          "dashboard-latest-stale",
          stale === pin.group.length,
        );
        pin.node.classList.toggle(
          "dashboard-latest-mixed",
          stale > 0 && stale < pin.group.length,
        );
        pin.age.textContent =
          pin.group.length === 1
            ? ages[0].note
            : stale === pin.group.length
              ? "all older"
              : stale
                ? `${stale} older`
                : "";
        pin.age.hidden = !pin.age.textContent;
        pin.node.setAttribute(
          "aria-label",
          pin.group.length === 1
            ? labels[0]
            : `${pin.group.length} members' latest known positions overlap here${stale ? `, ${stale} older than ten minutes` : ""}: ${labels.join("; ")}`,
        );
        pin.node.title = labels.join("\n");
      }
      for (const choice of latestChooser.querySelectorAll("button")) {
        const fix = latestPositions.get(choice.dataset.memberId);
        if (!fix) continue;
        const { fresh, note } = latestAge(fix);
        choice.classList.toggle("dashboard-latest-stale", !fresh);
        choice.classList.toggle(
          "dashboard-latest-unselected",
          !latestSelected(choice.dataset.memberId),
        );
        choice.querySelector(".dashboard-latest-choice-age").textContent = note;
      }
    };
    // Pins eligible for display (scope and denial); every authorized member
    // stays shown whichever member is selected.
    const latestShown = () =>
      [...latestPositions]
        .filter(([memberId]) => !suppressedMembers.has(memberId))
        .map(([memberId, fix]) => ({ memberId, fix }));
    const latestCaptionText = text("span", "");
    latestCaption.append(latestCaptionText);
    // One pin node; handlers read the pin's current group.
    const latestPin = (single, group) => {
      const node = text("button", "", "dashboard-latest-pin");
      node.type = "button";
      node.dataset.memberIds = group.map((g) => g.memberId).join(" ");
      if (single) {
        node.setAttribute("aria-keyshortcuts", "Shift+Enter");
        node.append(latestPhoto(single));
      } else {
        node.classList.add("dashboard-latest-group");
        node.setAttribute("aria-haspopup", "true");
        node.append(
          text(
            "span",
            `${group.length}`,
            "dashboard-latest-photo dashboard-latest-aggregate",
          ),
        );
      }
      const age = text("span", "", "dashboard-latest-age");
      node.append(age);
      const pin = { node, age, group };
      node.addEventListener("click", (event) => {
        if (!single) return openLatestChooser(pin.group, node);
        selectFromPin(single);
        if (doubleActivation(`latest:${single}`, event)) focusLatest(single);
      });
      node.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || !event.shiftKey) return;
        event.preventDefault();
        if (!single) return openLatestChooser(pin.group, node);
        selectFromPin(single);
        focusLatest(single);
      });
      return pin;
    };
    renderLatest = () => {
      if (!live()) return;
      checkFocus();
      const reopen = chooserIds,
        focused = latestChooser.contains(document.activeElement)
          ? document.activeElement.dataset.memberId
          : undefined;
      closeLatestChooser();
      latestCaptionText.textContent = latestNote;
      latestCaption.querySelector("button")?.remove();
      if (latestRetry) {
        const retry = text("button", "Retry latest positions", "secondary");
        retry.type = "button";
        retry.onclick = () => latestRetry?.();
        latestCaption.append(retry);
      }
      latestCaption.hidden = !latestNote;
      const center = instance.getCenter().lng;
      const groups = [];
      for (const item of latestShown()) {
        const point = latestProject(item.fix, center);
        const near = groups.find(
          (g) => Math.hypot(g.point.x - point.x, g.point.y - point.y) < 36,
        );
        if (near) near.group.push(item);
        else groups.push({ point, group: [item], anchor: item.fix });
      }
      // Unchanged pins keep their nodes: selection, regrouping and avatar
      // arrival never replace a pressed or focused pin.
      const previous = new Map(latestPins.map((pin) => [pin.key, pin]));
      latestPins = groups.map(({ group, anchor }) => {
        const single = group.length === 1 ? group[0].memberId : null;
        const key = single
          ? `${single}\n${avatarCache.get(single) || ""}\n${latestName(single)}`
          : group.map((g) => g.memberId).join(" ");
        const kept = previous.get(key);
        previous.delete(key);
        const pin = kept || latestPin(single, group);
        pin.key = key;
        pin.group = group;
        pin.fix = anchor;
        return pin;
      });
      for (const pin of previous.values()) pin.node.remove();
      latestPins.forEach(({ node }, i) => {
        const at = latestLayer.children[i];
        if (at !== node) latestLayer.insertBefore(node, at || null);
      });
      placeLatest();
      ageLatest();
      // Async avatar arrival or a denial keeps an open chooser truthful.
      if (reopen) {
        const pin = latestPins.find(
          (p) =>
            p.group.length > 1 &&
            p.group.some((g) => reopen.includes(g.memberId)),
        );
        if (pin) openLatestChooser(pin.group, pin.node, focused);
      }
    };
    instance.on("move zoom resize", (event) => {
      if (!live()) return;
      if (event.flyTo && latestMotion.drifted()) placeLatest();
      else latestMotion.follow();
    });
    instance.on("zoomanim", (event) => live() && latestMotion.animate(event));
    instance.on("movestart zoomstart resize", closeLatestChooser);
    // Regroup only when the scale changes; panning keeps anchors and groups.
    instance.on("zoomend", () => renderLatest());
    instance.on("moveend", placeLatest);
    // One shared clock for all pins (no per-member timers or polling); a
    // hidden tab re-evaluates as soon as it is visible again.
    const latestTimer = setInterval(ageLatest, 15000);
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") ageLatest();
      },
      { signal },
    );
    window.addEventListener("pageshow", ageLatest, { signal });
    signal.addEventListener("abort", () => clearInterval(latestTimer), {
      once: true,
    });
    // Initial all-members framing (and what All restores): the union of the
    // selected day's fixes and the latest member fixes, independent of the
    // current member selection. Never applied over a kept/deliberate view.
    const defaultFrame = () => [
      ...dots,
      ...[...latestPositions]
        .filter(([memberId]) => !suppressedMembers.has(memberId))
        .map(([, fix]) => ({ fix })),
    ];
    const frameDefault = () => {
      if (!live() || keptView || userViewChanged || latestFocusHeld()) return;
      const points = defaultFrame();
      if (!points.length) return;
      fitPins(points);
      mapViewSettled = true;
      initialView = { center: instance.getCenter(), zoom: instance.getZoom() };
    };
    const LATEST_SHAPE = /^[0-9a-f]{24}$/;
    const parseLatest = (body) => {
      if (!body || typeof body !== "object" || !Array.isArray(body.members))
        throw new Error("Invalid latest positions.");
      return body.members.map((m) => {
        const p = m?.latest;
        const ok =
          typeof m?.user_id === "string" &&
          LATEST_SHAPE.test(m.user_id) &&
          (m.status === "located"
            ? p &&
              Number.isFinite(p.latitude) &&
              Math.abs(p.latitude) <= 90 &&
              Number.isFinite(p.longitude) &&
              Math.abs(p.longitude) <= 180 &&
              typeof p.captured_at === "string" &&
              Number.isFinite(Date.parse(p.captured_at))
            : ["none", "private", "incomplete"].includes(m.status) &&
              m.latest === null);
        // A malformed 200 is not renewed authority: the whole read fails.
        if (!ok) throw new Error("Invalid latest positions.");
        return m;
      });
    };
    // One read per dashboard/day load or explicit Retry (no polling), through
    // the shared dashboard read admission; latest stays independent of the
    // selected day/category.
    const loadLatest = (restarts = 0) => {
      const started = ++authoritySeq;
      latestRetry = null;
      // Keep ordinary refresh camera/layout-neutral. Retain an existing
      // failure/partial warning, but do not add a transient header row.
      renderLatest();
      void dashboardFetch("/api/dashboard/latest-positions", {
        headers: { Authorization: `Bearer ${adminKey}` },
        signal,
        cache: "no-store",
        redirect: "error",
      })
        .then(async (response) => {
          if (!response.ok)
            throw httpError("Latest positions read failed.", response.status);
          return parseLatest(await response.json());
        })
        .then((members) => {
          if (!live() || latestScopeDeniedAt > started) return;
          const next = new Map(),
            incomplete = [];
          for (const m of members) {
            if (suppressedMembers.has(m.user_id)) continue;
            if (m.status === "private") {
              withholdMember(m.user_id);
              continue;
            }
            if (m.status === "incomplete") incomplete.push(m.user_id);
            if (m.status !== "located") continue;
            // A denial applied after this read began wins over its positive.
            if ((positionPrivateAt.get(m.user_id) || 0) > started) continue;
            positionPrivateAt.delete(m.user_id);
            const p = m.latest;
            next.set(m.user_id, {
              latitude: p.latitude,
              longitude: p.longitude,
              captured_at: p.captured_at,
              display_name:
                typeof m.display_name === "string" ? m.display_name : null,
            });
          }
          latestPositions = next;
          latestIncomplete = incomplete;
          latestNote = incomplete.length
            ? `Latest known position could not be confirmed for ${incomplete.map((id) => mapMembers.get(id)?.display_name || members.find((m) => m.user_id === id)?.display_name || "a member").join(", ")} (search limit reached); no pin is shown for ${incomplete.length === 1 ? "this member" : "these members"}.`
            : "";
          latestRetry = incomplete.length ? () => loadLatest() : null;
          renderLatest();
          frameDefault();
        })
        .catch((error) => {
          if (!live() || latestScopeDeniedAt > started) return;
          if (error.status === 409 && restarts < 1) return loadLatest(1);
          if (denied(error)) return denyDojoScope(error.status);
          // Unverified: no pin is shown and the failure stays visible.
          latestPositions = new Map();
          latestIncomplete = [];
          latestNote =
            error.status === 409
              ? "Latest known positions unavailable (409): access changed while loading."
              : `Latest known positions unavailable${error.status ? ` (${error.status})` : " (invalid response)"}.`;
          latestRetry = () => loadLatest();
          renderLatest();
        });
    };
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
      paths = null,
      // Marks laid out by the motion layer; null until the next layout.
      eventMarks = null,
      fitted = false,
      initialView,
      // Outcome of the last camera focus request, until the next filter.
      focusNote = "",
      // A member focus requested before this day's ledger was published.
      pendingMember = null,
      // Bumped by each deliberate camera change; stale focus re-applies stop.
      cameraEpoch = 0;
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
      if (focusNote) status.textContent += ` ${focusNote}`;
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
      paths = svg("svg", { class: "dashboard-map-connections" });
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
        marker.onclick = (event) => {
          choose(item, generation);
          if (doubleActivation(`event:${item.id}`, event)) focusMapEvent(item);
        };
        marker.setAttribute("aria-keyshortcuts", "Shift+Enter");
        marker.onkeydown = (event) => {
          if (event.key !== "Enter" || !event.shiftKey) return;
          event.preventDefault();
          choose(item, generation);
          focusMapEvent(item);
        };
        const dot = { item, fix, marker, node: marker };
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
        before.link = { from: before, to: dot, line };
        links.push(before.link);
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
        const group = {
          fix: pins[0].fix,
          pins,
          marker,
          node: marker,
          generation,
        };
        marker.onclick = () => openChooser(group);
        groups.push(group);
      }
      overlay.append(
        ...dots.map(({ marker }) => marker),
        ...groups.map(({ marker }) => marker),
      );
      eventMarks = null;
      if (!fitted && dots.length) {
        fitted = true;
        // The initial view frames the day's fixes with the latest member
        // fixes. A kept view moves only when it would show none of the new
        // day's events; an explicit latest focus is never overridden.
        if (latestFocusHeld()) {
          // Keep the explicit latest focus.
        } else if (!keptView) fitPins(defaultFrame());
        else if (
          dots.every(({ fix }) =>
            offscreen(project(fix, instance.getCenter().lng)),
          )
        )
          fitPins(dots);
        mapViewSettled = true;
        initialView = {
          center: instance.getCenter(),
          zoom: instance.getZoom(),
        };
      }
      // Apply a pending member focus over the day fit (which All restores),
      // fenced by the published ledger and the still-selected member.
      if (pendingMember && (day || !timelinePending)) {
        const memberId = pendingMember;
        pendingMember = null;
        focusNote = "";
        if (selectedMember === memberId) focusMapMember(memberId, true);
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
    // Co-location badges and the dots they cover (selection, preview).
    const markPins = () => {
      for (const dot of dots) dot.covered = false;
      for (const group of groups) {
        const active = group.pins.filter(visible);
        group.covered = active.length < 2;
        const count = String(active.length);
        if (group.marker.dataset.count !== count) {
          group.marker.textContent = count;
          group.marker.dataset.count = count;
          group.marker.setAttribute(
            "aria-label",
            `${active.length} events at this recorded location; choose an event`,
          );
        }
        // Selected and previewed events keep their exact dots above the location badge.
        if (active.length > 1)
          for (const dot of active)
            if (
              dot.item.id !== selectedEventId &&
              dot.item.id !== previewEventId
            )
              dot.covered = true;
      }
    };
    const eventMotion = motionLayer(
      overlay,
      0,
      (mark) => mark.covered,
      () => paths,
    );
    const drawLink = ({ from, line, dx, dy }) => {
      line.setAttribute("x1", from.x);
      line.setAttribute("y1", from.y);
      line.setAttribute("x2", from.x + dx);
      line.setAttribute("y2", from.y + dy);
    };
    // Exact layout at the current view; native motion then follows it.
    const placePins = () => {
      if (!live()) return;
      markPins();
      eventMarks = [...dots, ...groups];
      eventMotion.layout(eventMarks, () => {
        // Unwrap the destination beside its origin: the shortest arc in one world copy.
        for (const link of links) {
          const { from, to } = link,
            b = eventMotion.at(to.fix, from.fix.longitude + from.k);
          link.dx = b.x - from.x;
          link.dy = b.y - from.y;
          drawLink(link);
        }
      });
    };
    // A selected event emphasizes its member's sequence and dims, never hides,
    // everyone else; the explicit member filter keeps hiding other members.
    refreshMap = () => {
      if (!live()) return;
      checkFocus();
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
      if (!eventMarks) return placePins();
      markPins();
      eventMotion.cull();
    };
    filterMap = (clearSelection = true, resetCamera = false) => {
      closeChooser(false);
      if (clearSelection) {
        pendingMember = null;
        cameraEpoch++;
        retireFocus();
      }
      if (!pendingMember) focusNote = "";
      if (clearSelection) {
        selectionEpoch++;
        selection.replaceChildren();
        highlightEvent(null);
      }
      // Unanimated: an in-flight zoom animation would overwrite a focus that
      // the second click of a double activation applies right after this.
      if (resetCamera && initialView)
        instance.setView(initialView.center, initialView.zoom, {
          animate: false,
        });
      refreshMap();
      showStatus();
    };
    instance.on("move zoom resize", (event) => {
      if (!live()) return;
      if (event.flyTo && eventMotion.drifted()) placePins();
      else eventMotion.follow((dot) => dot.link && drawLink(dot.link));
    });
    instance.on("zoomanim", (event) => live() && eventMotion.animate(event));
    instance.on("moveend", placePins);
    const arcCoords = (pins) => {
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
      return pins.map(({ fix }) => {
        const wrapped = (fix.longitude + 360) % 360;
        return [fix.latitude, wrapped < arcStart ? wrapped + 360 : wrapped];
      });
    };
    const fitPins = (pins, maxZoom = 16) => {
      if (!pins.length) return;
      const coords = arcCoords(pins);
      if (coords.length === 1)
        instance.setView(
          [pins[0].fix.latitude, pins[0].fix.longitude],
          maxZoom,
          { animate: false },
        );
      else
        instance.fitBounds(L.latLngBounds(coords), {
          padding: [
            Math.min(48, map.clientWidth / 4),
            Math.min(48, map.clientHeight / 4),
          ],
          maxZoom,
          animate: false,
        });
    };
    // A kept view is the operator's own choice: resizes preserve it like panning.
    let userViewChanged = Boolean(keptView);
    instance.on("dragstart", () => markUserView());
    // Deliberate navigation also supersedes a pending member focus.
    const markUserView = () => {
      userViewChanged = mapViewSettled = true;
      cameraEpoch++;
      retireFocus();
      if (!pendingMember) return;
      pendingMember = null;
      focusNote = "";
      showStatus();
    };
    // Where a fit of these fixes puts the camera: Leaflet's fitBounds target
    // (the dashboard's padding, at most `maxZoom`) for the same antimeridian
    // arc as fitPins, in the world copy nearest the view.
    const pinsView = (pins, maxZoom) => {
      const coords = arcCoords(pins);
      let center = L.latLng(coords[0]),
        zoom = maxZoom;
      if (coords.length > 1) {
        const bounds = L.latLngBounds(coords);
        const padding = L.point(
          Math.min(48, map.clientWidth / 4),
          Math.min(48, map.clientHeight / 4),
        );
        zoom = Math.min(
          maxZoom,
          instance.getBoundsZoom(bounds, false, padding.multiplyBy(2)),
        );
        if (!Number.isFinite(zoom)) zoom = maxZoom;
        center = instance.unproject(
          instance
            .project(bounds.getSouthWest(), zoom)
            .add(instance.project(bounds.getNorthEast(), zoom))
            .divideBy(2),
          zoom,
        );
      }
      const near = instance.getCenter().lng;
      return {
        center: L.latLng(
          center.lat,
          center.lng + 360 * Math.round((near - center.lng) / 360),
        ),
        zoom,
      };
    };
    // The canonical ledger's currently shared fixes of a member's shown events.
    const memberPins = (memberId, category) =>
      dots
        .filter(
          ({ item }) =>
            item.user_id === memberId &&
            !suppressedMembers.has(memberId) &&
            (!category || eventCategory(item) === category),
        )
        .map(({ item }) => ({
          fix: eventPosition(scoped()?.items.get(item.id)),
        }))
        .filter(({ fix }) => fix);
    // Focus is a deliberate view: resizes keep it like panning. Only the
    // canonical ledger's currently shared fixes count; nothing found is a
    // truthful no-op that leaves the camera alone. `instant`: applied with
    // the day's publication (a pending focus), never flown.
    focusMapMember = (memberId, instant = false) => {
      if (!live()) return;
      if (!scoped()) {
        const name =
          mapMembers.get(memberId)?.display_name ||
          feedMembers.get(memberId)?.display_name ||
          "Member";
        // Until the day's ledger publishes nothing is known about its
        // locations: wait for it instead of leaving the default day fit.
        if (timelinePending) {
          pendingMember = memberId;
          focusNote = `Map will zoom to ${name}'s shown event locations once this day's events load.`;
        } else
          focusNote = `${name}'s event locations for ${date} are not loaded; the map view was not changed.`;
        showStatus();
        return;
      }
      pendingMember = null;
      const category = timelineCategory();
      const pins = memberPins(memberId, category);
      const name = memberName(memberId);
      const note = (shown) =>
        `Map zoomed to ${name}'s ${shown.length} shown event location${shown.length === 1 ? "" : "s"}.`;
      if (pins.length) {
        focusCamera({
          resolve: () => {
            if (selectedMember !== memberId || timelineCategory() !== category)
              return null;
            const current = memberPins(memberId, category);
            return current.length ? current : null;
          },
          view: (shown) => pinsView(shown, FOCUS_ZOOM),
          note,
          ledger: true,
          instant,
        });
      } else
        focusNote = `${name} has no shared event location${category ? ` in ${category === "status_change" ? "Readiness" : eventLabel(category)}` : ""} on ${date}; the map view was not changed.`;
      showStatus();
    };
    focusMapEvent = (original) => {
      if (!live()) return;
      const item = scoped()?.items.get(original.id);
      const fix =
        item && !suppressedMembers.has(item.user_id) && eventPosition(item);
      if (fix) {
        const category = timelineCategory();
        focusCamera({
          resolve: () => {
            // Still the selected event of this ledger row, as it is now.
            const now = scoped()?.items.get(item.id);
            return (
              selectedEventId === item.id &&
              timelineCategory() === category &&
              now &&
              !suppressedMembers.has(now.user_id) &&
              eventPosition(now)
            );
          },
          // The exact recorded point, in the world copy nearest the view.
          view: pointView,
          note: () =>
            `Map zoomed to the recorded location of ${memberName(item.user_id)} · ${eventLabel(item.event_type)} · ${clock(item)}.`,
          ledger: true,
        });
      } else
        focusNote =
          "This event has no shared location; the map view was not changed.";
      showStatus();
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
    // Overlay marks stop their double activations before Leaflet's
    // double-click zoom; only a double click that can zoom is navigation.
    map.addEventListener(
      "dblclick",
      (event) => {
        if (
          !event.target.closest?.(
            ".dashboard-map-overlay, .dashboard-latest-overlay, .dashboard-latest-chooser",
          )
        )
          markUserView();
      },
      { capture: true, signal },
    );
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
    map.addEventListener("wheel", markUserView, { passive: true });
    // Leaflet stops control clicks at the anchor. Capture newer navigation
    // before that, including a focus still waiting for native zoom to end.
    map
      .querySelector(".leaflet-control-zoom")
      ?.addEventListener("click", markUserView, { capture: true, signal });
    mapResizeObserver = new ResizeObserver(() => {
      if (!map.getClientRects().length) return;
      instance.invalidateSize();
      placePins();
      const shown = dots.filter(visible);
      const frame = userViewChanged ? shown : defaultFrame();
      // A desktop fit may leave every event offscreen when the map narrows.
      // Refit only then, preserving deliberate user panning when one is
      // visible and always an explicit latest-position focus.
      if (
        !latestFocusHeld() &&
        !focusing &&
        frame.length &&
        (!userViewChanged ||
          shown.every(({ fix }) =>
            offscreen(project(fix, instance.getCenter().lng)),
          ))
      ) {
        fitPins(frame);
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
    loadLatest();
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
      // A Stats 401/403 is a full member denial, not Position-only.
      onDenial: (id) => denyMember(id),
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
