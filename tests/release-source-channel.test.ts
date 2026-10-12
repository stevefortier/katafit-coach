import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
test(
  "real child IPC does not infer ready source policy from child bytes under old owner",
  { timeout: 15000 },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "coach-source-channel-"));
    try {
      await mkdir(join(folder, "dist/config"), { recursive: true });
      await mkdir(join(folder, "dist/server"), { recursive: true });
      await writeFile(join(folder, "package.json"), '{"type":"module"}');
      await writeFile(
        join(folder, "dist/config/store.js"),
        "export class Store {async init(){}}",
      );
      await writeFile(
        join(folder, "dist/server/admin.js"),
        'export const updatePreparationProtocol=2; export async function admin(store,port,unused,close,updates){process.send({type:"fixtureSnapshot",state:updates.snapshot()});process.on("message",m=>{if(m.type==="fixtureRead")process.send({type:"fixtureRead",state:updates.snapshot()});});return {origin:"http://127.0.0.1:1",async close(){}}}',
      );
      for (const channel of [undefined, "ready-releases-v1", "invalid"]) {
        const child = fork(
          resolve("dist/update/runtime.js"),
          [folder, join(folder, "home"), "0", "nonce"],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        try {
          const result = new Promise<any>((resolveResult, reject) => {
            child.on("message", (m: any) => {
              if (m.type === "fixtureSnapshot") resolveResult(m.state);
              if (m.type === "startupFailure") reject(Error(m.reason));
            });
            child.on("error", reject);
          });
          child.send({
            type: "state",
            data: {
              supported: true,
              preparationProtocol: 2,
              readinessSupported: true,
              readinessProtocol: 1,
              readiness: { sha: "b".repeat(40), state: "ready" },
              installed: "a".repeat(40),
              manualOnlySourceUpdates: 1,
              sourceChannel: channel,
            },
          });
          const state = await result;
          assert.equal(state.readinessSupported, false);
          assert.equal(state.readiness, undefined);
          assert.equal(
            state.sourceChannel,
            channel === "ready-releases-v1" ? channel : "legacy-or-unknown",
          );
          const checkedAt = Date.now();
          const newer = {
            stateSequence: 2,
            latest: "c".repeat(40),
            checkedAt,
            readinessSupported: true,
            readinessProtocol: 1,
            readiness: {
              sha: "c".repeat(40),
              checkedAt,
              state: "delivery-pending",
            },
          };
          child.send({ type: "state", data: newer });
          child.send({
            type: "state",
            data: {
              ...newer,
              stateSequence: 1,
              latest: "b".repeat(40),
              readiness: { sha: "b".repeat(40), checkedAt, state: "ready" },
            },
          });
          const observed = new Promise<any>((resolve) => {
            const listener = (m: any) => {
              if (m.type === "fixtureRead") {
                child.off("message", listener);
                resolve(m.state);
              }
            };
            child.on("message", listener);
          });
          child.send({ type: "fixtureRead" });
          const current = await observed;
          assert.equal(current.latest, "c".repeat(40));
          assert.equal(current.readiness.state, "delivery-pending");
        } finally {
          const exit = once(child, "exit");
          child.kill("SIGTERM");
          await exit;
        }
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);
