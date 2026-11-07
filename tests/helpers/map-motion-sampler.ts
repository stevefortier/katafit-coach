import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// What the map must paint, frozen before a gesture (or switched by a watch at
// the frame a mutation is observed): latest pins by member and fix, the day's
// visible event dots, co-location badges, connections, and members whose
// geometry must not exist at all.
export type Spec = {
  latest: Record<string, [number, number]>;
  events?: string[];
  groups?: [number, number][];
  lines?: [string, string][];
  absent?: string[];
};

// In-page sampler. Each animation frame compares every painted overlay anchor
// with the same coordinate on the painted tiles (tile src z/x/y and its
// on-screen rectangle) and, for latest pins, with a native Leaflet marker at
// the same fix. Expected marks that are absent although their fix is well
// inside the map count as missing; geometry of an absent member counts as
// leaked. Overlay DOM mutations are attributed to the native move event that
// caused them, and fixed icon sizes are checked.
export const install = (
  page: any,
  fixes: Record<string, [number, number]>,
  spec: Spec,
) =>
  page.evaluate(
    ({ fixes, spec }: any) => {
      const w = window as any;
      w.__motion?.dispose?.();
      const m = w.fixtureMap,
        L = w.L;
      const map = document.getElementById("dashboardMap")!;
      const tileRef = () => {
        const box = map.getBoundingClientRect();
        let best: any = null;
        for (const img of map.querySelectorAll<HTMLImageElement>(
          "img.leaflet-tile-loaded",
        )) {
          const match = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(img.src);
          if (!match) continue;
          const r = img.getBoundingClientRect();
          if (!r.width) continue;
          const d = Math.hypot(
            r.left + r.width / 2 - (box.left + box.width / 2),
            r.top + r.height / 2 - (box.top + box.height / 2),
          );
          if (!best || d < best.d)
            best = { d, r, z: +match[1], x: +match[2], y: +match[3] };
        }
        return best;
      };
      // The world copy nearest the central painted tile.
      const truth = (tile: any, [lat, lng]: [number, number]) => {
        const p = m.project([lat, lng], tile.z),
          world = 256 * 2 ** tile.z;
        let dx = p.x - tile.x * 256;
        dx -= Math.round(dx / world) * world;
        return {
          x: tile.r.left + (dx * tile.r.width) / 256,
          y: tile.r.top + ((p.y - tile.y * 256) * tile.r.height) / 256,
        };
      };
      // Native Leaflet markers (zero-size div icons) in three world copies.
      // Created before a gesture: a marker added mid-zoom is itself placed
      // at Leaflet's target view.
      const refs = new Map<string, any[]>();
      const prepare = (next: any) => {
        for (const [lat, lng] of Object.values(next.latest) as any) {
          const key = `${lat},${lng}`;
          if (!refs.has(key))
            refs.set(
              key,
              [-360, 0, 360].map((k) =>
                L.marker([lat, lng + k], {
                  interactive: false,
                  keyboard: false,
                  icon: L.divIcon({
                    className: "motion-native-ref",
                    iconSize: [0, 0],
                  }),
                }).addTo(m),
              ),
            );
        }
      };
      prepare(spec);
      const native = ([lat, lng]: [number, number]) => {
        const key = `${lat},${lng}`;
        if (!refs.has(key)) return null;
        const box = map.getBoundingClientRect(),
          mid = box.left + box.width / 2;
        let best: any = null;
        for (const ref of refs.get(key)!) {
          const r = ref.getElement().getBoundingClientRect();
          if (!best || Math.abs(r.left - mid) < Math.abs(best.x - mid))
            best = { x: r.left, y: r.top };
        }
        return best;
      };
      const fresh = () => ({
        running: false,
        frames: 0,
        animFrames: 0,
        fractionalFrames: 0,
        pinErr: 0,
        pinRefErr: 0,
        // Leaflet's own markers against the painted tiles (oracle floor).
        nativeErr: 0,
        dotErr: 0,
        groupErr: 0,
        lineErr: 0,
        worst: null as any,
        missing: 0,
        missed: [] as any[],
        unexpected: 0,
        leaked: 0,
        leaks: [] as any[],
        pinSize: [Infinity, 0],
        dotSize: [Infinity, 0],
        measured: { pins: 0, refs: 0, dots: 0, groups: 0, lines: 0 },
        moves: 0,
        moveRecords: 0,
        settleRecords: 0,
        otherRecords: 0,
        frameWrites: [] as number[],
        mutation: null as any,
        watch: null as any,
      });
      let state = fresh();
      let expected: any = spec,
        lenient = false,
        watch: any = null;
      const animating = () =>
        m.getPane("mapPane")?.classList.contains("leaflet-zoom-anim");
      const sample = () => {
        const tile = tileRef();
        if (!tile) return;
        if (watch) {
          const found = !!document.querySelector(watch.selector);
          if (found !== !!watch.gone) {
            state.watch = {
              frame: state.frames + 1,
              anim: animating(),
              sinceMutation: state.mutation
                ? performance.now() - state.mutation.at
                : null,
              animFramesAfter: 0,
            };
            expected = watch.spec;
            watch = null;
            lenient = false;
          }
        }
        const box = map.getBoundingClientRect();
        const inside = (p: any, inset = 0) =>
          p.x >= box.left + inset &&
          p.x <= box.right - inset &&
          p.y >= box.top + inset &&
          p.y <= box.bottom - inset;
        state.frames++;
        if (animating()) {
          state.animFrames++;
          if (state.watch) state.watch.animFramesAfter++;
          if (state.mutation) state.mutation.animFramesAfter++;
        }
        if (m.getZoom() % 1) state.fractionalFrames++;
        const record = (kind: string, err: number, detail: any) => {
          if (err > (state as any)[kind]) (state as any)[kind] = err;
          if (!state.worst || err > state.worst.err)
            state.worst = {
              kind,
              err,
              frame: state.frames,
              anim: animating(),
              ...detail,
            };
        };
        const miss = (what: any) => {
          if (lenient) return;
          state.missing++;
          if (state.missed.length < 8)
            state.missed.push({ frame: state.frames, ...what });
        };
        const rendered = (n: Element | null) =>
          !!n && n.isConnected && n.getClientRects().length > 0;
        // Latest pins: each painted pin's tip against its anchor fix.
        const pins = [
          ...map.querySelectorAll<HTMLElement>(".dashboard-latest-pin"),
        ];
        for (const pin of pins) {
          if (!rendered(pin)) continue;
          const first = pin.dataset.memberIds!.split(" ")[0];
          const fix = expected.latest[first];
          if (!fix) {
            if (!lenient) state.unexpected++;
            continue;
          }
          const want = truth(tile, fix);
          if (!inside(want)) continue;
          const photo = pin
            .querySelector(".dashboard-latest-photo")!
            .getBoundingClientRect();
          // The pin tip (40px photo + 11px arrow) marks the exact fix.
          const tip = {
            x: photo.left + photo.width / 2,
            y: photo.bottom + (11 * photo.height) / 40,
          };
          state.measured.pins++;
          state.pinSize[0] = Math.min(state.pinSize[0], photo.width);
          state.pinSize[1] = Math.max(state.pinSize[1], photo.width);
          record("pinErr", Math.hypot(tip.x - want.x, tip.y - want.y), {
            ids: pin.dataset.memberIds,
            tip,
            want,
          });
          const ref = native(fix);
          if (ref) {
            state.measured.refs++;
            state.nativeErr = Math.max(
              state.nativeErr,
              Math.hypot(ref.x - want.x, ref.y - want.y),
            );
            record("pinRefErr", Math.hypot(tip.x - ref.x, tip.y - ref.y), {
              ids: pin.dataset.memberIds,
              tip,
              ref,
            });
          }
        }
        // Every expected member is painted (in its own pin or a group).
        for (const [member, fix] of Object.entries(expected.latest) as any) {
          const pin = pins.find((p) =>
            p.dataset.memberIds!.split(" ").includes(member),
          );
          if (!rendered(pin || null) && inside(truth(tile, fix), 40))
            miss({ latest: member });
        }
        for (const dot of map.querySelectorAll<HTMLElement>(
          ".dashboard-event-dot",
        )) {
          if (!rendered(dot)) continue;
          const want = truth(tile, fixes[dot.dataset.eventId!]);
          if (!inside(want)) continue;
          const r = dot.getBoundingClientRect();
          state.measured.dots++;
          state.dotSize[0] = Math.min(state.dotSize[0], r.width);
          state.dotSize[1] = Math.max(state.dotSize[1], r.width);
          record(
            "dotErr",
            Math.hypot(
              r.left + r.width / 2 - want.x,
              r.top + r.height / 2 - want.y,
            ),
            { event: dot.dataset.eventId },
          );
        }
        for (const id of expected.events || []) {
          const dot = map.querySelector(
            `.dashboard-event-dot[data-event-id="${id}"]`,
          );
          if (!rendered(dot) && inside(truth(tile, fixes[id]), 20))
            miss({ event: id });
        }
        // Co-location badges: centered on their shared fix.
        const badges = [
          ...map.querySelectorAll<HTMLElement>(".dashboard-map-group"),
        ]
          .filter(rendered)
          .map((n) => {
            const r = n.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
        for (const fix of expected.groups || []) {
          const want = truth(tile, fix);
          if (!inside(want)) continue;
          let best = Infinity;
          for (const b of badges)
            best = Math.min(best, Math.hypot(b.x - want.x, b.y - want.y));
          if (best > 30) {
            if (inside(want, 20)) miss({ group: fix });
            continue;
          }
          state.measured.groups++;
          record("groupErr", best, { group: fix });
        }
        for (const line of map.querySelectorAll<SVGLineElement>(
          ".dashboard-map-connection",
        )) {
          if (!line.isConnected || getComputedStyle(line).display === "none")
            continue;
          const ctm = line.getScreenCTM();
          if (!ctm) continue;
          for (const [end, key] of [
            ["1", "from"],
            ["2", "to"],
          ] as const) {
            const want = truth(tile, fixes[line.dataset[key]!]);
            if (!inside(want)) continue;
            const pt = line.ownerSVGElement!.createSVGPoint();
            pt.x = Number(line.getAttribute(`x${end}`));
            pt.y = Number(line.getAttribute(`y${end}`));
            const got = pt.matrixTransform(ctm);
            state.measured.lines++;
            record("lineErr", Math.hypot(got.x - want.x, got.y - want.y), {
              line: line.dataset.to,
              end,
            });
          }
        }
        for (const [from, to] of expected.lines || []) {
          const line = map.querySelector<SVGLineElement>(
            `.dashboard-map-connection[data-to="${to}"]`,
          );
          const shown =
            !!line &&
            line.isConnected &&
            getComputedStyle(line).display !== "none";
          if (
            !shown &&
            (inside(truth(tile, fixes[from]), 20) ||
              inside(truth(tile, fixes[to]), 20))
          )
            miss({ line: to });
        }
        // A removed member leaves no node at all, painted or not.
        for (const member of expected.absent || []) {
          const leaks = [
            ...pins.filter((p) =>
              p.dataset.memberIds!.split(" ").includes(member),
            ),
            ...map.querySelectorAll(
              `.dashboard-event-dot[data-member-id="${member}"], .dashboard-map-connection[data-member-id="${member}"]`,
            ),
          ];
          if (leaks.length) {
            state.leaked++;
            if (state.leaks.length < 4)
              state.leaks.push({
                frame: state.frames,
                member,
                nodes: leaks.length,
              });
          }
        }
      };
      const loop = () => {
        if (!state.running) return;
        sample();
        requestAnimationFrame(loop);
      };
      // Overlay mutations, attributed to the native map event that caused them.
      let pending = 0;
      const ours = (r: MutationRecord) =>
        !!(r.target as Element).closest?.(
          ".dashboard-map-overlay, .dashboard-latest-overlay",
        ) ||
        !!r.target.parentElement?.closest(
          ".dashboard-map-overlay, .dashboard-latest-overlay",
        );
      const kinds: Record<string, number> = {};
      const count = (records: MutationRecord[]) => {
        const mine = records.filter(ours);
        for (const r of mine) {
          const k = `${(r.target as Element).className?.baseVal ?? (r.target as Element).className}:${r.type}:${r.attributeName || ""}`;
          kinds[k] = (kinds[k] || 0) + 1;
        }
        return mine.length;
      };
      const observer = new MutationObserver((records) => {
        if (state.running) pending += count(records);
      });
      observer.observe(map, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
      const drain = () => {
        const n = pending + count(observer.takeRecords());
        pending = 0;
        return state.running ? n : 0;
      };
      const onStart = () => (state.otherRecords += drain());
      const onMove = () => {
        if (!state.running) return drain();
        const n = drain();
        state.moves++;
        state.moveRecords += n;
        state.frameWrites.push(n);
      };
      const onEnd = () => (state.settleRecords += drain());
      m.on("movestart zoomstart zoomanim", onStart);
      m.on("move", onMove);
      m.on("moveend", onEnd);
      w.__motion = {
        start(next?: any) {
          drain();
          if (next) {
            prepare(next);
            expected = next;
          }
          state = fresh();
          state.running = true;
          lenient = false;
          watch = null;
          for (const k of Object.keys(kinds)) delete kinds[k];
          requestAnimationFrame(loop);
        },
        stop() {
          sample();
          state.running = false;
          return JSON.parse(
            JSON.stringify({
              ...state,
              writeKinds: kinds,
              pendingWatch: watch?.selector || null,
            }),
          );
        },
        // A mutation starts now; missing checks pause until the watch sees
        // its effect, then the watched spec applies from that very frame.
        mutate(selector: string, next: any, gone = false) {
          state.mutation = {
            frame: state.frames,
            anim: animating(),
            at: performance.now(),
            animFramesAfter: 0,
          };
          lenient = true;
          watch = { selector, spec: next, gone };
        },
        expect(next: any) {
          prepare(next);
          expected = next;
        },
        prepare,
        sample,
        dispose() {
          observer.disconnect();
          m.off("movestart zoomstart zoomanim", onStart);
          m.off("move", onMove);
          m.off("moveend", onEnd);
          for (const list of refs.values()) for (const r of list) r.remove();
          refs.clear();
        },
      };
    },
    { fixes, spec },
  );

export const marks = (page: any) =>
  page.evaluate(
    () =>
      document.querySelectorAll(
        ".dashboard-latest-pin, .dashboard-map-marker, .dashboard-map-connection",
      ).length,
  );
export const settled = (page: any) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        (window as any).fixtureMap.once("moveend", () =>
          setTimeout(resolve, 300),
        ),
      ),
  );
const metrics = async (cdp: any) =>
  Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics
      .filter((m: any) =>
        [
          "LayoutCount",
          "RecalcStyleCount",
          "LayoutDuration",
          "RecalcStyleDuration",
          "ScriptDuration",
          "TaskDuration",
        ].includes(m.name),
      )
      .map((m: any) => [m.name, m.value]),
  );
