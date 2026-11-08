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

// In-page sampler. Each sampled frame compares every painted overlay anchor
// with the basemap visible at its own fix. On every tile level, the loaded
// tile whose source z/x/y contains the projected fix gives that level's screen
// position for the fix (its actual rectangle). That level contributes there
// with its effective opacity (image and ancestors) times what the levels
// stacked above it let through at that screen point. Contributions below
// VISIBLE are not visible basemap; the largest one is the reference, and the
// anchor must be within 1.5px of it. Where no level is visible at the fix (an
// unloaded strip or a tile still fading in), a mark painted over visible tiles
// is held to where those tiles' own grid places its fix; a mark over blank map
// is counted as unverified, never as measured. When the visible levels used in
// a frame place the same fix more than 1.5px apart, the frame is a basemap
// split (Leaflet/browser): inconclusive, never a pass. Native Leaflet markers
// at the same fixes are a separate conformance check, never an alternate
// basemap.
// Expected marks that are absent although their fix is well inside the map
// count as missing; geometry of an absent member counts as leaked. Overlay DOM
// mutations are attributed to the native move event that caused them, and
// fixed icon sizes are checked.
// A level contributing under 2% at a point (about 5 of 255 levels of an 8-bit
// channel against a fully contrasting level) is not counted as visible.
const VISIBLE = 0.02;
export const install = (
  page: any,
  fixes: Record<string, [number, number]>,
  spec: Spec,
) =>
  page.evaluate(
    ({ fixes, spec, VISIBLE }: any) => {
      const w = window as any;
      w.__motion?.dispose?.();
      const m = w.fixtureMap,
        L = w.L;
      const map = document.getElementById("dashboardMap")!;
      // Per tile level, the central loaded tile that is painted (a loaded
      // tile at opacity 0, before its fade-in starts, is not yet seen).
      const tileRefs = (box: DOMRect) => {
        const refs: any[] = [];
        for (const level of map.querySelectorAll<HTMLElement>(
          ".leaflet-tile-container",
        )) {
          let best: any = null;
          for (const img of level.querySelectorAll<HTMLImageElement>(
            "img.leaflet-tile-loaded",
          )) {
            const r = img.getBoundingClientRect();
            if (!r.width) continue;
            const d = Math.hypot(
              r.left + r.width / 2 - (box.left + box.width / 2),
              r.top + r.height / 2 - (box.top + box.height / 2),
            );
            if (best && d >= best.d) continue;
            const match = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(img.src);
            if (!match || +getComputedStyle(img).opacity <= 0) continue;
            best = { d, r, z: +match[1], x: +match[2], y: +match[3] };
          }
          if (best) refs.push(best);
        }
        return refs.sort((a, b) => a.d - b.d);
      };
      // Effective opacity as painted: the node's and every ancestor's.
      const alphaOf = (el: Element) => {
        let a = 1;
        for (let n: Element | null = el; n; n = n.parentElement)
          a *= +getComputedStyle(n).opacity;
        return a;
      };
      // Tile levels in this frame, top of the stack first (z-index, then
      // document order), with each loaded tile's source, rectangle and
      // effective opacity.
      const basemapLevels = (box: DOMRect) => {
        const out: any[] = [];
        const containers = map.querySelectorAll<HTMLElement>(
          ".leaflet-tile-container",
        );
        containers.forEach((el, order) => {
          const level = alphaOf(el);
          const tiles: any[] = [];
          for (const img of el.querySelectorAll<HTMLImageElement>(
            "img.leaflet-tile-loaded",
          )) {
            if (!img.complete || !img.naturalWidth) continue;
            const match = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(img.src);
            if (!match) continue;
            const r = img.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            tiles.push({
              z: +match[1],
              x: +match[2],
              y: +match[3],
              r,
              alpha: level * +getComputedStyle(img).opacity,
            });
          }
          if (!tiles.length) return;
          const mid = (t: any) =>
            Math.hypot(
              t.r.left + t.r.width / 2 - (box.left + box.width / 2),
              t.r.top + t.r.height / 2 - (box.top + box.height / 2),
            );
          out.push({
            el,
            order,
            zIndex: parseInt(getComputedStyle(el).zIndex) || 0,
            z: tiles[0].z,
            tiles,
            central: tiles.reduce((a, b) => (mid(b) < mid(a) ? b : a)),
          });
        });
        return out.sort((a, b) => b.zIndex - a.zIndex || b.order - a.order);
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
      // Native Leaflet markers (zero-size div icons) in three world copies, at
      // every fix the sampler measures. Created before a gesture: a marker
      // added mid-zoom is itself placed at Leaflet's target view.
      const refs = new Map<string, any[]>();
      const prepare = (next: any) => {
        for (const [lat, lng] of [
          ...(Object.values(next.latest) as any),
          ...(next.groups || []),
        ]) {
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
      prepare({ latest: fixes });
      prepare(spec);
      const native = ([lat, lng]: [number, number], box: DOMRect) => {
        const key = `${lat},${lng}`;
        if (!refs.has(key)) return null;
        const mid = box.left + box.width / 2;
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
        stamps: [] as number[],
        // Diagnostic: the sampling callback's stamp against the document
        // timeline that drives CSS transitions (equal on a native rAF).
        offTimeline: 0,
        timelineSkew: 0,
        // Anchors against the visible basemap at their own fix.
        pinErr: 0,
        dotErr: 0,
        groupErr: 0,
        lineErr: 0,
        worst: null as any,
        // Frames whose visible levels place the same fix incompatibly, and
        // anchors with no visible basemap at their fix.
        ambiguousFrames: 0,
        ambiguous: [] as any[],
        levelSpread: 0,
        unverified: 0,
        unverifiedAt: [] as any[],
        byMark: 0,
        // Weakest visible contribution taken as a reference, and the most
        // visible levels at one fix.
        minShown: Infinity,
        maxLevels: 0,
        blankSamples: 0,
        // Native conformance, separate: anchors against the native marker at
        // their fix; the native marker against the visible basemap.
        pinRefErr: 0,
        nativeBy: { pinErr: 0, dotErr: 0, groupErr: 0, lineErr: 0 } as any,
        nativeErr: 0,
        nativeSplitFrames: 0,
        nativeWorst: null as any,
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
      const sample = (stamp?: number) => {
        const box = map.getBoundingClientRect();
        const tiles = tileRefs(box);
        if (!tiles.length) {
          state.blankSamples++;
          return;
        }
        // The central painted tile decides what counts as in view.
        const tile = tiles[0];
        const levels = basemapLevels(box);
        if (stamp !== undefined) {
          state.stamps.push(stamp);
          const skew = Math.abs(
            (document.timeline.currentTime as number) - stamp,
          );
          if (skew > 0.01) state.offTimeline++;
          state.timelineSkew = Math.max(state.timelineSkew, skew);
        }
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
        const within = (p: any) =>
          p.x >= box.left &&
          p.x <= box.right &&
          p.y >= box.top &&
          p.y <= box.bottom;
        const mid = box.left + box.width / 2;
        // A level's own tile whose source contains the fix: the screen point
        // where that level paints it (nearest world copy to the map center).
        const onLevel = (level: any, [lat, lng]: [number, number]) => {
          const p = m.project([lat, lng], level.z),
            n = 2 ** level.z;
          const col = Math.floor(p.x / 256),
            row = Math.floor(p.y / 256);
          const x = ((col % n) + n) % n;
          let best: any = null;
          for (const t of level.tiles) {
            if (t.x !== x || t.y !== row) continue;
            const at = {
              x: t.r.left + ((p.x - col * 256) * t.r.width) / 256,
              y: t.r.top + ((p.y - row * 256) * t.r.height) / 256,
            };
            if (!best || Math.abs(at.x - mid) < Math.abs(best.at.x - mid))
              best = { t, at };
          }
          return best;
        };
        // How much a level covers a screen point (its tile there).
        const tileAt = (level: any, p: any) => {
          let best: any = null;
          for (const t of level.tiles)
            if (
              p.x >= t.r.left &&
              p.x < t.r.right &&
              p.y >= t.r.top &&
              p.y < t.r.bottom &&
              (!best || t.alpha > best.alpha)
            )
              best = t;
          return best;
        };
        const cover = (level: any, p: any) => tileAt(level, p)?.alpha || 0;
        // The dominant visible level at a screen point, and its tile there.
        const visibleAt = (p: any) => {
          if (!within(p)) return null;
          let best: any = null,
            through = 1;
          levels.forEach((level, k) => {
            const t = tileAt(level, p);
            if (!t || through <= 0) return;
            const shown = t.alpha * through;
            if (shown >= VISIBLE && (!best || shown > best.shown))
              best = { level: k, z: level.z, t, shown };
            through *= 1 - t.alpha;
          });
          return best;
        };
        // Where the tile under a mark places a fix on its own level's grid
        // (the world copy nearest the mark).
        const viaTile = (t: any, got: any, fix: [number, number]) => {
          const q = m.project(fix, t.z),
            n = 2 ** t.z;
          const off = q.x / 256 - t.x - (got.x - t.r.left) / t.r.width;
          const j = -Math.round(off / n);
          return {
            x: t.r.left + ((q.x + j * n * 256 - t.x * 256) * t.r.width) / 256,
            y: t.r.top + ((q.y - t.y * 256) * t.r.height) / 256,
          };
        };
        // The visible basemap at a fix in this frame, read once per fix.
        const painted = new Map<string, any>();
        const basemapAt = (fix: [number, number]) => {
          const key = `${fix[0]},${fix[1]}`;
          let b = painted.get(key);
          if (b) return b;
          const refs: any[] = [];
          levels.forEach((level, k) => {
            const on = onLevel(level, fix);
            if (!on) return;
            let shown = within(on.at) ? on.t.alpha : 0;
            for (let j = 0; j < k && shown > 0; j++)
              shown *= 1 - cover(levels[j], on.at);
            refs.push({ level: k, z: level.z, shown, at: on.at });
          });
          const visible = refs.filter((r) => r.shown >= VISIBLE);
          const dominant = visible.length
            ? visible.reduce((a, b) => (b.shown > a.shown ? b : a))
            : null;
          const ref = native(fix, box);
          b = { refs, visible, dominant, ref };
          painted.set(key, b);
          if (dominant && ref) {
            const off = Math.hypot(
              ref.x - dominant.at.x,
              ref.y - dominant.at.y,
            );
            if (off > 1.5) nativeSplit = true;
            if (off > state.nativeErr) {
              state.nativeErr = off;
              state.nativeWorst = {
                frame: state.frames,
                anim: animating(),
                fix,
                z: dominant.z,
              };
            }
          }
          return b;
        };
        // Measured when the central tile puts the fix in view or any level
        // visibly paints it there.
        const inView = (fix: [number, number]) =>
          inside(truth(tile, fix)) || !!basemapAt(fix).dominant;
        const round = (p: any) =>
          p && { x: +p.x.toFixed(1), y: +p.y.toFixed(1) };
        let nativeSplit = false;
        const usedLevels = new Set<number>(),
          usedFixes = new Map<string, [number, number]>();
        // An anchor against the visible basemap at its fix; null when no
        // level is visible there (counted, never passed).
        const against = (got: any, fix: [number, number], kind: string) => {
          const b = basemapAt(fix);
          if (b.ref) {
            state.measured.refs++;
            const toRef = Math.hypot(got.x - b.ref.x, got.y - b.ref.y);
            state.nativeBy[kind] = Math.max(state.nativeBy[kind], toRef);
            if (kind === "pinErr")
              state.pinRefErr = Math.max(state.pinRefErr, toRef);
          }
          const toRef = b.ref
            ? +Math.hypot(got.x - b.ref.x, got.y - b.ref.y).toFixed(2)
            : null;
          if (b.dominant) {
            for (const r of b.visible) usedLevels.add(r.level);
            usedFixes.set(`${fix[0]},${fix[1]}`, fix);
            state.minShown = Math.min(state.minShown, b.dominant.shown);
            state.maxLevels = Math.max(state.maxLevels, b.visible.length);
            return {
              err: Math.hypot(got.x - b.dominant.at.x, got.y - b.dominant.at.y),
              z: b.dominant.z,
              shown: +b.dominant.shown.toFixed(3),
              levels: b.visible.length,
              toRef,
            };
          }
          // No visible basemap at the fix (a blank or still-fading area): a
          // mark painted over visible tiles is held to where those tiles put
          // its fix; a mark over blank map has nothing to be misplaced on.
          const under = visibleAt(got);
          if (!under) return null;
          const at = viaTile(under.t, got, fix);
          usedLevels.add(under.level);
          usedFixes.set(`${fix[0]},${fix[1]}`, fix);
          state.byMark++;
          state.minShown = Math.min(state.minShown, under.shown);
          return {
            err: Math.hypot(got.x - at.x, got.y - at.y),
            z: under.z,
            shown: +under.shown.toFixed(3),
            under: round(at),
            toRef,
          };
        };
        const unverify = (what: any, fix: [number, number]) => {
          state.unverified++;
          if (state.unverifiedAt.length < 4)
            state.unverifiedAt.push({
              frame: state.frames,
              anim: animating(),
              ...what,
              refs: basemapAt(fix).refs.map((r: any) => ({
                z: r.z,
                shown: +r.shown.toFixed(4),
                at: round(r.at),
              })),
              box: [box.left, box.top, box.right, box.bottom].map(Math.round),
              levels: levels.map((l: any) => ({
                z: l.z,
                tiles: l.tiles.length,
                alpha: +Math.max(...l.tiles.map((t: any) => t.alpha)).toFixed(
                  3,
                ),
                span: [
                  Math.min(...l.tiles.map((t: any) => t.r.left)),
                  Math.min(...l.tiles.map((t: any) => t.r.top)),
                  Math.max(...l.tiles.map((t: any) => t.r.right)),
                  Math.max(...l.tiles.map((t: any) => t.r.bottom)),
                ].map(Math.round),
                xs: [...new Set(l.tiles.map((t: any) => t.x))],
                ys: [...new Set(l.tiles.map((t: any) => t.y))],
                want: (() => {
                  const q = m.project(fix, l.z);
                  return [Math.floor(q.x / 256), Math.floor(q.y / 256)];
                })(),
              })),
            });
        };
        // Where a fix is painted this frame: the visible basemap and the
        // native marker.
        const where = (fix: [number, number]) => {
          const b = basemapAt(fix);
          return { tile: round(b.dominant?.at), ref: round(b.ref) };
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
          if (!inView(fix)) continue;
          const photo = pin
            .querySelector(".dashboard-latest-photo")!
            .getBoundingClientRect();
          // The pin tip (40px photo + 11px arrow) marks the exact fix.
          const tip = {
            x: photo.left + photo.width / 2,
            y: photo.bottom + (11 * photo.height) / 40,
          };
          state.pinSize[0] = Math.min(state.pinSize[0], photo.width);
          state.pinSize[1] = Math.max(state.pinSize[1], photo.width);
          const near = against(tip, fix, "pinErr");
          if (!near) {
            unverify({ ids: pin.dataset.memberIds }, fix);
            continue;
          }
          state.measured.pins++;
          const { err, ...to } = near;
          record("pinErr", err, { ids: pin.dataset.memberIds, tip, ...to });
        }
        // Every expected member is painted (in its own pin or a group).
        for (const [member, fix] of Object.entries(expected.latest) as any) {
          const pin = pins.find((p) =>
            p.dataset.memberIds!.split(" ").includes(member),
          );
          if (!rendered(pin || null) && inside(truth(tile, fix), 40))
            miss({ latest: member, ...where(fix) });
        }
        for (const dot of map.querySelectorAll<HTMLElement>(
          ".dashboard-event-dot",
        )) {
          if (!rendered(dot)) continue;
          const fix = fixes[dot.dataset.eventId!];
          if (!inView(fix)) continue;
          const r = dot.getBoundingClientRect();
          state.dotSize[0] = Math.min(state.dotSize[0], r.width);
          state.dotSize[1] = Math.max(state.dotSize[1], r.width);
          const got = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          const near = against(got, fix, "dotErr");
          if (!near) {
            unverify({ event: dot.dataset.eventId }, fix);
            continue;
          }
          state.measured.dots++;
          const { err, ...to } = near;
          record("dotErr", err, { event: dot.dataset.eventId, ...to });
        }
        for (const id of expected.events || []) {
          const dot = map.querySelector(
            `.dashboard-event-dot[data-event-id="${id}"]`,
          );
          if (!rendered(dot) && inside(truth(tile, fixes[id]), 20))
            miss({ event: id, ...where(fixes[id]) });
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
          if (!inView(fix)) continue;
          let best: any = null,
            blank = false;
          for (const b of badges) {
            const near = against(b, fix, "groupErr");
            if (!near) blank = true;
            else if (!best || near.err < best.err) best = near;
          }
          if (!best && blank) {
            unverify({ group: fix }, fix);
            continue;
          }
          if (!best || best.err > 30) {
            if (inside(want, 20)) miss({ group: fix, ...where(fix) });
            continue;
          }
          state.measured.groups++;
          const { err, ...to } = best;
          record("groupErr", err, { group: fix, ...to });
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
            const fix = fixes[line.dataset[key]!];
            if (!inView(fix)) continue;
            const pt = line.ownerSVGElement!.createSVGPoint();
            pt.x = Number(line.getAttribute(`x${end}`));
            pt.y = Number(line.getAttribute(`y${end}`));
            const got = pt.matrixTransform(ctm);
            const near = against(got, fix, "lineErr");
            if (!near) {
              unverify({ line: line.dataset.to, end }, fix);
              continue;
            }
            state.measured.lines++;
            const { err, ...to } = near;
            record("lineErr", err, { line: line.dataset.to, end, ...to });
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
            miss({ line: to, ends: [where(fixes[from]), where(fixes[to])] });
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
        if (nativeSplit) state.nativeSplitFrames++;
        // Every visible level an anchor was judged against in this frame must
        // place every judged fix within rounding of the others; otherwise the
        // visible basemap itself is split and the frame cannot qualify.
        const used = [...usedLevels];
        let spread = 0,
          worst: any = null;
        const placed = (k: number, fix: [number, number]) =>
          onLevel(levels[k], fix)?.at || truth(levels[k].central, fix);
        for (let i = 0; i < used.length; i++)
          for (let j = i + 1; j < used.length; j++)
            for (const fix of usedFixes.values()) {
              const a = placed(used[i], fix),
                b = placed(used[j], fix);
              const d = Math.hypot(a.x - b.x, a.y - b.y);
              if (d > spread) {
                spread = d;
                worst = { fix, levels: [used[i], used[j]], a, b };
              }
            }
        state.levelSpread = Math.max(state.levelSpread, spread);
        if (spread > 1.5) {
          state.ambiguousFrames++;
          if (state.ambiguous.length < 4)
            state.ambiguous.push({
              frame: state.frames,
              anim: animating(),
              spread: +spread.toFixed(2),
              fix: worst.fix,
              timeline: document.timeline.currentTime,
              levels: worst.levels.map((k: number) => ({
                z: levels[k].z,
                zIndex: levels[k].zIndex,
                transform: levels[k].el.style.transform,
                animations: levels[k].el.getAnimations().map((a: any) => ({
                  start: a.startTime,
                  current: a.currentTime,
                })),
              })),
              at: [round(worst.a), round(worst.b)],
            });
        }
      };
      // One sampling chain at a time: each start owns a new generation and
      // cancels the previous chain's pending frame.
      let generation = 0,
        handle = 0;
      const loop = (owner: number) => (stamp: number) => {
        if (owner !== generation || !state.running) return;
        sample(stamp);
        handle = requestAnimationFrame(loop(owner));
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
          cancelAnimationFrame(handle);
          handle = requestAnimationFrame(loop(++generation));
        },
        stop() {
          sample();
          state.running = false;
          generation++;
          cancelAnimationFrame(handle);
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
          generation++;
          cancelAnimationFrame(handle);
          observer.disconnect();
          m.off("movestart zoomstart zoomanim", onStart);
          m.off("move", onMove);
          m.off("moveend", onEnd);
          for (const list of refs.values()) for (const r of list) r.remove();
          refs.clear();
        },
      };
    },
    { fixes, spec, VISIBLE },
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
// Rounding-only tolerance against the visible basemap at each anchor's fix,
// every sampled frame; a split visible basemap is inconclusive, never a pass;
// native markers checked separately; nothing expected missing, nothing denied
// leaked; fixed icons.
export const verdict = (s: any, total: number, o: Expect) => {
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => ok || problems.push(what);
  check(s.frames >= 5, "sampled frames");
  if (o.zoom) check(s.animFrames >= 3, "zoom animation frames");
  if (o.pinch) check(s.fractionalFrames >= 3, "pinch fractional frames");
  if (o.pins !== false) check(s.measured.pins > 0, "measured pins");
  if (o.dots !== false) check(s.measured.dots > 0, "measured dots");
  if (o.lines !== false) check(s.measured.lines > 0, "measured lines");
  // Basemap: every anchor, every frame, within 1.5px (rounding) of the
  // dominant visible tile level at its own fix.
  check(
    s.ambiguousFrames === 0,
    `basemap ambiguous/inconclusive (Leaflet/browser split): ${s.ambiguousFrames} frames, visible levels ${s.levelSpread.toFixed(2)}px apart ${JSON.stringify(s.ambiguous)}`,
  );
  check(s.pinErr <= 1.5, `latest pin drift ${s.pinErr.toFixed(2)}px`);
  check(s.dotErr <= 1.5, `event dot drift ${s.dotErr.toFixed(2)}px`);
  check(s.groupErr <= 1.5, `group badge drift ${s.groupErr.toFixed(2)}px`);
  check(s.lineErr <= 1.5, `line endpoint drift ${s.lineErr.toFixed(2)}px`);
  // Native conformance, a separate result: latest pins against a native
  // Leaflet marker at the same fix.
  if (s.measured.pins || s.measured.dots)
    check(s.measured.refs > 0, "measured native markers");
  check(
    s.pinRefErr <= 1.5,
    `native conformance: latest pin vs native marker ${s.pinRefErr.toFixed(2)}px`,
  );
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
