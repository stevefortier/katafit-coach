// Under the bootstrap, a successful upgrade with a running worker hands over:
// the outgoing supervisor must not resume the worker on the application that
// stops with it. It leaves update-resume.json pending, and the successor
// supervisor resumes the worker on the application it keeps.
import "./fixtures/legacy-source-check.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/config/store.js";
import { supervise } from "./helpers/legacy-supervisor.js";

test("a handed-over upgrade leaves the worker resume to the successor supervisor", async () => {
  const home = await mkdtemp(join(tmpdir(), "handover-resume-"));
  const backend = createServer(async (req, res) => {
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
    token: "synthetic-handover-token",
    apiKey: "synthetic-handover-provider",
  });
  const target = "a".repeat(40);
  const prepare = async (sha: string) => {
    const root = join(home, "versions", sha);
    await mkdir(join(root, "dist/config"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "dist/server"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "dist/build.json"),
      JSON.stringify({
        revision: sha,
        protocol: 1,
        capabilities: ["workspace-sandbox-1"],
      }),
    );
    await writeFile(
      join(root, "dist/config/store.js"),
      `export {Store} from ${JSON.stringify(pathToFileURL(resolve("dist/config/store.js")).href)};`,
    );
    await writeFile(
      join(root, "dist/server/admin.js"),
      `export {admin, updatePreparationProtocol} from ${JSON.stringify(pathToFileURL(resolve("dist/server/admin.js")).href)};`,
    );
    return root;
  };
  const saved = process.env.KATAFIT_BOOT_PROTOCOL;
  process.env.KATAFIT_BOOT_PROTOCOL = "1";
  const reasons: (string | undefined)[] = [];
  let owner: Awaited<ReturnType<typeof supervise>> | undefined;
  let successor: Awaited<ReturnType<typeof supervise>> | undefined;
  const headersFor = (origin: string) => ({
    Authorization: "Bearer " + store.secrets.admin,
    Origin: origin,
    "Content-Type": "application/json",
  });
  const status = async (origin: string) =>
    (
      await fetch(origin + "/api/status", { headers: headersFor(origin) })
    ).json();
  const resumeIntent = async () =>
    JSON.parse(await readFile(join(home, "update-resume.json"), "utf8"));
  try {
    owner = await supervise(store, 0, (reason) => reasons.push(reason), {
      request: async () =>
        new Response(JSON.stringify({ object: { sha: target } })),
      prepare,
    });
    const origin = owner.origin;
    const post = (path: string, body: unknown = {}) =>
      fetch(origin + "/api/" + path, {
        method: "POST",
        headers: headersFor(origin),
        body: JSON.stringify(body),
      });
    assert.equal((await post("run")).status, 200);
    await post("update/check");
    for (let i = 0; i < 100; i++) {
      const s = await status(origin);
      if (s.state === "idle" && s.safeToReplace) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const accepted = await post("update/apply", { sha: target, confirm: true });
    assert.equal(accepted.status, 202, await accepted.clone().text());
    for (let i = 0; i < 200 && !reasons.includes("handover"); i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(reasons, ["handover"]);
    assert.equal(owner.updates.lastOperation?.state, "succeeded");
    // The outgoing supervisor left the resume to its successor.
    assert.deepEqual(await resumeIntent(), { sha: target, pending: true });
    assert.equal((await status(owner.origin)).state, "stopped");
    await owner.close();
    owner = undefined;

    // The bootstrap starts the successor: it resumes the worker itself.
    successor = await supervise(store, 0, undefined, {
      request: async () =>
        new Response(JSON.stringify({ object: { sha: target } })),
    });
    let resumed = false;
    for (let i = 0; i < 200 && !resumed; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (successor.updates.recovering) continue;
      resumed = ["idle", "connecting"].includes(
        (await status(successor.origin)).state,
      );
    }
    assert.ok(resumed, "the successor must resume the running worker");
    assert.equal(successor.updates.installed, target);
    assert.deepEqual(await resumeIntent(), { sha: target, pending: false });
  } finally {
    if (saved === undefined) delete process.env.KATAFIT_BOOT_PROTOCOL;
    else process.env.KATAFIT_BOOT_PROTOCOL = saved;
    await owner?.close();
    await successor?.close();
    backend.close();
    await rm(home, { recursive: true, force: true });
  }
});
