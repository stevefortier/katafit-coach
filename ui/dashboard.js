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
  async function load(api, adminKey) {
    clear();
    const id = epoch;
    controller = new AbortController();
    const signal = controller.signal;
    $("dashboardStatus").textContent = "Loading shared dashboard…";
    try {
      const data = await api("dashboard", undefined, signal);
      if (
        id !== epoch ||
        signal.aborted ||
        document.hidden ||
        $("dashboardPanel").hidden
      )
        return;
      const { coverage, members, series } = data;
      $("dashboardStatus").textContent = coverage.complete
        ? "Shared dashboard loaded."
        : "Partial roster coverage — some members are not included in this snapshot.";
      const summary = $("dashboardCoverage");
      summary.hidden = false;
      summary.append(
        text(
          "span",
          coverage.complete
            ? `${members.length} roster members`
            : `${members.length} shown · more members not loaded`,
        ),
        text("span", `${coverage.media_shared} media-shared among shown`),
        text(
          "span",
          `${coverage.category_shared.training} training-shared among shown`,
        ),
        text(
          "span",
          `${coverage.category_shared.nutrition} nutrition-shared among shown`,
        ),
        text(
          "span",
          `${coverage.category_shared.body} body-shared among shown`,
        ),
        text(
          "span",
          coverage.complete
            ? "Complete roster snapshot"
            : "Partial roster snapshot",
        ),
      );
      const roster = $("dashboardRoster");
      const pendingPhotos = [];
      let fetching = false;
      const nextPhoto = async () => {
        if (fetching || !pendingPhotos.length || id !== epoch || signal.aborted)
          return;
        fetching = true;
        const { member, photo, frame, img } = pendingPhotos.shift();
        try {
          const query = new URLSearchParams({
            member_ref: member.member_ref,
            media_ref: photo.media_ref,
          });
          const response = await fetch(`/api/dashboard/photo?${query}`, {
            headers: { Authorization: "Bearer " + adminKey },
            signal,
            cache: "no-store",
            redirect: "error",
          });
          if (!response.ok) throw new Error("PHOTO_UNAVAILABLE");
          const blob = await response.blob();
          if (
            id !== epoch ||
            signal.aborted ||
            $("dashboardPanel").hidden ||
            document.hidden
          )
            return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          img.src = url;
        } catch {
          if (id === epoch && !signal.aborted)
            frame.replaceChildren(text("p", "Photo unavailable"));
        } finally {
          fetching = false;
          void nextPhoto();
        }
      };
      const photoObserver = new IntersectionObserver(
        (entries) => {
          if (id !== epoch || signal.aborted) return;
          for (const entry of entries)
            if (entry.isIntersecting) {
              photoObserver.unobserve(entry.target);
              pendingPhotos.push(entry.target.dashboardPhoto);
            }
          void nextPhoto();
        },
        { rootMargin: "100px" },
      );
      observer = photoObserver;
      for (const member of members) {
        const tile = text("article", "", "dashboard-tile");
        tile.append(text("h4", member.display_name));
        const gallery = text("div", "", "dashboard-gallery");
        if (member.media === "not_shared")
          gallery.append(text("p", "Photo not shared"));
        else if (!member.photos.length)
          gallery.append(text("p", "No progress photo available"));
        else {
          gallery.setAttribute(
            "aria-label",
            `Latest shared progress check-in for ${member.display_name}`,
          );
          member.photos.forEach((photo, index) => {
            const frame = text("div", "", "dashboard-photo");
            const img = document.createElement("img");
            img.loading = "lazy";
            img.alt = `Progress photo ${index + 1} of ${member.photos.length} for ${member.display_name}`;
            img.addEventListener("error", () => {
              if (id === epoch) {
                if (img.src.startsWith("blob:")) {
                  URL.revokeObjectURL(img.src);
                  const at = urls.indexOf(img.src);
                  if (at !== -1) urls.splice(at, 1);
                }
                frame.replaceChildren(text("p", "Photo unavailable"));
              }
            });
            frame.append(img);
            frame.dashboardPhoto = { member, photo, frame, img };
            observer.observe(frame);
            gallery.append(frame);
          });
        }
        tile.append(gallery);
        for (const [key, label] of [
          ["training", "Training"],
          ["nutrition", "Nutrition"],
          ["body", "Body"],
        ])
          tile.append(
            text(
              "p",
              `${label} ${member.category_access[key] === "shared" ? "shared" : "not shared"}`,
              "hint",
            ),
          );
        roster.append(tile);
      }
      if (!members.length)
        roster.append(
          text(
            "p",
            coverage.complete
              ? "No members in this dojo."
              : "No members in this partial snapshot.",
            "hint",
          ),
        );
      const graphs = $("dashboardCharts");
      for (const [key, label, category] of [
        ["training", "Training", "training"],
        ["nutrition", "Nutrition", "nutrition"],
        ["body_measurements", "Body measurements", "body"],
      ]) {
        const section = text("section", "", "dashboard-domain");
        section.append(
          text("h3", label),
          text(
            "p",
            `${coverage.category_shared[category]} of ${coverage.roster_total} shown members share ${label.toLowerCase()} activity${coverage.complete ? "" : " · partial roster coverage"}. Each curve belongs to the named member. ${key === "body_measurements" ? "Logged metric points only; same-unit daily average within a member, not inferred from photos." : key === "training" ? "Completed workouts and sets by UTC completion day (creation-date fallback); not lifting volume or adherence." : "Logged meals and available recorded nutrition totals by UTC completion day (creation-date fallback); no food lookup or adherence."} Missing days and unavailable nutrition totals are not zero.`,
            "hint",
          ),
        );
        const grid = text("div", "", "dashboard-graphs");
        if (!coverage.category_shared[category])
          grid.append(
            text("p", "No shown members share this category.", "hint"),
          );
        else if (!series[key].length)
          grid.append(
            text(
              "p",
              "No shared data in this category for this period.",
              "hint",
            ),
          );
        else for (const item of series[key]) grid.append(chart(item));
        section.append(grid);
        graphs.append(section);
      }
    } catch (error) {
      if (id !== epoch || signal.aborted) return;
      clear();
      $("dashboardStatus").textContent =
        "Dashboard unavailable. Shared data could not be loaded; try Refresh.";
    }
  }
  return { clear, load };
})();
