/* Standalone Coach Dashboard; all values arrive from an authorized snapshot. */
window.CoachDashboard = (() => {
  const $ = (id) => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  const isPhoto = (f) =>
    f &&
    (f._id || f.id) &&
    (f.type === "image" || /^image\/(jpeg|png|webp)$/.test(f.type));
  let epoch = 0;
  let controller;
  let observer;
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
        if (!options.signal) queuedSignal?.removeEventListener("abort", cancel);
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
  // Last successful authorized roster; kept only across transient failures.
  let rosterCache = null;
  // A confirmed same-load denial cannot be undone by a concurrent roster/map
  // snapshot. A fresh dashboard load is required to recheck this member.
  const suppressedMembers = new Set();
  let selectedMember = null;
  let closeMemberTooltip = () => {};
  let mapMembers = new Map();
  let feedMembers = new Map();
  let filterFeed = () => {};
  let filterMap = () => {};
  let selectionEpoch = 0;
  let timelineEpoch = 0;
  let timelinePending = false;
  let timelineInteraction = () => {};
  let timelineController;
  let filterTimeline = () => {};
  let timelineResize = null;
  let linkActivity = () => {};
  let purgeMapMember = () => {};
  let removeMapActivity = () => {};
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
    const input = $("dashboardMapDate");
    const month = $("dashboardMapMonth")?.options
        ? $("dashboardMapMonth")
        : null,
      year = $("dashboardMapYear")?.options ? $("dashboardMapYear") : null;
    const range = $("dashboardMapDay"),
      ticks = $("dashboardDayTicks");
    const output = $("dashboardSelectedDate");
    const previous = $("dashboardMapPrevious"),
      next = $("dashboardMapNext"),
      today = $("dashboardMapToday");
    let committedDate = input.value,
      previewInvalidated = false;
    const loadId = epoch;
    const live = () => loadId === epoch;
    function parts() {
      return input.value.split("-").map(Number);
    }
    function sync() {
      const [y, m, d] = parts();
      if (!y || !m || !d) return;
      const length = civilDate(y, m + 1, 0).getDate();
      if (month) month.value = String(m);
      if (
        year &&
        ![...year.options].some((option) => option.value === String(y))
      ) {
        const years = new Set(
          [...year.options].map((option) => Number(option.value)),
        );
        for (let n = Math.max(1, y - 10); n <= Math.min(9999, y + 10); n++)
          years.add(n);
        year.replaceChildren(
          ...[...years]
            .sort((a, b) => a - b)
            .map((n) => {
              const option = text("option", String(n));
              option.value = String(n);
              return option;
            }),
        );
      }
      if (year) year.value = String(y);
      if (range) {
        range.max = String(length);
        range.value = String(d);
      }
      if (output)
        output.textContent = civilDate(y, m, d).toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      if (range)
        range.setAttribute(
          "aria-valuetext",
          output?.textContent || input.value,
        );
      if (ticks && ticks.childElementCount !== length) {
        ticks.replaceChildren(
          ...Array.from({ length }, (_, i) => {
            const tick = text("div", "", "dashboard-day-tick");
            tick.append(text("span", String(i + 1)));
            return tick;
          }),
        );
      }
    }
    function commit(force = false) {
      if (!live()) return;
      sync();
      if (!force && input.value === committedDate && !previewInvalidated)
        return;
      committedDate = input.value;
      previewInvalidated = false;
      void loadMap(adminKey);
    }
    function preview() {
      if (!live()) return;
      const [y, m] = parts();
      const value = dateValue(civilDate(y, m, Number(range.value)));
      if (value === input.value) return;
      input.value = value;
      sync();
      // Fence pending old-date reads immediately, without dispatching new ones
      // while the native slider is being dragged. Member selection is retained.
      previewInvalidated = true;
      mapEpoch++;
      mapController?.abort();
      timelineEpoch++;
      timelineController?.abort();
      timelinePending = false;
      timelineInteraction(false);
      timelineResize?.disconnect();
      timelineResize = null;
      selectionEpoch++;
      linkActivity = () => {};
      filterMap = () => {};
      filterTimeline = () => {};
      disposeMap();
      $("dashboardMap")?.replaceChildren();
      $("dashboardTimeline")?.replaceChildren();
      $("dashboardMapSelection")?.replaceChildren();
      if ($("dashboardMapStatus"))
        $("dashboardMapStatus").textContent = `Release to load ${value}.`;
    }
    function stepDay(amount) {
      if (!live()) return;
      const [y, m, d] = parts();
      const date = civilDate(y, m, d);
      date.setDate(date.getDate() + amount);
      if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
      input.value = dateValue(date);
      commit();
    }
    function changePeriod() {
      if (!live()) return;
      const [y, m, d] = parts();
      const nextYear = Number(year?.value || y),
        nextMonth = Number(month?.value || m);
      input.value = dateValue(
        civilDate(
          nextYear,
          nextMonth,
          Math.min(d, civilDate(nextYear, nextMonth + 1, 0).getDate()),
        ),
      );
      commit();
    }
    if (month) {
      month.replaceChildren(
        ...Array.from({ length: 12 }, (_, i) => {
          const option = text(
            "option",
            civilDate(2000, i + 1, 1).toLocaleDateString(undefined, {
              month: "long",
            }),
          );
          option.value = String(i + 1);
          return option;
        }),
      );
      month.onchange = changePeriod;
    }
    if (year) {
      year.replaceChildren();
      const current = new Date().getFullYear();
      for (
        let y = Math.max(1, current - 100);
        y <= Math.min(9999, current + 10);
        y++
      ) {
        const option = text("option", String(y));
        option.value = String(y);
        year.append(option);
      }
      year.onchange = changePeriod;
    }
    if (previous) previous.onclick = () => stepDay(-1);
    if (next) next.onclick = () => stepDay(1);
    if (today)
      today.onclick = () => {
        if (!live()) return;
        input.value = dateValue(new Date());
        commit();
      };
    if (range) {
      range.oninput = preview;
      range.onchange = () => {
        preview();
        commit();
      };
      range.onpointerup = () => {
        preview();
        commit();
      };
      range.onpointercancel = () => {
        preview();
        commit();
      };
    }
    // Preserve the native date fallback's explicit same-date Reload semantics.
    input.onchange = () => commit(true);
    clearDateNavigation = () => {
      input.onchange = null;
      if (month) month.onchange = null;
      if (year) year.onchange = null;
      for (const button of [previous, next, today])
        if (button) button.onclick = null;
      if (range)
        range.oninput =
          range.onchange =
          range.onpointerup =
          range.onpointercancel =
            null;
    };
    sync();
  }
  function clear() {
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
    suppressedMembers.clear();
    filterFeed = () => {};
    filterMap = () => {};
    forgetMember = () => {};
    if ($("dashboardMapStatus")) $("dashboardMapStatus").textContent = "";
    $("dashboardMapStatus")?.removeAttribute("data-tone");
    observer?.disconnect();
    observer = undefined;
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    $("dashboardRoster").replaceChildren();
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
    avatarCache.clear();
    for (const url of avatarUrls.splice(0)) URL.revokeObjectURL(url);
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
      const name = all ? "All members" : user.display_name || "Member";
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
            if (!tooltip.matches(":popover-open")) hide();
          });
          entry.append(info, tooltip);
        }
      }
      button.addEventListener("click", () => {
        selectedMember = id;
        selectionEpoch++;
        $("dashboardMapSelection")?.replaceChildren();
        highlightActivity(null);
        renderMemberCards();
        filterMap();
        filterFeed();
        filterTimeline();
      });
      (all ? target : rail).append(entry || button);
    };
    makeCard(null, {}, true);
    target.append(rail);
    for (const [id, user] of members) makeCard(id, user);
    // Keep the selected offscreen member in view across selection/cache renders;
    // the browser clamps naturally if an authorization denial shrinks the rail.
    rail.scrollLeft = rosterScrollLeft;
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
  function showDetail(detail, name) {
    const rows = [
      text("h4", name),
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
        position(detail.position)
          ? `Position: ${detail.position.latitude}, ${detail.position.longitude}`
          : "Position unavailable.",
        "hint",
      ),
    );
    rows.push(
      text(
        "p",
        position(detail.position)
          ? "Position reauthorized for this read; map pin is not a live location."
          : "No authorized position was returned; activity detail is still available.",
        "hint",
      ),
    );
    $("dashboardMapSelection").replaceChildren(...rows);
  }

  function highlightActivity(activityId) {
    for (const mark of document.querySelectorAll(
      ".dashboard-timeline-mark, .dashboard-activity-pin",
    ))
      mark.setAttribute(
        "aria-pressed",
        String(mark.dataset.activityId === activityId),
      );
  }
  async function selectActivity(
    entry,
    name,
    adminKey,
    pan = false,
    historical = null,
  ) {
    const choice = ++selectionEpoch,
      day = mapEpoch,
      loadId = epoch;
    const selectedDate = $("dashboardMapDate").value;
    const [year, month, date] = selectedDate.split("-").map(Number);
    const start = new Date(0);
    start.setFullYear(year, month - 1, date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const selection = $("dashboardMapSelection");
    highlightActivity(entry._id);
    if (historical)
      for (const mark of document.querySelectorAll(".dashboard-timeline-mark"))
        mark.setAttribute(
          "aria-pressed",
          String(mark.dataset.eventId === historical.id),
        );
    selection.replaceChildren(
      ...(historical ? eventSnapshot(historical, name) : []),
      text("p", "Checking current activity access…"),
    );
    try {
      const response = await dashboardFetch(
        `/api/dashboard/activity?${new URLSearchParams({ id: entry._id })}`,
        {
          headers: { Authorization: `Bearer ${adminKey}` },
          cache: "no-store",
          redirect: "error",
        },
        mapController?.signal,
      );
      if (!response.ok)
        throw httpError("Activity read failed", response.status);
      const envelope = await response.json();
      if (loadId !== epoch || day !== mapEpoch || choice !== selectionEpoch)
        return;
      if (
        envelope.owner?._id !== entry.user_id ||
        envelope.activity?._id !== entry._id ||
        envelope.activity?.user_id !== entry.user_id
      )
        throw httpError("Activity unavailable", 404);
      const fresh = envelope.activity,
        stamp = Date.parse(fresh.created_at);
      if (
        !historical &&
        (!Number.isFinite(stamp) ||
          stamp < +start ||
          stamp >= +end ||
          !(
            ["complete", "completed"].includes(fresh.status) ||
            (fresh.status === "ongoing" &&
              Date.now() >= +start &&
              Date.now() < +end)
          ))
      )
        throw httpError("Activity unavailable", 404);
      if (suppressedMembers.has(entry.user_id)) return;
      showDetail(envelope.activity, name);
      if (historical)
        selection.prepend(
          ...eventSnapshot(historical, name),
          text("h3", "Current authorized activity"),
        );
      linkActivity(envelope.activity, pan);
    } catch (error) {
      if (loadId !== epoch) return;
      if (denied(error)) {
        suppressedMembers.add(entry.user_id);
        mapMembers.delete(entry.user_id);
        rosterCache?.delete(entry.user_id);
        const url = avatarCache.get(entry.user_id);
        if (url) {
          URL.revokeObjectURL(url);
          avatarCache.delete(entry.user_id);
        }
        purgeMapMember(entry.user_id);
        forgetMember(entry.user_id);
        filterTimeline();
        renderMemberCards();
      } else if (error.status === 404 && day === mapEpoch) {
        removeMapActivity(entry._id);
        for (const mark of document.querySelectorAll(
          ".dashboard-timeline-mark",
        ))
          if (mark.dataset.activityId === entry._id) mark.remove();
      }
      if (day !== mapEpoch || choice !== selectionEpoch) return;
      selection.replaceChildren(
        ...(historical && !denied(error)
          ? eventSnapshot(historical, name)
          : []),
        text(
          "p",
          denied(error)
            ? `Activity access denied (${error.status}); this member's pins, card and loaded details were removed.`
            : error.status === 404
              ? "Activity unavailable (404); this activity was removed. Refresh to recheck."
              : `Activity detail temporarily unavailable${error.status ? ` (${error.status})` : ""}. Pins and cards were kept; try again shortly.`,
        ),
      );
      if (!denied(error) && error.status !== 404) {
        const retry = text("button", "Retry activity detail");
        retry.type = "button";
        retry.onclick = () =>
          void selectActivity(entry, name, adminKey, pan, historical);
        selection.append(retry);
      }
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
  function eventLabel(kind) {
    return typeof kind === "string" ? kind.replace(/[._]/g, " ") : "Event";
  }
  function showEvent(item, name, adminKey) {
    if (suppressedMembers.has(item.user_id)) return;
    selectionEpoch++;
    highlightActivity(null);
    for (const mark of document.querySelectorAll(".dashboard-timeline-mark"))
      mark.setAttribute(
        "aria-pressed",
        String(mark.dataset.eventId === item.id),
      );
    $("dashboardMapSelection").replaceChildren(...eventSnapshot(item, name));
    if (
      adminKey &&
      Object.hasOwn(activityColors, item.subject?.type) &&
      /^[0-9a-f]{24}$/.test(item.subject?.id || "")
    ) {
      void selectActivity(
        { _id: item.subject.id, user_id: item.user_id },
        name,
        adminKey,
        true,
        item,
      );
    }
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
    const category = (item) => item.event_type?.split(".")[0] || "other";
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
      activeEvent = null,
      inspectorOwner = null;
    const count = text("div", "", "dashboard-timeline-count");
    count.setAttribute("role", "status");
    const toolbar = text("div", "", "dashboard-timeline-toolbar");
    const filters = text("div", "", "dashboard-timeline-legend");
    filters.setAttribute("aria-label", "Filter event category");
    const scroll = text("div", "", "dashboard-timeline-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute(
      "aria-label",
      "Day event timeline; scroll horizontally to pan",
    );
    const track = text("div", "", "dashboard-timeline-track");
    scroll.append(track);
    const interactive = () =>
      renderEpoch === timelineEpoch && !timelinePending && scroll.isConnected;
    const inspector = text("div", "", "dashboard-timeline-inspector");
    inspector.hidden = true;
    inspector.setAttribute("aria-label", "Event inspector");
    let dismissTimer,
      restoringFocus = false;
    const dismiss = () => {
      clearTimeout(dismissTimer);
      inspector.replaceChildren();
      inspector.hidden = true;
      inspectorOwner = null;
      inspector.style.cssText = "";
    };
    const dismissAndRestoreFocus = () => {
      const owner = inspectorOwner;
      dismiss();
      if (!interactive() || !owner?.isConnected) return;
      restoringFocus = true;
      try {
        owner.focus({ preventScroll: true });
      } finally {
        restoringFocus = false;
      }
    };
    const scheduleDismiss = () => {
      clearTimeout(dismissTimer);
      if (interactive() && inspector.dataset.mode === "preview")
        dismissTimer = setTimeout(dismiss, 180);
    };
    inspector.onpointerenter = () => clearTimeout(dismissTimer);
    inspector.onpointerleave = scheduleDismiss;
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
      if (!interactive()) return;
      if (!visibleItems().some((event) => event.id === item.id)) return;
      activeEvent = item.id;
      showEvent(item, name(item), adminKey);
      dismissAndRestoreFocus();
      for (const cluster of track.querySelectorAll(
        ".dashboard-timeline-cluster",
      ))
        cluster.setAttribute(
          "aria-pressed",
          String(JSON.parse(cluster.dataset.eventIds).includes(item.id)),
        );
    };
    const preview = (group, owner, choose = false) => {
      if (!interactive() || !owner.isConnected) return;
      dismiss();
      inspectorOwner = owner;
      inspector.hidden = false;
      inspector.dataset.mode = choose ? "chooser" : "preview";
      const close = text(
        "button",
        "Close inspector",
        "dashboard-timeline-close",
      );
      close.type = "button";
      close.onclick = dismissAndRestoreFocus;
      inspector.append(close);
      if (group.length === 1) {
        const rows = eventSnapshot(group[0], name(group[0]));
        inspector.append(rows[0], rows[1], rows[2], ...rows.slice(4, -1));
        const pick = text(
          "button",
          "Select event",
          "dashboard-timeline-choice",
        );
        pick.type = "button";
        pick.dataset.eventId = group[0].id;
        pick.onclick = () => select(group[0]);
        inspector.append(pick);
      } else {
        inspector.append(
          text(
            "h3",
            `${group.length} events · ${time(group[0])}${group.at(-1).occurred_at !== group[0].occurred_at ? ` – ${time(group.at(-1))}` : ""}`,
          ),
        );
        inspector.append(
          text(
            "p",
            "Separate occurrences at their recorded times. Choose an event; zoom can separate nearby times.",
            "hint",
          ),
        );
        for (const item of group) {
          const choice = text(
            "button",
            label(item),
            "dashboard-timeline-choice",
          );
          choice.type = "button";
          choice.dataset.eventId = item.id;
          choice.style.borderLeftColor =
            activityColors[category(item)] || "#6b7280";
          const snapshot = eventSnapshot(item, name(item));
          const detail = text(
            "span",
            [
              snapshot[2].textContent,
              ...snapshot.slice(4, -1).map((row) => row.textContent),
            ].join(" · "),
            "dashboard-timeline-choice-snapshot",
          );
          choice.append(detail);
          choice.onclick = () => select(item);
          inspector.append(choice);
        }
      }
      inspector.scrollTop = 0;
      if (!choose) {
        const rect = owner.getBoundingClientRect();
        inspector.style.width = `${Math.min(380, innerWidth - 24)}px`;
        inspector.style.maxHeight = `${Math.min(300, innerHeight - 24)}px`;
        const card = inspector.getBoundingClientRect();
        inspector.style.left = `${Math.max(12, Math.min(innerWidth - card.width - 12, rect.left + rect.width / 2 - card.width / 2))}px`;
        inspector.style.top = `${Math.max(12, Math.min(innerHeight - card.height - 12, rect.bottom + 10 + card.height <= innerHeight - 12 ? rect.bottom + 10 : rect.top - card.height - 10))}px`;
      }
      if (choose)
        inspector
          .querySelector(".dashboard-timeline-choice")
          ?.focus({ preventScroll: true });
    };
    const draw = () => {
      dismiss();
      for (const [id, item] of items)
        if (suppressedMembers.has(item.user_id)) items.delete(id);
      const events = visibleItems();
      const selected = $("dashboardMapSelection").querySelector(
        ".dashboard-event-detail",
      );
      if (
        (activeEvent && !events.some((item) => item.id === activeEvent)) ||
        (selected &&
          (suppressedMembers.has(selected.dataset.memberId) ||
            (selectedMember && selectedMember !== selected.dataset.memberId)))
      ) {
        selectionEpoch++;
        activeEvent = null;
        $("dashboardMapSelection").replaceChildren();
      }
      count.textContent = `${events.length} visible · ${items.size} loaded events across all members`;
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
        const marker = text("span", "Now", "dashboard-timeline-now");
        marker.style.left = `${fraction(now) * 100}%`;
        marker.setAttribute(
          "aria-label",
          `Now ${new Date(now).toLocaleTimeString()}`,
        );
        track.append(marker);
      }
      const groups = [];
      for (const item of events) {
        const x = fraction(Date.parse(item.occurred_at)) * width;
        const last = groups.at(-1);
        // Bound each cluster around its first recorded timestamp, not an invented duration.
        if (last && x - last.x < 48) last.items.push(item);
        else groups.push({ x, items: [item] });
      }
      const singles = new Set(
        groups
          .filter((group) => group.items.length === 1)
          .map((group) => group.items[0].id),
      );
      // Keep one unique, inspectable occurrence node for every loaded authorized event.
      for (const item of items.values()) {
        const mark = text("button", "", "dashboard-timeline-mark");
        mark.type = "button";
        mark.dataset.eventId = item.id;
        mark.dataset.memberId = item.user_id;
        mark.dataset.eventType = item.event_type;
        mark.style.left = `${fraction(Date.parse(item.occurred_at)) * 100}%`;
        mark.style.top = "34px";
        mark.style.backgroundColor =
          activityColors[category(item)] || "#6b7280";
        mark.setAttribute("aria-label", label(item));
        mark.setAttribute("aria-pressed", String(activeEvent === item.id));
        mark.classList.toggle(
          "dashboard-timeline-future-event",
          now >= +start && now < +end && Date.parse(item.occurred_at) > now,
        );
        mark.hidden = !singles.has(item.id);
        mark.onpointerenter = (event) => {
          if (event.pointerType !== "touch") preview([item], mark);
        };
        mark.onpointerleave = scheduleDismiss;
        mark.onfocus = () => {
          if (!restoringFocus) preview([item], mark);
        };
        mark.onclick = (event) => {
          if (event.pointerType === "touch") preview([item], mark, true);
          else select(item);
        };
        track.append(mark);
      }
      for (const group of groups.filter((group) => group.items.length > 1)) {
        const cluster = text(
          "button",
          String(group.items.length),
          "dashboard-timeline-cluster",
        );
        cluster.type = "button";
        cluster.classList.toggle(
          "dashboard-timeline-future-event",
          now >= +start &&
            now < +end &&
            group.items.every((item) => Date.parse(item.occurred_at) > now),
        );
        cluster.dataset.eventIds = JSON.stringify(
          group.items.map((item) => item.id),
        );
        cluster.style.left = `${(group.x / width) * 100}%`;
        cluster.style.top = "34px";
        cluster.setAttribute(
          "aria-label",
          `${group.items.length} events at ${time(group.items[0])}; choose an occurrence`,
        );
        cluster.setAttribute(
          "aria-pressed",
          String(group.items.some((item) => item.id === activeEvent)),
        );
        cluster.onpointerenter = (event) => {
          if (event.pointerType !== "touch") preview(group.items, cluster);
        };
        cluster.onpointerleave = scheduleDismiss;
        cluster.onfocus = () => {
          if (!restoringFocus) preview(group.items, cluster);
        };
        cluster.onclick = () => preview(group.items, cluster, true);
        const swatches = text("span", "", "dashboard-timeline-cluster-colors");
        for (const type of [...new Set(group.items.map(category))].slice(
          0,
          4,
        )) {
          const swatch = text("i", "", "dashboard-timeline-swatch");
          swatch.style.backgroundColor = activityColors[type] || "#6b7280";
          swatch.setAttribute("aria-hidden", "true");
          swatches.append(swatch);
        }
        cluster.append(swatches);
        track.append(cluster);
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
      "Pan earlier",
      "Zoom out",
      "Zoom in",
      "Full day",
      "Pan later",
    ]) {
      const button = text(
        "button",
        {
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
    target.append(count, filters, toolbar, scroll, inspector);
    target.onkeydown = (event) => {
      if (!interactive()) return;
      if (
        (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
        event.target.closest(".dashboard-timeline-choice")
      ) {
        const choices = [
          ...inspector.querySelectorAll(".dashboard-timeline-choice"),
        ];
        const index = choices.indexOf(
          event.target.closest(".dashboard-timeline-choice"),
        );
        choices[
          Math.max(
            0,
            Math.min(
              choices.length - 1,
              index + (event.key === "ArrowRight" ? 1 : -1),
            ),
          )
        ]?.focus();
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        dismissAndRestoreFocus();
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
    draw();
    // Recompute collision distances after viewport changes, with no leaked observers.
    timelineResize?.disconnect();
    timelineResize = new ResizeObserver(() => {
      if (scroll.isConnected) draw();
    });
    timelineResize.observe(scroll);
    timelineInteraction = (enabled) => {
      dismiss();
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
  async function loadTimeline(adminKey, resume = null) {
    const target = $("dashboardTimeline");
    if (!target) return;
    selectionEpoch++;
    $("dashboardMapSelection").replaceChildren();
    const id = ++timelineEpoch;
    timelinePending = true;
    timelineInteraction(false);
    timelineController?.abort();
    timelineController = new AbortController();
    const signal = timelineController.signal,
      date = $("dashboardMapDate").value;
    const live = () => id === timelineEpoch && !signal.aborted;
    if (target.dataset.date !== date) {
      target.replaceChildren();
      timelineInteraction = () => {};
      filterTimeline = () => {};
    }
    target.dataset.date = date;
    for (const old of target.querySelectorAll(":scope > p, :scope > button"))
      old.remove();
    timelineResize?.disconnect();
    for (const inspector of target.querySelectorAll(
      ".dashboard-timeline-inspector",
    )) {
      inspector.replaceChildren();
      inspector.hidden = true;
    }
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
    try {
      const users = new Map(resume?.users),
        items = new Map(resume?.items);
      let cursor = resume?.cursor,
        coverage = resume?.coverage,
        pages = 0;
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
        coverage = data.coverage || coverage;
        for (const user of data.users) users.set(user._id, user);
        for (const item of data.events) {
          const stamp = Date.parse(item.occurred_at);
          if (
            typeof item.id !== "string" ||
            typeof item.user_id !== "string" ||
            !Number.isFinite(stamp) ||
            stamp < +start ||
            stamp >= +end ||
            items.has(item.id)
          )
            throw new Error("Invalid timeline event");
          items.set(item.id, item);
        }
        pages++;
        if (
          data.hasMore &&
          (typeof data.nextCursor !== "string" ||
            !data.nextCursor ||
            data.nextCursor === cursor ||
            seenCursors.has(data.nextCursor))
        )
          throw new Error("Timeline display limit or nonadvancing cursor");
        cursor = data.hasMore ? data.nextCursor : undefined;
        if (cursor) seenCursors.add(cursor);
      } while (cursor && pages < 10);
      if (!live()) return;
      timelinePending = false;
      status.textContent = cursor
        ? "More events available; partial day. Load more to continue."
        : "Complete loaded pages.";
      const info = text("details", "", "dashboard-timeline-info");
      info.append(
        text("summary", "About this timeline"),
        text(
          "p",
          `All authorized event types · ${date} · device timezone. Occurrence times, not activity duration. Historical aggregate events may not contain individual sets/items; no reconstruction is inferred. Use arrows to navigate, Enter to select, Escape to dismiss. Tap a cluster to choose an event.`,
        ),
      );
      status.hidden = !cursor;
      target.replaceChildren(
        text("h3", `Day timeline · ${date}`, "dashboard-timeline-heading"),
        status,
      );
      renderEventTimeline(target, items, users, start, end, adminKey);
      target.append(info);
      if (cursor) {
        const more = text("button", "Load more events");
        more.type = "button";
        more.onclick = () => {
          more.disabled = true;
          void loadTimeline(adminKey, { users, items, cursor, coverage });
        };
        target.append(more);
      }
      if (coverage && typeof coverage === "object") {
        const summary = text("details");
        summary.append(text("summary", "Backend event coverage"));
        // Coverage is a bounded backend DTO, not raw source activity data.
        summary.append(
          text("pre", JSON.stringify(coverage, null, 2).slice(0, 8000)),
        );
        target.append(summary);
      }
      filterTimeline();
    } catch (error) {
      if (!live()) return;
      timelinePending = false;
      if (denied(error)) {
        $("dashboardMapSelection").replaceChildren();
        selectionEpoch++;
        filterTimeline = () => {};
        timelineResize?.disconnect();
        target.replaceChildren(status);
        timelineInteraction = () => {};
      } else {
        timelineInteraction(true);
      }
      status.textContent = `Timeline unavailable${error.status ? ` (${error.status})` : ""}; try again.${!denied(error) && target.querySelector(".dashboard-timeline-track") ? " Retained events are stale; authorization could not be refreshed." : ""}`;
      const retry = text("button", "Retry timeline");
      retry.type = "button";
      retry.onclick = () => void loadTimeline(adminKey);
      target.append(retry);
    }
  }
  async function loadMap(adminKey) {
    selectionEpoch++;
    linkActivity = () => {};
    purgeMapMember = () => {};
    removeMapActivity = () => {};
    void loadTimeline(adminKey);
    mapEpoch++;
    mapController?.abort();
    mapController = new AbortController();
    const signal = mapController.signal,
      id = mapEpoch;
    const live = () => !signal.aborted && id === mapEpoch;
    const map = $("dashboardMap"),
      selection = $("dashboardMapSelection"),
      status = $("dashboardMapStatus");
    if (!map || !selection || !status) return;
    disposeMap();
    filterMap = () => {};
    renderMemberCards();
    map.replaceChildren();
    selection.replaceChildren();
    status.removeAttribute("data-tone");
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
    const deniedMembers = new Set();
    let avatarLimited = false;
    const startAvatars = () => {
      // No per-activity reads; bound requests per load and concurrent BFF reads.
      // Remaining members retain their initials badge rather than silently requesting 5000 images.
      const avatarMembers = [...mapMembers.keys()].filter((id) =>
        /^[0-9a-f]{24}$/.test(id),
      );
      const avatarQueue = avatarMembers.slice(0, 80);
      avatarLimited = avatarMembers.length > avatarQueue.length;
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
              deniedMembers.has(memberId) ||
              !mapMembers.has(memberId) ||
              blob.size > 1024 * 1024 ||
              !blob.size
            )
              continue;
            const url = URL.createObjectURL(blob);
            avatarUrls.push(url);
            avatarCache.set(memberId, url);
            for (const pin of [
              ...map.querySelectorAll(".dashboard-member-pin"),
              ...$("dashboardMemberCards").querySelectorAll(
                ".dashboard-member-portrait",
              ),
            ]) {
              if (pin.dataset.memberId !== memberId) continue;
              const image = text(
                "img",
                "",
                pin.classList.contains("dashboard-member-portrait")
                  ? "dashboard-roster-image"
                  : "dashboard-map-avatar",
              );
              image.alt = "";
              image.src = url;
              image.onerror = () => image.remove();
              pin.prepend(image);
            }
          } catch {
            /* revoked access, aborted date, or unavailable image: initials remain */
          }
        }
      };
      for (let worker = 0; worker < Math.min(2, avatarQueue.length); worker++)
        void readAvatar();
    };
    // The roster is not date-scoped: request it at once so authorized member
    // cards never wait on, or disappear with, the map read or Leaflet. Only
    // this separately authorized endpoint may create profile pins.
    const rosterReady = request("dashboard/members")
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
        if (!live()) return { latestPositions: [], note: "" };
        const code = error?.status ? ` (${error.status})` : "";
        let note = "Member cards use the separately authorized roster.";
        if (members) rosterCache = members;
        else if (denied(error)) {
          rosterCache = null;
          note = `Member roster access denied${code}; roster stats and positions removed.`;
        } else
          note = rosterCache
            ? `Member roster refresh failed${code}; showing previously loaded members and positions.`
            : `Member roster unavailable${code}; member cards show loaded shared data only.`;
        mapMembers = new Map(
          [...(rosterCache || [])].filter(([id]) => !suppressedMembers.has(id)),
        );
        renderMemberCards();
        startAvatars();
        return {
          fresh: !!members,
          note,
          latestPositions: [...mapMembers.values()].filter(
            (m) =>
              position(m.last_position?.position) &&
              Number.isFinite(Date.parse(m.last_position.occurred_at)) &&
              Date.parse(m.last_position.occurred_at) <= Date.now(),
          ),
        };
      });
    const fail = async (message) => {
      status.dataset.tone = "error";
      status.textContent = message;
      const { note } = await rosterReady;
      if (live()) status.textContent = `${message} ${note}`;
    };
    const date = $("dashboardMapDate").value;
    if (!validDay(date)) return fail("Choose a valid activity creation date.");
    const [year, month, day] = date.split("-").map(Number);
    const start = new Date(0);
    start.setFullYear(year, month - 1, day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const startMs = start.getTime(),
      endMs = end.getTime();
    status.textContent = `Loading authorized positions for ${date} (activity creation date in your device timezone)…`;
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

    try {
      const users = new Map(),
        byMember = new Map();
      let cursor,
        count = 0,
        pages = 0;
      const seenActivities = new Set();
      do {
        const query = new URLSearchParams({
          date,
          start: start.toISOString(),
          end: end.toISOString(),
        });
        if (cursor) query.set("cursor", cursor);
        const data = await request(`dashboard/map?${query}`);
        if (!live()) return;
        if (
          !Array.isArray(data.users) ||
          !Array.isArray(data.activities) ||
          typeof data.hasMore !== "boolean"
        )
          throw new Error("Invalid map response.");
        for (const user of data.users)
          if (typeof user?._id === "string") users.set(user._id, user);
        for (const activity of data.activities) {
          if (count >= 5000)
            throw new Error(
              "Selected date exceeds the safe map display limit.",
            );
          if (
            typeof activity?._id !== "string" ||
            typeof activity?.user_id !== "string" ||
            !position(activity.position) ||
            !Number.isFinite(Date.parse(activity.created_at)) ||
            Date.parse(activity.created_at) < startMs ||
            Date.parse(activity.created_at) >= endMs ||
            seenActivities.has(activity._id)
          )
            throw new Error(
              "Invalid or repeated positioned activity in map response.",
            );
          seenActivities.add(activity._id);
          count++;
          if (!byMember.has(activity.user_id))
            byMember.set(activity.user_id, []);
          byMember.get(activity.user_id).push(activity);
        }
        pages++;
        const next = data.nextCursor;
        if (
          data.hasMore &&
          (pages >= 50 || typeof next !== "string" || !next || next === cursor)
        )
          throw new Error(
            "Map date is too large or its cursor did not advance.",
          );
        cursor = data.hasMore ? next : undefined;
      } while (cursor && live());
      if (!live()) return;
      // A date-scoped map cannot establish global last-known position.
      const roster = await rosterReady;
      if (!live()) return;
      const { latestPositions } = roster;
      const entriesWithPins = [];
      const badges = new Map();
      for (const [memberId, entries] of byMember) {
        if (suppressedMembers.has(memberId)) continue;
        const name = users.get(memberId)?.display_name || "Member";
        const initials = (name.match(/[\p{L}\p{N}]+/gu) || ["M"])
          .slice(-2)
          .map((word) => word[0].toUpperCase())
          .join("");
        const seen = badges.get(initials) || 0;
        badges.set(initials, seen + 1);
        const badge = initials + (seen ? seen + 1 : "");
        const hue =
          ([...memberId].reduce(
            (hash, char) => Math.imul(hash ^ char.codePointAt(0), 16777619),
            2166136261,
          ) >>>
            0) %
          360;
        for (const entry of entries) {
          const marker = text(
            "button",
            "•",
            "dashboard-map-marker dashboard-activity-pin",
          );
          marker.type = "button";
          marker.dataset.memberId = memberId;
          marker.style.backgroundColor = `hsl(${hue} 64% 28%)`;
          marker.setAttribute(
            "aria-label",
            `${name} activity: ${entry.name || entry.type || "Activity"}`,
          );
          marker.dataset.activityId = entry._id;
          marker.setAttribute("aria-pressed", "false");
          marker.addEventListener(
            "click",
            () => void selectActivity(entry, name, adminKey),
          );
          const anchor = text("span", "", "dashboard-map-anchor");
          const link = text("span", "", "dashboard-map-pin-link");
          overlay.append(link, anchor, marker);
          entriesWithPins.push({ entry, marker, anchor, link });
        }
      }
      for (const member of latestPositions) {
        const name =
          member.display_name ||
          users.get(member._id)?.display_name ||
          "Member";
        const stamp = Date.parse(member.last_position.occurred_at);
        const localDay = (date) =>
          Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
        const elapsed = Math.max(
          0,
          Math.round(
            (localDay(new Date()) - localDay(new Date(stamp))) / 86400000,
          ),
        );
        const age =
          elapsed === 0
            ? "today"
            : `${elapsed} day${elapsed === 1 ? "" : "s"} ago`;
        const marker = text(
          "button",
          (name.match(/[\p{L}\p{N}]+/gu) || ["M"])
            .slice(-2)
            .map((s) => s[0].toUpperCase())
            .join(""),
          "dashboard-member-pin",
        );
        marker.type = "button";
        marker.dataset.memberId = member._id;
        marker.setAttribute(
          "aria-label",
          `${name} latest authorized position, from positioned activity ${age}`,
        );
        const avatar = avatarCache.get(member._id);
        if (avatar) {
          const image = text("img", "", "dashboard-map-avatar");
          image.alt = "";
          image.src = avatar;
          image.onerror = () => image.remove();
          marker.prepend(image);
        }
        // Inside the pin, so hiding, filtering or revoking it removes the note.
        marker.append(
          text(
            "span",
            `Position from activity ${age} · not live`,
            "dashboard-member-pin-note",
          ),
        );
        marker.addEventListener("click", () => {
          selectedMember = member._id;
          selectionEpoch++;
          selection.replaceChildren(
            text(
              "p",
              `${name} · position from activity ${age}. Select an activity pin for freshly authorized detail.`,
            ),
          );
          renderMemberCards();
          filterMap(false);
          filterFeed();
          filterTimeline();
        });
        const anchor = text("span", "", "dashboard-map-anchor");
        const link = text("span", "", "dashboard-map-pin-link");
        overlay.append(link, anchor, marker);
        entriesWithPins.push({
          entry: {
            user_id: member._id,
            position: member.last_position.position,
          },
          marker,
          anchor,
          link,
        });
      }
      const removePins = (predicate) => {
        for (const pin of entriesWithPins.filter(({ entry }) =>
          predicate(entry),
        )) {
          pin.marker.remove();
          pin.anchor.remove();
          pin.link.remove();
        }
      };
      purgeMapMember = (memberId) =>
        removePins((entry) => entry.user_id === memberId);
      removeMapActivity = (activityId) =>
        removePins((entry) => entry._id === activityId);
      linkActivity = (detail, pan) => {
        const pin = entriesWithPins.find(
          ({ entry, marker }) => entry._id === detail._id && marker.isConnected,
        );
        if (!pin) return;
        if (
          !position(detail.position) ||
          detail.position.latitude !== pin.entry.position.latitude ||
          detail.position.longitude !== pin.entry.position.longitude
        ) {
          removeMapActivity(detail._id);
          $("dashboardMapSelection").append(
            text(
              "p",
              "Map position unavailable or location changed. Refresh the map to recheck sharing.",
              "hint",
            ),
          );
          return;
        }
        if (pan)
          instance.panTo(
            [detail.position.latitude, detail.position.longitude],
            {
              animate: false,
            },
          );
      };
      let initialView;
      filterMap = (clearSelection = true) => {
        if (clearSelection) {
          selectionEpoch++;
          selection.replaceChildren();
        }
        for (const { entry, marker, anchor, link } of entriesWithPins) {
          const visible = !selectedMember || entry.user_id === selectedMember;
          marker.classList.toggle("dashboard-filtered", !visible);
          anchor.classList.toggle("dashboard-filtered", !visible);
          link.classList.toggle("dashboard-filtered", !visible);
        }
        if (clearSelection && selectedMember) {
          const latest = latestPositions.find((m) => m._id === selectedMember);
          if (latest)
            instance.setView(
              [
                latest.last_position.position.latitude,
                latest.last_position.position.longitude,
              ],
              14,
            );
        } else if (clearSelection && initialView) {
          instance.setView(initialView.center, initialView.zoom);
        }
        placePins();
      };
      const placePins = () => {
        if (!live()) return;
        const placed = [];
        for (const { entry, marker, anchor, link } of entriesWithPins) {
          if (
            !marker.isConnected ||
            marker.classList.contains("dashboard-filtered")
          ) {
            if (!marker.isConnected) {
              anchor.remove();
              link.remove();
            }
            continue;
          }
          const longitude =
            entry.position.longitude +
            360 *
              Math.round(
                (instance.getCenter().lng - entry.position.longitude) / 360,
              );
          const point = instance.latLngToContainerPoint([
            entry.position.latitude,
            longitude,
          ]);
          if (
            point.x < 0 ||
            point.x > map.clientWidth ||
            point.y < 0 ||
            point.y > map.clientHeight
          ) {
            marker.hidden = true;
            anchor.hidden = true;
            link.hidden = true;
            continue;
          }
          marker.hidden = false;
          let dx = 0,
            dy = 0;
          let insideFallback;
          for (let slot = 0; slot < 200; slot++) {
            const column = slot % 5,
              row = Math.floor(slot / 5);
            const candidateDx =
              column * 42 * (point.x > map.clientWidth / 2 ? -1 : 1);
            const candidateDy =
              row * 42 * (point.y > map.clientHeight / 2 ? -1 : 1);
            const candidateX = point.x + candidateDx,
              candidateY = point.y + candidateDy;
            if (
              candidateX < 18 ||
              candidateX > map.clientWidth - 18 ||
              candidateY < 18 ||
              candidateY > map.clientHeight - 18
            )
              continue;
            insideFallback = [candidateDx, candidateDy];
            if (
              placed.every(
                ([x, y]) =>
                  Math.abs(candidateX - x) >= 38 ||
                  Math.abs(candidateY - y) >= 38,
              )
            ) {
              dx = candidateDx;
              dy = candidateDy;
              insideFallback = undefined;
              break;
            }
          }
          if (insideFallback) [dx, dy] = insideFallback;
          placed.push([point.x + dx, point.y + dy]);
          marker.style.left = `${point.x + dx}px`;
          marker.style.top = `${point.y + dy}px`;
          anchor.style.left = `${point.x}px`;
          anchor.style.top = `${point.y}px`;
          anchor.hidden = !(dx || dy);
          link.hidden = !(dx || dy);
          link.style.left = `${point.x}px`;
          link.style.top = `${point.y}px`;
          link.style.width = `${Math.hypot(dx, dy)}px`;
          link.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
        }
      };
      instance.on("move zoom resize", placePins);
      const fitPins = (pins) => {
        if (!pins.length) return;
        const longitudes = pins
          .map(({ entry }) => (entry.position.longitude + 360) % 360)
          .sort((a, b) => a - b);
        let arcStart = longitudes[0];
        if (longitudes.length > 1) {
          let largestGap = -1;
          for (let i = 0; i < longitudes.length; i++) {
            const next =
              i + 1 < longitudes.length
                ? longitudes[i + 1]
                : longitudes[0] + 360;
            if (next - longitudes[i] > largestGap) {
              largestGap = next - longitudes[i];
              arcStart = next % 360;
            }
          }
        }
        const coords = pins.map(({ entry }) => {
          const wrapped = (entry.position.longitude + 360) % 360;
          return [
            entry.position.latitude,
            wrapped < arcStart ? wrapped + 360 : wrapped,
          ];
        });
        if (coords.length === 1)
          instance.setView(
            [coords[0][0], pins[0].entry.position.longitude],
            16,
            { animate: false },
          );
        else
          instance.fitBounds(L.latLngBounds(coords), {
            padding: [48, 48],
            maxZoom: 16,
            animate: false,
          });
      };
      mapResizeObserver = new ResizeObserver(() => {
        instance.invalidateSize();
        placePins();
        const active = entriesWithPins.filter(
          ({ marker }) =>
            marker.isConnected &&
            !marker.classList.contains("dashboard-filtered"),
        );
        // A desktop fit may leave every marker offscreen when the map narrows.
        // Refit only then, preserving deliberate user panning when one is visible.
        if (active.length && active.every(({ marker }) => marker.hidden)) {
          fitPins(active);
          if (!selectedMember)
            initialView = {
              center: instance.getCenter(),
              zoom: instance.getZoom(),
            };
          placePins();
        }
      });
      mapResizeObserver.observe(map);
      const boundsPins = entriesWithPins.filter(({ marker }) =>
        marker.classList.contains("dashboard-activity-pin"),
      );
      const fittedPins = boundsPins.length ? boundsPins : entriesWithPins;
      fitPins(fittedPins);
      initialView = { center: instance.getCenter(), zoom: instance.getZoom() };
      placePins();
      filterMap();
      status.textContent = `${date} activity creation date (device timezone) · ${byMember.size} members with authorized position · ${count} activities · complete selected date as loaded (not live). ${roster.fresh ? "Latest profile pins are separately authorized and may be older than this date." : roster.note}${avatarLimited ? " Profile pictures limited to the first 80 members; remaining pins show initials." : ""}`;
    } catch (error) {
      if (live()) await fail(`Map unavailable: ${error.message}`);
    }
  }
  async function load(_api, adminKey) {
    clear();
    if ($("dashboardMapDate")?.type === "date") {
      const dateInput = $("dashboardMapDate");
      const today = new Date();
      dateInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      bindDateNavigation(adminKey);
      void loadMap(adminKey);
    }
    const id = epoch;
    controller = new AbortController();
    const signal = controller.signal;
    const live = () => id === epoch && !signal.aborted;
    const request = async (path, binary = false) => {
      const response = await dashboardFetch("/api/" + path, {
        headers: { Authorization: "Bearer " + adminKey },
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok)
        throw httpError(
          denied(response)
            ? `REST request denied (${response.status}). Renew the saved Coach credential with ordinary REST access if needed.`
            : `REST request failed (${response.status}); try again shortly.`,
          response.status,
        );
      return binary ? response.blob() : response.json();
    };
    const users = new Map(),
      activities = new Map(),
      series = new Map(),
      latestPhotos = new Map(),
      photoTiles = new Map();
    let detailError = null;
    const revoked = new Set();
    forgetMember = (memberId) => {
      suppressedMembers.add(memberId);
      filterTimeline();
      purgeMapMember(memberId);
      revoked.add(memberId);
      users.delete(memberId);
      feedMembers.delete(memberId);
      for (const [key, activity] of activities)
        if (activity.user_id === memberId) activities.delete(key);
      for (const [key, value] of series)
        if (value.member_id === memberId) series.delete(key);
      latestPhotos.delete(memberId);
      const tile = photoTiles.get(memberId);
      if (tile) {
        for (const image of tile.querySelectorAll("img")) {
          const index = urls.indexOf(image.src);
          if (index !== -1) {
            URL.revokeObjectURL(image.src);
            urls.splice(index, 1);
          }
        }
        tile.remove();
        photoTiles.delete(memberId);
      }
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
      const tile = text("article", "", "dashboard-tile");
      tile.dataset.memberId = activity.user_id;
      tile.append(
        text("h4", users.get(activity.user_id)?.display_name || "Member"),
        text("p", activity.name || activity.type || "Activity"),
        text(
          "p",
          [activity.status, activity.completed_at || activity.created_at]
            .filter(Boolean)
            .join(" · "),
          "hint",
        ),
      );

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
        const envelope = await request(
          "dashboard/activity?" + new URLSearchParams({ id: activity._id }),
        );
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
        // Accumulate all loaded chart inputs; only the latest check-in is a gallery.
        if (latestPhotos.get(activity.user_id)?._id !== activity._id) return;
        const photos = (
          Array.isArray(detail.data.files) ? detail.data.files : []
        ).filter(isPhoto);
        if (!photos.length) return;
        photoTiles.get(activity.user_id)?.remove();
        photoTiles.set(activity.user_id, tile);
        $("dashboardRoster").append(tile);
        tile.hidden = !!selectedMember && selectedMember !== activity.user_id;
        const gallery = text("div", "", "dashboard-gallery");
        tile.append(gallery);
        for (const [index, photo] of photos.slice(0, 32).entries()) {
          const frame = text("div", "", "dashboard-photo");
          gallery.append(frame);
          try {
            const blob = await request(
              "dashboard/photo?" +
                new URLSearchParams({
                  activity_id: activity._id,
                  file_id: photo._id || photo.id,
                }),
              true,
            );
            if (!live() || revoked.has(activity.user_id)) return;
            const url = URL.createObjectURL(blob);
            urls.push(url);
            const image = document.createElement("img");
            image.alt = `Progress photo ${index + 1} of ${photos.length} for ${users.get(activity.user_id)?.display_name || "Member"}`;
            image.src = url;
            image.addEventListener("error", () => {
              if (live())
                frame.replaceChildren(text("p", "Photo could not be decoded."));
            });
            frame.append(image);
          } catch (error) {
            // A confirmed media denial applies to this member's already
            // rendered frames too; let the outer handler purge and revoke.
            if (denied(error)) throw error;
            if (live()) frame.append(text("p", error.message));
          }
        }
        if (photos.length > 32)
          gallery.append(
            text(
              "p",
              `Showing 32 of ${photos.length} photos; gallery display limit.`,
            ),
          );
      } catch (error) {
        if (live()) {
          if (denied(error)) {
            // Fail closed: purge this member's cached detail-derived charts
            // and photos, and skip their later details this load. The map
            // snapshot may be stale too; drop it rather than retaining
            // coordinates after a fresh authorization denial.
            forgetMember(activity.user_id);
            mapMembers.delete(activity.user_id);
            rosterCache?.delete(activity.user_id);
            renderMemberCards();
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
      for (const tile of $("dashboardRoster").querySelectorAll(
        ".dashboard-tile",
      ))
        tile.hidden =
          !!selectedMember && tile.dataset.memberId !== selectedMember;
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
          if (
            activity.type === "media" &&
            Array.isArray(activity.data?.files) &&
            activity.data.files.some(isPhoto) &&
            ["complete", "completed"].includes(activity.status)
          ) {
            const previous = latestPhotos.get(activity.user_id);
            const stamp = Date.parse(
              activity.completed_at || activity.created_at,
            );
            const prior =
              previous &&
              Date.parse(previous.completed_at || previous.created_at);
            if (
              Number.isFinite(stamp) &&
              (!previous ||
                stamp > prior ||
                (stamp === prior && activity._id > previous._id))
            )
              latestPhotos.set(activity.user_id, activity);
          }
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
            `${users.size} people in loaded feed · ${activities.size} loaded activities (200 activity limit). Not a complete roster. Photos: latest completed check-in per member among loaded data only.`,
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
    $("dashboardRoster").after(more);
    signal.addEventListener("abort", () => more.remove(), { once: true });
    await page();
  }
  return { clear, load };
})();
