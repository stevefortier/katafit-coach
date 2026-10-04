// Count individual rendered occurrences without grouping.
export async function timelineCounts(page: any) {
  return page.evaluate(() => ({
    loaded: document.querySelectorAll(".dashboard-timeline-mark").length,
    represented: document.querySelectorAll(
      ".dashboard-timeline-mark:not([hidden])",
    ).length,
  }));
}
