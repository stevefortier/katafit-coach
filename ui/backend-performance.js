// Input is the authenticated, fixed-vocabulary Diagnostics snapshot. Never use
// refs, arguments, error prose or arbitrary metadata to construct an identity.
globalThis.BackendPerformance = (() => {
  function identity(entry) {
    if (entry.source !== "backend" || entry.stage !== "backend-call")
      return null;
    const c = entry.backendCall;
    if (!c) return { key: "unknown", name: "Unknown — descriptor unavailable" };
    const name =
      c.tool && c.tool !== "other"
        ? c.tool
        : c.operation === "tools/call"
          ? "tools/call — tool name unavailable"
          : c.operation && c.operation !== "other"
            ? c.operation
            : `${c.method} ${c.route}`;
    return {
      key: JSON.stringify([
        c.method,
        c.route,
        c.operation ?? null,
        c.tool ?? null,
      ]),
      name,
    };
  }
  function aggregate(data) {
    const groups = new Map();
    const timestamps = [];
    let invalidTimestampCount = 0;
    for (const entry of data.entries) {
      const id = identity(entry);
      if (!id) continue;
      const time =
        typeof entry.time === "string" ? Date.parse(entry.time) : NaN;
      if (Number.isFinite(time)) timestamps.push(time);
      else invalidTimestampCount++;
      let row = groups.get(id.key);
      if (!row)
        groups.set(
          id.key,
          (row = {
            ...id,
            calls: 0,
            durations: [],
            timeouts: 0,
            otherFailures: 0,
            cancellations: 0,
            unknownOutcomes: 0,
            failedTimeMs: 0,
          }),
        );
      row.calls++;
      const outcome = entry.backendCall?.outcome;
      const failure = [
        "http_error",
        "network_error",
        "protocol_error",
        "tool_error",
        "response_too_large",
      ].includes(outcome);
      if (outcome === "timeout") row.timeouts++;
      else if (failure) row.otherFailures++;
      else if (outcome === "cancelled") row.cancellations++;
      else if (outcome !== "ok") row.unknownOutcomes++;
      const ms = entry.metadata?.elapsedMs;
      if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
        row.durations.push(ms);
        if (failure || outcome === "timeout") row.failedTimeMs += ms;
      }
    }
    const rows = [...groups.values()].map(({ durations, ...row }) => {
      durations.sort((a, b) => a - b);
      const n = durations.length;
      const totalMs = durations.reduce((a, b) => a + b, 0);
      return {
        ...row,
        timeoutRate: row.timeouts / row.calls,
        otherFailureRate: row.otherFailures / row.calls,
        cancellationRate: row.cancellations / row.calls,
        failedTimeShare: totalMs ? row.failedTimeMs / totalMs : null,
        measuredCalls: n,
        missingDurationCalls: row.calls - n,
        totalMs,
        averageMs: n ? totalMs / n : null,
        medianMs: n
          ? (durations[Math.floor((n - 1) / 2)] +
              durations[Math.floor(n / 2)]) /
            2
          : null,
        p95Ms: n ? durations[Math.ceil(n * 0.95) - 1] : null,
        maxMs: n ? durations[n - 1] : null,
      };
    });
    const totalMs = rows.reduce((n, r) => n + r.totalMs, 0);
    for (const row of rows) row.share = totalMs ? row.totalMs / totalMs : null;
    return {
      schemaVersion: 1,
      metrics: {
        durationUnit: "ms",
        durationBasis: "cumulative request time, not wallclock",
        percentiles: "p95 nearest-rank; median even midpoint",
        ratesDenominator:
          "all observed calls per group, including unknown outcomes",
        failedTimeBasis:
          "timeouts plus other failures; excludes cancellations and unknown outcomes",
        shareDenominator: "measured backend cumulative request time",
        missingDurations:
          "excluded from duration statistics; never zero-filled",
        scope:
          "retained receipts across all levels, not lifetime; timestamps are receipt completion observations",
        lowSampleP95: "fewer than 20 duration samples is a small sample",
      },
      window: {
        capacity: data.capacity ?? 5000,
        retainedEntries: data.entries.length,
        receiptCount: rows.reduce((n, r) => n + r.calls, 0),
        measuredCalls: rows.reduce((n, r) => n + r.measuredCalls, 0),
        invalidTimestampCount,
        oldestReceipt: timestamps.length
          ? new Date(Math.min(...timestamps)).toISOString()
          : null,
        newestReceipt: timestamps.length
          ? new Date(Math.max(...timestamps)).toISOString()
          : null,
      },
      totalMs,
      groups: sort(rows),
    };
  }
  function sort(rows, metric = "totalMs") {
    if (!["totalMs", "calls", "p95Ms", "timeouts"].includes(metric))
      metric = "totalMs";
    return [...rows].sort(
      (a, b) =>
        (b[metric] ?? -1) - (a[metric] ?? -1) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  }
  function duration(n) {
    if (n === null) return "—";
    if (n < 1000)
      return n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + " ms";
    if (n < 60000)
      return (
        (n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) +
        " s"
      );
    if (n < 3600000)
      return `${Math.floor(n / 60000)}m ${Math.floor((n % 60000) / 1000)}s`;
    return `${Math.floor(n / 3600000)}h ${Math.floor((n % 3600000) / 60000)}m`;
  }
  function rate(n) {
    return n === null
      ? "—"
      : n > 0 && n < 0.001
        ? "<0.1%"
        : (n * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) +
          "%";
  }
  return { identity, aggregate, sort, duration, rate };
})();
