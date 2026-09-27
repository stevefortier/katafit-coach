import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import { supervise } from "./helpers/legacy-supervisor.js";

test("manual update stable owner resumes after replacement and rollback without a surviving browser", async () => {
  const home = await mkdtemp(join(tmpdir(), "manual-resume-"));
  let unavailable = false;
  const backend = createServer(async (req, res) => {
    if (unavailable) return void res.writeHead(503).end();
    let raw = "";
    for await (const part of req) raw += part;
    const msg = JSON.parse(raw);
    if (msg.method === "notifications/initialized")
      return void res.writeHead(202).end();
    const result =
      msg.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : msg.method === "tools/list"
          ? { tools: [] }
          : { structuredContent: { requests: [] } };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const store = new Store(home);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: `http://127.0.0.1:${(backend.address() as any).port}`,
    token: "synthetic-manual-token",
    apiKey: "synthetic-manual-provider",
  });
  let latest = "a".repeat(40);
  const bad = "b".repeat(40);
  const owner = await supervise(store, 0, undefined, {
    request: async () =>
      new Response(JSON.stringify({ object: { sha: latest } })),
    prepare: async (sha) => {
      const root = join(home, "versions", sha);
      await mkdir(join(root, "dist/config"), { recursive: true });
      await mkdir(join(root, "dist/server"), { recursive: true });
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await writeFile(
        join(root, "dist/build.json"),
        JSON.stringify({ revision: sha, protocol: 1 }),
      );
      await writeFile(
        join(root, "dist/config/store.js"),
        `export {Store} from ${JSON.stringify(pathToFileURL(resolve("dist/config/store.js")).href)};`,
      );
      await writeFile(
        join(root, "dist/server/admin.js"),
        `import {admin as base} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)}; export async function admin(...args){${sha === bad ? `if(args[0].dir===${JSON.stringify(home)}) throw Error('synthetic startup failure');` : ""}return base(...args);}`,
      );
      return root;
    },
  });
  const headers = {
    Authorization: "Bearer " + store.secrets.admin,
    Origin: owner.origin,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(owner.origin + "/api/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  let recoveredOwner: Awaited<ReturnType<typeof supervise>> | undefined;
  const waitIdle = async () => {
    for (let i = 0; i < 100; i++) {
      const status = await (
        await fetch(owner.origin + "/api/status", { headers })
      ).json();
      if (status.state === "idle" && status.safeToReplace) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("manual admission requires idle publication-safe worker");
  };
  try {
    assert.equal((await post("run")).status, 200);
    for (const target of [latest, bad]) {
      latest = target;
      owner.updates.checkedAt = 0;
      await post("update/check");
      await waitIdle();
      const pid = owner.pid;
      const accepted = await post("update/apply", {
        sha: target,
        confirm: true,
      });
      assert.equal(accepted.status, 202, await accepted.clone().text());
      let done = false;
      for (let i = 0; i < 160; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (owner.updates.applying || owner.updates.recovering) continue;
        try {
          const state = await (
            await fetch(owner.origin + "/api/status", { headers })
          ).json();
          if (["idle", "connecting"].includes(state.state)) {
            done = true;
            break;
          }
        } catch {}
      }
      assert.equal(
        done,
        true,
        "stable owner must resume, not leave applied-but-stopped",
      );
      assert.notEqual(owner.pid, pid);
      assert.equal(
        owner.updates.lastOperation?.state,
        target === bad ? "failed" : "succeeded",
      );
      assert.equal(
        JSON.parse(await readFile(join(home, "update-resume.json"), "utf8"))
          .pending,
        false,
      );
    }
    // Exhausted resume persists intent; a new stable owner recovers even with
    // automatic updates off and no browser. Never re-apply the source revision.
    latest = "c".repeat(40);
    owner.updates.checkedAt = 0;
    await post("update/check");
    await waitIdle();
    unavailable = true;
    assert.equal(
      (await post("update/apply", { sha: latest, confirm: true })).status,
      202,
    );
    for (let i = 0; i < 100 && owner.updates.applying; i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(owner.updates.recovering, true);
    assert.equal(
      JSON.parse(await readFile(join(home, "update-resume.json"), "utf8"))
        .pending,
      true,
    );
    assert.equal((await post("config", {})).status, 409);
    await owner.close();
    unavailable = false;
    recoveredOwner = await supervise(store, 0);
    let resumed = false;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const response = await fetch(recoveredOwner.origin + "/api/status", {
        headers: { Authorization: headers.Authorization },
      });
      if (
        (await response.json()).state !== "stopped" &&
        !recoveredOwner.updates.recovering
      ) {
        resumed = true;
        break;
      }
    }
    assert.equal(resumed, true);
    assert.equal(recoveredOwner.updates.installed, latest);
    assert.equal(
      JSON.parse(await readFile(join(home, "update-resume.json"), "utf8"))
        .pending,
      false,
    );
  } finally {
    await recoveredOwner?.close();
    await owner.close();
    backend.closeAllConnections();
    await new Promise<void>((r) => backend.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});
