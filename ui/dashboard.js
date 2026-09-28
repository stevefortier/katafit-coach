/* Standalone Coach Dashboard; all values arrive from an authorized snapshot. */
window.CoachDashboard = (() => {
  const $ = (id) => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  let epoch = 0;
  let controller;
  let observer;
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
    observer?.disconnect();
    observer = undefined;
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    $("dashboardRoster").replaceChildren();
    $("dashboardCharts").replaceChildren();
    $("dashboardCoverage").replaceChildren();
    $("dashboardCoverage").hidden = true;
    $("dashboardStatus").textContent = "Open Dashboard to load shared data.";
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
  async function load(_api, adminKey) {
    clear();
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
      series = new Map();
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
          "Loaded activities only, not a complete history or adherence. UTC completion day (creation-date fallback). Nutrition uses available recorded summaries; missing values are not zero. Body points use explicit recorded units; units are never inferred from photos.",
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
      $("dashboardRoster").append(tile);
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
      if (!["media", "metric"].includes(activity.type)) return;
      // Feed files are preview refs, not complete inventories. Detail is a new
      // ordinary backend fetch, not a local sharing/source-proof decision.
      try {
        const detail = await request(
          "dashboard/activity?" + new URLSearchParams({ id: activity._id }),
        );
        if (!live()) return;
        if (activity.type === "metric") {
          let count = 0;
          for (const m of detail.data?.measurements || []) {
            if (
              typeof m.unit !== "string" ||
              !m.unit ||
              !Number.isFinite(m.value)
            )
              continue;
            addPoint(
              activity,
              m.name || m.type_id || "Measurement",
              m.unit,
              m.value,
              true,
            );
            count++;
          }
          if (!count)
            tile.append(
              text(
                "p",
                "Body trend unavailable: no numeric measurements with explicit units.",
                "hint",
              ),
            );
          return;
        }
        const photos = (detail.data?.files || []).filter(
          (f) => f.type === "image" || /^image\/(jpeg|png|webp)$/.test(f.type),
        );
        const gallery = text("div", "", "dashboard-gallery");
        tile.append(gallery);
        if (!photos.length)
          gallery.append(text("p", "No supported photos in this activity."));
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
        if (live()) tile.append(text("p", error.message));
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
        for (const activity of data.activities) {
          if (activities.has(activity._id)) continue;
          if (activities.size >= 200) break;
          activities.set(activity._id, activity);
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
        $("dashboardStatus").textContent = data.hasMore
          ? "More activities available — partial history shown."
          : "Shared dashboard loaded. Loaded feed coverage only.";
        const coverage = $("dashboardCoverage");
        coverage.hidden = false;
        coverage.replaceChildren(
          text(
            "span",
            `${users.size} members · ${activities.size} loaded activities`,
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