export type Log = { entries: any[]; failures: string[] };
export type Expect = {
  pan?: boolean;
  zoom?: boolean;
  pinch?: boolean;
  lines?: boolean;
  dots?: boolean;
  pins?: boolean;
};
// Rounding-only tolerance against the painted tiles and native markers, every
// sampled frame; nothing expected missing, nothing denied leaked; fixed icons.
export const verdict = (s: any, total: number, o: Expect) => {
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => ok || problems.push(what);
  check(s.frames >= 5, "sampled frames");
  if (o.zoom) check(s.animFrames >= 3, "zoom animation frames");
  if (o.pinch) check(s.fractionalFrames >= 3, "pinch fractional frames");
  if (o.pins !== false) check(s.measured.pins > 0, "measured pins");
  if (o.dots !== false) check(s.measured.dots > 0, "measured dots");
  if (o.lines !== false) check(s.measured.lines > 0, "measured lines");
  // Mid zoom-out, Leaflet's own (pixel-rounded) markers can sit up to ~2px
  // off the painted tiles; the tile bound never goes below 1.5px nor more
  // than 0.5px past what native markers show in the same gesture. Pins are
  // held to 1.5px against those native markers.
  const tiles = Math.max(1.5, s.nativeErr + 0.5);
  check(s.pinErr <= tiles, `latest pin drift ${s.pinErr.toFixed(2)}px`);
  check(
    s.pinRefErr <= 1.5,
    `latest pin vs native marker ${s.pinRefErr.toFixed(2)}px`,
  );
  check(s.dotErr <= tiles, `event dot drift ${s.dotErr.toFixed(2)}px`);
  check(s.groupErr <= tiles, `group badge drift ${s.groupErr.toFixed(2)}px`);
  check(s.lineErr <= tiles, `line endpoint drift ${s.lineErr.toFixed(2)}px`);
  check(s.missing === 0, `missing ${s.missing} ${JSON.stringify(s.missed)}`);
  check(s.unexpected === 0, `unexpected latest pins ${s.unexpected}`);
  check(s.leaked === 0, `denied geometry ${JSON.stringify(s.leaks)}`);
  if (s.measured.pins)
    check(s.pinSize[0] >= 39.5 && s.pinSize[1] <= 40.5, "photo size");
  if (s.measured.dots)
    check(s.dotSize[0] >= 13.5 && s.dotSize[1] <= 14.5, "dot size");
  // Pan and pinch move a shared frame: per-move overlay DOM writes stay
  // bounded (marks crossing the viewport edge toggle visibility), never one
  // write per mark per move.
  if (o.pan || o.pinch) {
    check(s.moves >= 8, "native move events");
    check(
      s.moveRecords <= s.moves * 4 + total,
      `overlay writes ${s.moveRecords} over ${s.moves} moves (${total} marks)`,
    );
    check(
      Math.max(0, ...s.frameWrites) <= 24,
      `max overlay writes in one move ${Math.max(0, ...s.frameWrites)}`,
    );
  }
  return problems;
};
export const gesture = async (
  page: any,
  cdp: any,
  name: string,
  act: () => Promise<void>,
  log: Log,
  o: Expect = {},
  next?: Spec,
) => {
  const total = await marks(page);
  const ended = settled(page);
  const before = await metrics(cdp);
  await page.evaluate((n: any) => (window as any).__motion.start(n), next);
  await act();
  await ended;
  const s = await page.evaluate(() => (window as any).__motion.stop());
  const after = await metrics(cdp);
  const perf = Object.fromEntries(
    Object.keys(after).map((k) => [k, +(after[k] - before[k]).toFixed(4)]),
  );
  const entry = { name, marks: total, ...s, perf };
  log.entries.push(entry);
  const problems = verdict(s, total, o);
  if (problems.length)
    log.failures.push(
      `${name}: ${problems.join("; ")} :: ${JSON.stringify({ ...entry, frameWrites: undefined })}`,
    );
  return s;
};
export const saveReport = async (
  dir: string | undefined,
  file: string,
  log: Log,
) => {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(log, null, 2));
};
