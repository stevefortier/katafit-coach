// Browser-only scheduling controls for real viewport/Leaflet callbacks. The
// observer entries and rAF callbacks are retained, then delivered without DOM
// mutation. Geometry traces contain only synthetic fixture layout, not content.
export async function installMapLayoutProbe(page: any) {
  await page.addInitScript(() => {
    const w = window as any;
    const nativeFrame = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const NativeResize = window.ResizeObserver;
    let holdFrames = false,
      holdMap = false,
      serial = 0,
      frame = 0;
    const frames = new Map<
      number,
      { callback: FrameRequestCallback; native?: number }
    >();
    const maps: (() => void)[] = [];
    let mapReady = Promise.resolve(),
      mapEntered = () => {};
    const trace: any[] = [];
    const rect = (id: string) =>
      document.getElementById(id)?.getBoundingClientRect().toJSON();
    const geometry = () => ({
      frame,
      viewport: { width: innerWidth, height: innerHeight },
      pane: rect("dashboardMapPane"),
      map: rect("dashboardMap"),
      timeline: rect("dashboardTimeline"),
      leaflet: { x: w.fixtureMap?._size?.x, y: w.fixtureMap?._size?.y },
      leafletSizeChanged: w.fixtureMap?._sizeChanged,
      client: {
        width: document.getElementById("dashboardMap")?.clientWidth,
        height: document.getElementById("dashboardMap")?.clientHeight,
      },
      paneStyle: document
        .getElementById("dashboardMapPane")
        ?.getAttribute("style"),
      active: (document.activeElement as HTMLElement)?.className,
      tooltipHidden: document.querySelector<HTMLElement>(
        ".dashboard-timeline-tooltip",
      )?.hidden,
      pageOverflow: document.documentElement.scrollHeight > innerHeight,
      pendingFrames: frames.size,
      pendingMaps: maps.length,
    });
    const record = (event: string, extra = {}) =>
      trace.push({ event, ...extra, ...geometry() });
    const schedule = (id: number) => {
      const task = frames.get(id)!;
      task.native = nativeFrame((at) => {
        frames.delete(id);
        record("raf:before", { id });
        task.callback(at);
        record("raf:after", { id });
      });
    };
    window.requestAnimationFrame = (callback) => {
      const id = --serial;
      frames.set(id, { callback });
      record(holdFrames ? "raf:held" : "raf:scheduled", { id });
      if (!holdFrames) schedule(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const task = frames.get(id);
      if (task?.native !== undefined) nativeCancel(task.native);
      frames.delete(id);
    };
    window.ResizeObserver = class extends NativeResize {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const targets = entries.map((e) => e.target.id || e.target.className);
          const deliver = () => {
            record("resize:before", { targets });
            callback(entries, observer);
            record("resize:after", { targets });
          };
          if (holdMap && targets.includes("dashboardMap")) {
            maps.push(deliver);
            if (
              document
                .getElementById("dashboardMapPane")
                ?.getBoundingClientRect().bottom ===
              innerHeight - 8
            )
              mapEntered();
            record("resize:held", { targets });
          } else deliver();
        });
      }
    };
    const nextFrame = () =>
      new Promise<void>((resolve) =>
        nativeFrame(() => {
          frame++;
          resolve();
        }),
      );
    w.mapProbe = {
      trace,
      geometry,
      record,
      nextFrame,
      hold() {
        holdFrames = true;
        // Already queued work must not escape the controlled resize boundary.
        for (const task of frames.values()) {
          if (task.native !== undefined) {
            nativeCancel(task.native);
            task.native = undefined;
          }
        }
        holdMap = true;
        mapReady = new Promise<void>((resolve) => {
          mapEntered = resolve;
        });
        record("hold");
      },
      async releaseLayout() {
        holdFrames = false;
        record("release-layout");
        for (const [id, task] of frames)
          if (task.native === undefined) schedule(id);
        await mapReady;
        record("layout-delivered");
      },
      async releaseMap() {
        holdMap = false;
        record("release-map");
        for (const deliver of maps.splice(0)) deliver();
        await nextFrame();
        await nextFrame();
        record("map-delivered");
      },
    };
  });
}
