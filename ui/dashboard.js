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
  const urls = [];
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  function clear() {
    epoch++;
    controller?.abort();
    controller = undefined;
    mapEpoch++;
    mapController?.abort();
    mapController = undefined;
    disposeMap();
    $("dashboardMap")?.replaceChildren();
    $("dashboardMapSelection")?.replaceChildren();
    if ($("dashboardMapStatus")) $("dashboardMapStatus").textContent = "";
    observer?.disconnect();
    observer = undefined;
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    $("dashboardRoster").replaceChildren();
    $("dashboardCharts").replaceChildren();
    $("dashboardCoverage").replaceChildren();
    $("dashboardCoverage").hidden = true;
    $("dashboardStatus").textContent = "Open Dashboard to load shared data.";
  }
  function disposeMap() {
    mapResizeObserver?.disconnect();
    mapResizeObserver = undefined;
    leafletMap?.remove();
    leafletMap = undefined;
    for (const url of avatarUrls.splice(0)) URL.revokeObjectURL(url);
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
    const points = series.points;
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
  async function loadMap(adminKey) {
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
    map.replaceChildren();
    selection.replaceChildren();
    const date = $("dashboardMapDate").value;
    if (!validDay(date)) {
      status.textContent = "Choose a valid activity creation date.";
      return;
    }
    const [year, month, day] = date.split("-").map(Number);
    const start = new Date(0);
    start.setFullYear(year, month - 1, day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const startMs = start.getTime(),
      endMs = end.getTime();
    status.textContent = `Loading authorized positions for ${date} (activity creation date in your device timezone)…`;
    const request = async (path) => {
      const response = await fetch(`/api/${path}`, {
        headers: { Authorization: `Bearer ${adminKey}` },
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(`Authorized map read denied (${response.status}).`);
      return response.json();
    };
    if (!window.L) {
      status.textContent = "Map unavailable: Leaflet could not load.";
      return;
    }
    const L = window.L;
    const instance = L.map(map, { zoomControl: true, worldCopyJump: true });
    leafletMap = instance;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(instance);
    instance.setView([0, 0], 2); // Neutral initial view; never request device location.
    const overlay = text("div", "", "dashboard-map-overlay");
    map.append(overlay);
    let selectionEpoch = 0;
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
      const entriesWithPins = [];
      const badges = new Map();
      const stillOnMap = (detail, entry) =>
        detail?._id === entry._id &&
        detail?.user_id === entry.user_id &&
        position(detail.position) &&
        detail.position.latitude === entry.position.latitude &&
        detail.position.longitude === entry.position.longitude &&
        Number.isFinite(Date.parse(detail.created_at)) &&
        Date.parse(detail.created_at) >= startMs &&
        Date.parse(detail.created_at) < endMs;
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
            text(
              "p",
              `Completed sets: ${detail.workout_progress.completed_sets}`,
            ),
          );
        if (detail.type === "meal") {
          for (const [field, unit] of [
            ["calories", "kcal"],
            ["protein", "g"],
          ])
            if (Number.isFinite(detail.nutrition_summary?.[field]))
              rows.push(
                text(
                  "p",
                  `${field}: ${detail.nutrition_summary[field]} ${unit}`,
                ),
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
            `Position: ${detail.position.latitude}, ${detail.position.longitude}`,
            "hint",
          ),
        );
        rows.push(
          text(
            "p",
            "Position reauthorized for this read; map pin is not a live location.",
            "hint",
          ),
        );
        selection.replaceChildren(...rows);
      }
      const avatarCache = new Map();
      // No per-activity reads; bound requests per selected date and concurrent BFF reads.
      // Remaining members retain their initials badge rather than silently requesting 5000 images.
      const avatarMembers = [...byMember.keys()].filter((id) =>
        /^[0-9a-f]{24}$/.test(id),
      );
      const avatarQueue = avatarMembers.slice(0, 80);
      let avatarIndex = 0;
      const readAvatar = async () => {
        while (live() && avatarIndex < avatarQueue.length) {
          const memberId = avatarQueue[avatarIndex++];
          try {
            const response = await fetch(
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
            if (!live() || blob.size > 1024 * 1024 || !blob.size) continue;
            const url = URL.createObjectURL(blob);
            avatarUrls.push(url);
            avatarCache.set(memberId, url);
            for (const pin of overlay.querySelectorAll(
              ".dashboard-map-marker",
            )) {
              if (pin.dataset.memberId !== memberId) continue;
              const image = text("img", "", "dashboard-map-avatar");
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
      for (const [memberId, entries] of byMember) {
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
          const marker = text("button", badge, "dashboard-map-marker");
          marker.type = "button";
          marker.dataset.memberId = memberId;
          marker.style.backgroundColor = `hsl(${hue} 64% 28%)`;
          marker.setAttribute(
            "aria-label",
            `${name} activity: ${entry.name || entry.type || "Activity"}`,
          );
          const photo = avatarCache.get(memberId);
          if (photo) {
            const image = text("img", "", "dashboard-map-avatar");
            image.alt = "";
            image.src = photo;
            image.onerror = () => image.remove();
            marker.prepend(image);
          }
          marker.addEventListener("click", async () => {
            selectionEpoch++;
            const choiceId = selectionEpoch;
            selection.replaceChildren(
              text("p", "Checking current position access…"),
            );
            try {
              const envelope = await request(
                `dashboard/activity?${new URLSearchParams({ id: entry._id })}`,
              );
              if (!live() || choiceId !== selectionEpoch) return;
              if (
                envelope.owner?._id !== memberId ||
                !stillOnMap(envelope.activity, entry)
              )
                throw new Error("Position unavailable.");
              showDetail(envelope.activity, name);
            } catch (error) {
              if (!live() || choiceId !== selectionEpoch) return;
              marker.remove();
              anchor.remove();
              link.remove();
              selection.replaceChildren(
                text(
                  "p",
                  "Activity or position unavailable, denied, or location changed. Refresh the map to recheck sharing.",
                ),
              );
            }
          });
          const anchor = text("span", "", "dashboard-map-anchor");
          const link = text("span", "", "dashboard-map-pin-link");
          overlay.append(link, anchor, marker);
          entriesWithPins.push({ entry, marker, anchor, link });
        }
      }
      const placePins = () => {
        if (!live()) return;
        const placed = [];
        for (const { entry, marker, anchor, link } of entriesWithPins) {
          if (!marker.isConnected) {
            anchor.remove();
            link.remove();
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
      mapResizeObserver = new ResizeObserver(() => {
        instance.invalidateSize();
        placePins();
      });
      mapResizeObserver.observe(map);
      const longitudes = entriesWithPins
        .map(({ entry }) => (entry.position.longitude + 360) % 360)
        .sort((a, b) => a - b);
      let arcStart = longitudes[0];
      if (longitudes.length > 1) {
        let largestGap = -1;
        for (let i = 0; i < longitudes.length; i++) {
          const next =
            i + 1 < longitudes.length ? longitudes[i + 1] : longitudes[0] + 360;
          if (next - longitudes[i] > largestGap) {
            largestGap = next - longitudes[i];
            arcStart = next % 360;
          }
        }
      }
      const coords = entriesWithPins.map(({ entry }) => {
        const wrapped = (entry.position.longitude + 360) % 360;
        return [
          entry.position.latitude,
          wrapped < arcStart ? wrapped + 360 : wrapped,
        ];
      });
      if (coords.length === 1)
        instance.setView(
          [coords[0][0], entriesWithPins[0].entry.position.longitude],
          16,
        );
      else if (coords.length)
        instance.fitBounds(L.latLngBounds(coords), {
          padding: [48, 48],
          maxZoom: 16,
        });
      placePins();
      status.textContent = `${date} activity creation date (device timezone) · ${byMember.size} members with authorized position · ${count} activities · complete selected date as loaded (not live).${avatarMembers.length > avatarQueue.length ? " Profile pictures limited to the first 80 members; remaining pins show initials." : ""}`;
    } catch (error) {
      if (live()) status.textContent = `Map unavailable: ${error.message}`;
    }
  }
  async function load(_api, adminKey) {
    clear();
    if ($("dashboardMapDate")?.type === "date") {
      const dateInput = $("dashboardMapDate");
      const today = new Date();
      dateInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      dateInput.onchange = () => void loadMap(adminKey);
      void loadMap(adminKey);
    }
    const id = epoch;
    controller = new AbortController();
    const signal = controller.signal;
    const live = () => id === epoch && !signal.aborted;
    const request = async (path, binary = false) => {
      const response = await fetch("/api/" + path, {
        headers: { Authorization: "Bearer " + adminKey },
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `REST request denied (${response.status}). Renew the saved Coach credential with ordinary REST access if needed.`,
        );
      return binary ? response.blob() : response.json();
    };
    const users = new Map(),
      activities = new Map(),
      series = new Map(),
      latestPhotos = new Map(),
      photoTiles = new Map();
    let detailError = null;
    const addPoint = (activity, label, unit, value, average = false) => {
      if (!Number.isFinite(value)) return;
      const stamp = activity.completed_at || activity.created_at;
      if (!stamp || !Number.isFinite(Date.parse(stamp))) return;
      const date = new Date(stamp).toISOString().slice(0, 10);
      const key = JSON.stringify([activity.user_id, label, unit]);
      if (!series.has(key))
        series.set(key, {
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
          "Loaded activities only, not a complete history or adherence. UTC completion day (creation-date fallback). Nutrition uses available recorded summaries; missing values are not zero. Body points use explicit recorded units or verified Health Connect stored lb; units are never inferred from photos.",
          "hint",
        ),
      );
      const grid = text("div", "", "dashboard-graphs");
      for (const s of series.values())
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
      graphs.append(grid);
      if (!series.size)
        graphs.append(
          text(
            "p",
            "Trend measurements unavailable in the loaded activities.",
            "hint",
          ),
        );
    }
    async function renderActivity(activity) {
      const tile = text("article", "", "dashboard-tile");
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
      if (
        activity.type === "media" &&
        latestPhotos.get(activity.user_id)?._id !== activity._id
      )
        return;
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
        if (!live()) return;
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
            } else if (
              !(m.type_id === "fat_percentage" && unit === "%" && value <= 100)
            )
              continue;
            addPoint(pointActivity, m.type_id, unit, value, true);
          }
          return;
        }
        const photos = (
          Array.isArray(detail.data.files) ? detail.data.files : []
        ).filter(isPhoto);
        if (!photos.length) return;
        photoTiles.get(activity.user_id)?.remove();
        photoTiles.set(activity.user_id, tile);
        $("dashboardRoster").append(tile);
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
            if (!live()) return;
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
          detailError ||= error.message;
          $("dashboardStatus").textContent =
            `Partial dashboard — activity details could not be loaded: ${detailError}`;
        }
      }
    }
    let before,
      loading = false;
    const more = text("button", "Load older activities", "secondary");
    async function page() {
      if (loading || !live()) return;
      loading = true;
      more.disabled = true;
      $("dashboardStatus").textContent = "Loading shared dashboard…";
      try {
        const data = await request(
          "dashboard" + (before ? "?" + new URLSearchParams({ before }) : ""),
        );
        if (!live()) return;
        if (!Array.isArray(data.users) || !Array.isArray(data.activities))
          throw new Error("Invalid feed response.");
        for (const user of data.users) users.set(user._id, user);
        const added = [];
        for (const activity of data.activities) {
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
        if (live()) $("dashboardStatus").textContent = error.message;
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
