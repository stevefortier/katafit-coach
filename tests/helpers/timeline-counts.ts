// Count actual rendered occurrences, including pills that represent hidden marks.
export async function timelineCounts(page: any) {
  return page.evaluate(() => ({
    loaded: document.querySelectorAll(".dashboard-timeline-mark").length,
    represented:
      document.querySelectorAll(".dashboard-timeline-mark:not([hidden])")
        .length +
      [
        ...document.querySelectorAll<HTMLElement>(
          ".dashboard-timeline-cluster:not([hidden])",
        ),
      ].reduce(
        (total, node) =>
          total + JSON.parse(node.dataset.eventIds || "[]").length,
        0,
      ),
  }));
}
