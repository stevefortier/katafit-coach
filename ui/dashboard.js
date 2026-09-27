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
    card.append(text("h4", `${series.label} (${series.unit})`));
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
      viewBox: "0 0 600 165",
      role: "img",
      "aria-label": `${series.label}: ${points.map((p) => `${p.date} ${p.value} ${series.unit}, ${p.contributor_count} contributors`).join("; ")}`,
    });
    graph.append(
      svg("line", { x1: 30, y1: 135, x2: 575, y2: 135, stroke: "#777" }),
    );
    const coords = points.map((p, i) => [
      30 + (points.length === 1 ? 272 : (i * 545) / (points.length - 1)),
      125 - ((p.value - min) / span) * 100,
    ]);
    graph.append(
      svg("polyline", {
        points: coords.map((p) => p.join(",")).join(" "),
        fill: "none",
        stroke: "#ddd",
        "stroke-width": 2,
      }),
    );
    coords.forEach(([x, y], i) => {
      const dot = svg("circle", { cx: x, cy: y, r: 4, fill: "#fff" });
      dot.append(svg("title", {}));
      dot.firstChild.textContent = `${points[i].date}: ${points[i].value} ${series.unit} · ${points[i].contributor_count} contributors`;
      graph.append(dot);
    });
    const valueLabel = (p) =>
      `${p.date} · ${p.value} ${series.unit} · ${p.contributor_count} contributor${p.contributor_count === 1 ? "" : "s"}`;
    card.append(
      graph,
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
        text("span", `${coverage.stats_shared} stats-shared among shown`),
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
        const { member, frame, img } = pendingPhotos.shift();
        try {
          const query = new URLSearchParams({
            member_ref: member.member_ref,
            media_ref: member.photo.media_ref,
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
        const frame = text("div", "", "dashboard-photo");
        if (member.media === "not_shared")
          frame.append(text("p", "Photo not shared"));
        else if (!member.photo)
          frame.append(text("p", "No progress photo available"));
        else {
          const img = document.createElement("img");
          img.alt = `Latest shared progress photo for ${member.display_name}`;
          img.addEventListener("error", () => {
            if (id === epoch)
              frame.replaceChildren(text("p", "Photo unavailable"));
          });
          frame.append(img);
          frame.dashboardPhoto = { member, frame, img };
          observer.observe(frame);
        }
        tile.append(
          frame,
          text(
            "p",
            member.stats === "shared"
              ? "Statistics shared"
              : "Statistics not shared",
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
      for (const [key, label] of [
        ["training", "Training"],
        ["nutrition", "Nutrition"],
        ["body_measurements", "Body measurements"],
      ]) {
        const section = text("section", "", "dashboard-domain");
        section.append(
          text("h3", label),
          text(
            "p",
            `${coverage.stats_shared} of ${coverage.roster_total} shown members share statistics${coverage.complete ? "" : " · partial roster coverage"}. ${key === "body_measurements" ? "Logged metric points only; same-unit daily average, not inferred from photos." : key === "training" ? "Completed workouts and sets by UTC completion day (creation-date fallback); not lifting volume or adherence." : "Logged meals and available recorded nutrition totals by UTC completion day (creation-date fallback); no food lookup or adherence."} Missing days and unavailable nutrition totals are not zero.`,
            "hint",
          ),
        );
        const grid = text("div", "", "dashboard-graphs");
        if (!series[key].length)
          grid.append(text("p", "No shared data in this category.", "hint"));
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
