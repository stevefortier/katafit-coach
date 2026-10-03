/* Canonical member Stats presentation. Not derived from the activity feed. */
window.CoachStats = (() => {
  const DAY = 86400000;
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  function daily(rows, timezone) {
    const groups = new Map();
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    for (const row of rows || []) {
      const time = new Date(row.date).getTime();
      if (!Number.isFinite(time) || !finite(row.value)) continue;
      const day =
        typeof row.day_key === "string" && /^\d{4}-\d\d-\d\d$/.test(row.day_key)
          ? row.day_key
          : format.format(time);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push({ ...row, time });
    }
    const average = (values) =>
      values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : undefined;
    return [...groups]
      .map(([day, values]) => ({
        day,
        time: Date.parse(day + "T12:00:00Z"),
        value: average(values.map((r) => r.value)),
        min: average(values.map((r) => r.min).filter(finite)),
        max: average(values.map((r) => r.max).filter(finite)),
        count: values.length,
        ai: values.some((r) => r.source === "ai"),
        target: values.find((r) => finite(r.target))?.target,
        targetMin: values.find((r) => finite(r.targetMin))?.targetMin,
        targetMax: values.find((r) => finite(r.targetMax))?.targetMax,
      }))
      .sort((a, b) => a.time - b.time);
  }
  function display(key, name, value, unit) {
    if ((key === "weight" || key === "weeklyVolume") && unit === "kg")
      return value * 0.45359237;
    if (key === "custom" && /sleep/i.test(name) && /min/i.test(name))
      return value / 60;
    return value;
  }
  function trend(points) {
    return points.map((p, index) => {
      const window = points.slice(
        Math.max(0, index - 20),
        Math.min(points.length, index + 21),
      );
      return {
        ...p,
        value: window.reduce((sum, q) => sum + q.value, 0) / window.length,
      };
    });
  }
  function validate(dto, id) {
    if (
      dto?.version !== 1 ||
      dto.user_id !== id ||
      !dto.history ||
      !dto.availability ||
      !dto.coverage ||
      dto.coverage.truncated !== false ||
      typeof dto.timezone !== "string"
    )
      throw new Error("Unsupported Stats history contract.");
    new Intl.DateTimeFormat("en", { timeZone: dto.timezone });
    for (const [key, value] of Object.entries({
      weight: "lb",
      weeklyVolume: "lb-reps",
      weeklyScore: "score",
      bodyFat: "percent",
      bodyFatRange: "fraction",
      protein: "g",
      water: "ml",
    }))
      if (dto.units?.[key] !== value)
        throw new Error("Unsupported Stats wire units.");
    for (const key of [
      "weight",
      "bodyFat",
      "musculature",
      "weeklyScore",
      "weeklyVolume",
      "customMetrics",
      "nutritionHistory",
    ]) {
      const status = dto.availability[key],
        value = dto.history[key];
      if (
        !["available", "denied", "unproven_composite"].includes(status) ||
        (status !== "available" && value !== null) ||
        (status === "available" && value === null)
      )
        throw new Error("Contradictory Stats availability.");
      if (
        status === "available" &&
        !["customMetrics", "nutritionHistory"].includes(key) &&
        !Array.isArray(value)
      )
        throw new Error("Invalid Stats series.");
    }
    if (
      dto.history.nutritionHistory &&
      ["calories", "protein", "water"].some(
        (k) => !Array.isArray(dto.history.nutritionHistory[k]),
      )
    )
      throw new Error("Invalid nutrition history.");
    if (
      dto.history.customMetrics &&
      (typeof dto.history.customMetrics !== "object" ||
        Array.isArray(dto.history.customMetrics) ||
        Object.values(dto.history.customMetrics).some((v) => !Array.isArray(v)))
    )
      throw new Error("Invalid custom history.");
    const object = (v) =>
      v !== null && typeof v === "object" && !Array.isArray(v);
    const civil = (v) =>
      typeof v === "string" &&
      /^\d{4}-\d\d-\d\d$/.test(v) &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v;
    let count = 0;
    const checkRows = (rows, key) => {
      if (!Array.isArray(rows) || rows.length > 10000)
        throw new Error("Invalid Stats series.");
      for (const row of rows) {
        if (
          ++count > 30000 ||
          !object(row) ||
          !(
            (typeof row.date === "string" &&
              civil(row.date.slice(0, 10)) &&
              Number.isFinite(Date.parse(row.date))) ||
            (["weeklyScore", "weeklyVolume"].includes(key) &&
              finite(row.date) &&
              Number.isFinite(new Date(row.date).getTime()))
          ) ||
          !finite(row.value) ||
          Math.abs(row.value) > Number.MAX_SAFE_INTEGER
        )
          throw new Error("Invalid Stats reading.");
        if (row.day_key !== undefined && !civil(row.day_key))
          throw new Error("Invalid Stats civil day.");
        if (
          ["weight", "bodyFat", "musculature", "custom"].includes(key) &&
          !["manual", "ai"].includes(row.source)
        )
          throw new Error("Invalid Stats provenance.");
        for (const k of ["min", "max", "target", "targetMin", "targetMax"])
          if (
            row[k] !== undefined &&
            row[k] !== null &&
            (!finite(row[k]) || row[k] < 0 || row[k] > Number.MAX_SAFE_INTEGER)
          )
            throw new Error("Invalid Stats bounds.");
        for (const [a, b] of [
          ["min", "max"],
          ["targetMin", "targetMax"],
        ])
          if (
            (row[a] != null) !== (row[b] != null) ||
            (row[a] != null && row[a] > row[b])
          )
            throw new Error("Invalid Stats range.");
        if (
          (key !== "custom" && row.value < 0) ||
          (key === "bodyFat" && (row.value > 100 || row.max > 1)) ||
          (key === "musculature" && row.value > 10)
        )
          throw new Error("Invalid Stats value.");
      }
    };
    for (const key of [
      "weight",
      "bodyFat",
      "musculature",
      "weeklyScore",
      "weeklyVolume",
    ])
      if (dto.availability[key] === "available")
        checkRows(dto.history[key], key);
    if (dto.availability.customMetrics === "available") {
      if (
        !object(dto.history.customMetrics) ||
        Object.keys(dto.history.customMetrics).length > 400
      )
        throw new Error("Invalid custom history.");
      for (const [name, rows] of Object.entries(dto.history.customMetrics)) {
        if (!name || name.length > 512)
          throw new Error("Invalid custom label.");
        checkRows(rows, "custom");
      }
    }
    if (dto.availability.nutritionHistory === "available") {
      if (!object(dto.history.nutritionHistory))
        throw new Error("Invalid nutrition history.");
      for (const key of ["calories", "protein", "water"])
        checkRows(dto.history.nutritionHistory[key], key);
      for (const key of ["dailyTargets", "unavailableTargets"]) {
        const rows = dto.history.nutritionHistory[key];
        if (rows === undefined) continue; // additive v1 fields; older backend remains compatible
        if (!Array.isArray(rows) || rows.length > 2000)
          throw new Error("Invalid daily target history.");
        for (const row of rows) {
          if (!object(row) || !civil(row.day_key))
            throw new Error("Invalid target day.");
          if (key === "unavailableTargets") {
            if (typeof row.reason !== "string" || row.reason.length > 256)
              throw new Error("Invalid unavailable target.");
          } else {
            for (const k of [
              "calories",
              "calories_min",
              "calories_max",
              "protein",
              "water_ml",
              "carbs",
              "fat",
            ])
              if (
                row[k] !== undefined &&
                (!finite(row[k]) ||
                  row[k] < 0 ||
                  row[k] > Number.MAX_SAFE_INTEGER)
              )
                throw new Error("Invalid target value.");
            if (
              (row.calories_min !== undefined) !==
                (row.calories_max !== undefined) ||
              row.calories_min > row.calories_max
            )
              throw new Error("Invalid calorie budget.");
          }
        }
      }
    }
    return dto;
  }
  function attach({ host, request, getMembers, getSelected, onDenial }) {
    const cache = new Map(),
      failures = new Map();
    let generation = 0,
      controller = new AbortController(),
      days = 90,
      unit = "lb",
      running = false,
      notice = "";
    const node = (tag, value, className) => {
      const el = document.createElement(tag);
      el.textContent = value;
      if (className) el.className = className;
      return el;
    };
    const chartSvg = (tag, attrs) => {
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    };
    const lanes = [
      ["weeklyScore", "Weekly Score", "score"],
      ["weeklyVolume", "Weekly Volume", "lb-reps"],
      ["calories", "Daily Calories", "kcal"],
      ["protein", "Daily Protein", "g"],
      ["water", "Daily Water", "ml"],
      ["weight", "Weight", "lb"],
      ["bodyFat", "Body Fat Estimate", "%"],
      ["musculature", "Musculature Index", "index"],
    ];
    function lane(key, label, wireUnit, rows, dto, window, custom = false) {
      const section = node("section", "", "stats-lane");
      section.dataset.lane = key;
      const shownUnit =
        (key === "weight" || key === "weeklyVolume") && unit === "kg"
          ? wireUnit.replace("lb", "kg")
          : custom && /sleep/i.test(label) && /min/i.test(label)
            ? "hours"
            : wireUnit;
      section.append(
        node(
          "h4",
          `${shownUnit === "hours" ? label.replace(/minutes|min/gi, "hours") : label}${shownUnit ? ` · ${shownUnit}` : ""}`,
        ),
      );
      if (rows === null || rows === undefined) {
        section.append(
          node(
            "p",
            "Unavailable — not shared or source dependencies unproven.",
            "muted",
          ),
        );
        return section;
      }
      const allPoints = daily(rows, dto.timezone).map((p) => ({
        ...p,
        value: display(custom ? "custom" : key, label, p.value, unit),
        ...(key === "bodyFat"
          ? {
              min: p.min == null ? undefined : p.min * 100,
              max: p.max == null ? undefined : p.max * 100,
            }
          : {}),
      }));
      const points = allPoints.filter(
        (p) =>
          days === null || (p.time >= window.start && p.time <= window.end),
      );
      if (!points.length) {
        section.append(node("p", "No recorded values in this range.", "muted"));
        return section;
      }
      const sleep = shownUnit === "hours";
      if (sleep) points.forEach((p) => (p.target = 7));
      const range = points
        .flatMap((p) => [
          p.value,
          p.min,
          p.max,
          p.target,
          p.targetMin,
          p.targetMax,
        ])
        .filter(finite);
      const weekly = ["weeklyScore", "weeklyVolume"].includes(key);
      const lo = sleep || weekly ? 0 : Math.min(...range),
        hi = Math.max(...range),
        first = window.start,
        end = window.end;
      const x = (time) => 24 + ((time - first) / (end - first || 1)) * 552;
      const y = (value) => 104 - ((value - lo) / (hi - lo || 1)) * 76;
      const image = chartSvg("svg", {
        viewBox: "0 0 600 132",
        role: "img",
        "data-start": first,
        "data-end": end,
        "aria-label": `${label}: ${points.length} recorded days, ${points[0].day} to ${points.at(-1).day}`,
      });
      image.append(
        chartSvg("path", {
          d: "M24 16V108H580",
          fill: "none",
          stroke: "currentColor",
          opacity: ".25",
        }),
      );
      for (const [lower, upper, name] of [
        ["min", "max", "estimate"],
        ["targetMin", "targetMax", "budget"],
      ]) {
        let group = [];
        const flush = () => {
          if (!group.length) return;
          const d =
            group.length === 1
              ? `M${x(group[0].time) - 3} ${y(group[0][lower])}h6V${y(group[0][upper])}h-6Z`
              : `M${group.map((p) => `${x(p.time)} ${y(p[lower])}`).join("L")}L${group
                  .slice()
                  .reverse()
                  .map((p) => `${x(p.time)} ${y(p[upper])}`)
                  .join("L")}Z`;
          image.append(
            chartSvg("path", {
              d,
              fill: "currentColor",
              opacity: 0.18,
              "data-band": name,
            }),
          );
          group = [];
        };
        for (const p of points) {
          if (
            !finite(p[lower]) ||
            !finite(p[upper]) ||
            (group.length && p.time - group.at(-1).time > 365 * DAY)
          )
            flush();
          if (finite(p[lower]) && finite(p[upper])) group.push(p);
        }
        flush();
      }
      const detail = (p) => {
        const weekly = ["weeklyScore", "weeklyVolume"].includes(key);
        const value = weekly ? Math.round(p.value) : Number(p.value.toFixed(2));
        let text = `${p.day}: ${value} ${shownUnit}`;
        if (weekly && p.day === allPoints.at(-1).day) text += " · partial week";
        if (sleep) {
          const minutes = Math.round(p.value * 60);
          text += ` · ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m · target 7h · ${p.value >= 7 ? "reached" : "under target"}`;
        }
        if (finite(p.min) && finite(p.max))
          text += ` · estimate ${Number(p.min.toFixed(1))}–${Number(p.max.toFixed(1))}%`;
        if (finite(p.targetMin) && finite(p.targetMax))
          text += ` · budget ${p.targetMin}–${p.targetMax} · ${p.value < p.targetMin ? "under budget" : p.value > p.targetMax ? "over budget" : "on budget"}`;
        if (!sleep && finite(p.target))
          text += ` · target ${p.target} ${shownUnit}${["protein", "water"].includes(key) ? ` · ${p.value < p.target ? "under target" : "reached target"}` : ""}`;
        if (
          ["calories", "protein", "water"].includes(key) &&
          !finite(p.target) &&
          !finite(p.targetMin)
        )
          text += " · target unavailable";
        return (
          text +
          `${p.ai ? " · photo/AI estimate" : ""} · ${p.count} source readings`
        );
      };
      const details = node("details", "");
      details.append(node("summary", "Dated values, ranges and targets"));
      const list = node("ul", "");
      for (const p of points) list.append(node("li", detail(p)));
      details.append(list);
      section.append(details);
      for (const [time, anchor] of [
        [first, "start"],
        [end, "end"],
      ]) {
        const label = chartSvg("text", {
          x: x(time),
          y: 128,
          "text-anchor": anchor,
          "font-size": 12,
          fill: "currentColor",
        });
        label.textContent = new Date(time).toISOString().slice(0, 10);
        image.append(label);
      }
      for (const value of [lo, hi]) {
        const label = chartSvg("text", {
          x: 24,
          y: y(value) - 4,
          "font-size": 12,
          fill: "currentColor",
        });
        label.textContent = Number(value.toFixed(1));
        image.append(label);
      }
      let path = "";
      points.forEach((p, i) => {
        path += `${!i || p.time - points[i - 1].time > 365 * DAY ? "M" : "L"}${x(p.time)} ${y(p.value)} `;
        if (finite(p.min) && finite(p.max))
          image.append(
            chartSvg("path", {
              d: `M${x(p.time)} ${y(p.min)}V${y(p.max)}`,
              stroke: "currentColor",
              opacity: ".45",
              "stroke-width": 6,
            }),
          );
        for (const target of [p.target, p.targetMin, p.targetMax].filter(
          finite,
        ))
          image.append(
            chartSvg("path", {
              d: `M${x(p.time) - 5} ${y(target)}h10`,
              stroke: "currentColor",
              "stroke-dasharray": "2 2",
              opacity: ".6",
            }),
          );
        if (weekly || sleep) {
          const partial = weekly && p.day === allPoints.at(-1).day;
          const status = sleep
            ? p.value >= 7
              ? "reached"
              : "under"
            : "recorded";
          image.append(
            chartSvg("rect", {
              x: x(p.time) - 4,
              y: y(p.value),
              width: 8,
              height: Math.max(1, y(0) - y(p.value)),
              fill: sleep
                ? status === "reached"
                  ? "#16a34a"
                  : "#dc2626"
                : "currentColor",
              opacity: partial ? 0.5 : 1,
              "data-status": status,
              ...(partial
                ? {
                    "data-partial": "true",
                    stroke: "currentColor",
                    "stroke-dasharray": "2 2",
                  }
                : {}),
            }),
          );
        }
        const mark = chartSvg("circle", {
          cx: x(p.time),
          cy: y(p.value),
          r: 3,
          fill: "currentColor",
        });
        const title = chartSvg("title", {});
        title.textContent = detail(p);
        const status =
          finite(p.targetMin) && finite(p.targetMax)
            ? p.value < p.targetMin
              ? "under"
              : p.value > p.targetMax
                ? "over"
                : "on"
            : sleep || finite(p.target)
              ? p.value < p.target
                ? "under"
                : "reached"
              : "recorded";
        mark.setAttribute("data-status", status);
        if (status !== "recorded")
          mark.setAttribute(
            "fill",
            status === "under"
              ? "#d97706"
              : status === "over"
                ? "#dc2626"
                : "#16a34a",
          );
        mark.append(title);
        image.append(mark);
      });
      image.append(
        chartSvg("path", {
          d: path,
          fill: "none",
          stroke: "currentColor",
          "stroke-width": 1.5,
        }),
      );
      if (key === "bodyFat" || key === "musculature") {
        let path = "";
        trend(allPoints)
          .filter(
            (p) =>
              days === null || (p.time >= window.start && p.time <= window.end),
          )
          .forEach((p, i) => {
            path += `${!i || p.time - points[i - 1].time > 365 * DAY ? "M" : "L"}${x(p.time)} ${y(p.value)} `;
          });
        image.append(
          chartSvg("path", {
            d: path,
            fill: "none",
            stroke: "currentColor",
            opacity: ".5",
            "stroke-width": 2.5,
            "stroke-dasharray": "4 3",
          }),
        );
      }
      section.append(
        image,
        node(
          "p",
          `${points[0].day} — ${points.at(-1).day} · latest ${weekly ? Math.round(points.at(-1).value) : Number(points.at(-1).value.toFixed(2))}${key === "bodyFat" || key === "musculature" ? " · photo estimate; dashed centered trend (up to 41 readings)" : ""}${["calories", "protein", "water"].includes(key) ? " · band: proven historical budget; dashed marks: targets" : ""}`,
          "muted",
        ),
      );
      return section;
    }
    function render() {
      if (!host) return;
      host.replaceChildren();
      const controls = node("div", "", "stats-controls");
      const range = node("select", "");
      range.setAttribute("aria-label", "Stats range");
      for (const [value, label] of [
        [30, "30 days"],
        [90, "90 days"],
        [365, "1 year"],
        [1825, "5 years"],
        ["all", "All"],
      ]) {
        const option = node("option", label);
        option.value = String(value);
        option.selected = String(days ?? "all") === String(value);
        range.append(option);
      }
      range.onchange = () => {
        days = range.value === "all" ? null : Number(range.value);
        render();
      };
      const units = node("select", "");
      units.setAttribute("aria-label", "Stats weight units");
      for (const value of ["lb", "kg"]) {
        const option = node("option", value);
        option.value = value;
        option.selected = unit === value;
        units.append(option);
      }
      units.onchange = () => {
        unit = units.value;
        render();
      };
      const members = getMembers(),
        selected = getSelected(),
        visible = members.filter((m) => !selected || m._id === selected);
      const loaded = visible.filter((m) => cache.has(m._id)).length;
      controls.append(
        range,
        units,
        node(
          "span",
          `${loaded}/${visible.length} member histories loaded · per-member values, not Dojo totals`,
          "muted",
        ),
      );
      host.append(controls);
      if (notice) host.append(node("p", notice, "muted"));
      if (selected && cache.has(selected)) {
        const refresh = node("button", "Refresh member Stats");
        refresh.type = "button";
        refresh.disabled = running;
        refresh.onclick = () => acquire(selected);
        host.append(refresh);
      }
      const missing = visible.filter((m) => !cache.has(m._id));
      if (missing.length) {
        const load = node(
          "button",
          running
            ? "Loading member history…"
            : selected
              ? "Load / Retry member Stats"
              : "Load next member Stats",
        );
        load.type = "button";
        load.disabled = running;
        load.onclick = () => acquire(missing[0]._id);
        host.append(load);
      }
      for (const member of visible) {
        const dto = cache.get(member._id);
        if (dto && failures.has(member._id))
          host.append(
            node(
              "p",
              `Retained history · ${failures.get(member._id)}`,
              "muted",
            ),
          );
        const box = node("article", "", "stats-member");
        box.append(node("h3", member.display_name || "Member"));
        if (!dto) {
          box.append(
            node(
              "p",
              failures.get(member._id) ||
                "History not loaded. Load members individually to keep All bounded.",
              "muted",
            ),
          );
          host.append(box);
          continue;
        }
        box.append(
          node(
            "p",
            `Canonical history · ${dto.timezone} · ${dto.coverage.authorized_sources} authorized sources${dto.coverage.excluded_lineage ? ` · ${dto.coverage.excluded_lineage} unproven sources excluded` : ""}`,
            "muted",
          ),
        );
        const history = dto.history;
        if (
          history.nutritionHistory?.dailyTargets ||
          history.nutritionHistory?.unavailableTargets
        ) {
          const details = node("details", "", "stats-target-details");
          details.append(
            node(
              "summary",
              "Dated nutrition prescriptions / unavailable targets",
            ),
          );
          const list = node("ul", "");
          for (const row of history.nutritionHistory.dailyTargets || []) {
            const fields = [
              ["calories", "calorie target", "kcal"],
              ["calories_min", "budget lower", "kcal"],
              ["calories_max", "budget upper", "kcal"],
              ["protein", "protein target", "g"],
              ["water_ml", "water target", "ml"],
              ["carbs", "carbs", "g"],
              ["fat", "fat", "g"],
            ];
            list.append(
              node(
                "li",
                `${row.day_key} · ${fields
                  .filter(([k]) => finite(row[k]))
                  .map(([k, label, unit]) => `${label} ${row[k]} ${unit}`)
                  .join(" · ")}`,
              ),
            );
          }
          for (const row of history.nutritionHistory.unavailableTargets || [])
            list.append(
              node(
                "li",
                `${row.day_key} · target unavailable — no proven numeric prescription`,
              ),
            );
          details.append(list);
          box.append(details);
        }
        const allRows = [
          ...lanes.flatMap(
            ([key]) => history[key] || history.nutritionHistory?.[key] || [],
          ),
          ...Object.values(history.customMetrics || {}).flat(),
        ];
        const last = Math.max(
          0,
          ...daily(allRows, dto.timezone).map((r) => r.time),
        );
        const first = Math.min(
          last,
          ...daily(allRows, dto.timezone).map((r) => r.time),
        );
        const window = {
          start: days === null ? first : last - days * DAY,
          end: last,
        };
        for (const [key, label, unit] of lanes)
          box.append(
            lane(
              key,
              label,
              unit,
              history[key] ?? history.nutritionHistory?.[key] ?? null,
              dto,
              window,
            ),
          );
        for (const label of Object.keys(history.customMetrics || {}).sort())
          box.append(
            lane(
              "custom",
              label,
              "",
              history.customMetrics[label],
              dto,
              window,
              true,
            ),
          );
        box.append(
          node(
            "p",
            `Custom contributions: manual ${dto.customSources?.manual || "unknown"} · AI/media ${dto.customSources?.ai || "unknown"}. ${dto.coverage.targets || ""}`,
            "muted",
          ),
        );
        host.append(box);
      }
    }
    async function acquire(id) {
      if (running) return;
      running = true;
      const own = generation,
        signal = controller.signal;
      render();
      try {
        const response = await request(
          `/api/dashboard/stats?user_id=${encodeURIComponent(id)}`,
          signal,
        );
        if (own !== generation || signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          cache.delete(id);
          notice = `Stats read denied (${response.status}). Reload Dojo to reauthorize.`;
          onDenial(id);
          throw new Error(
            `Read denied (${response.status}). Reload Dojo to reauthorize.`,
          );
        }
        if (!response.ok)
          throw new Error(
            `Stats read failed (${response.status}); Retry available.`,
          );
        const dto = await response.json();
        validate(dto, id);
        if (own === generation && !signal.aborted) {
          cache.set(id, dto);
          failures.delete(id);
        }
      } catch (error) {
        if (own === generation && !signal.aborted)
          failures.set(id, error.message);
      } finally {
        if (own === generation) {
          running = false;
          render();
        }
      }
    }
    return {
      select: () => {
        render();
      },
      clear: () => {
        generation++;
        controller.abort();
        controller = new AbortController();
        cache.clear();
        failures.clear();
        running = false;
        notice = "";
        host?.replaceChildren();
      },
    };
  }
  return { daily, display, trend, validate, attach };
})();
