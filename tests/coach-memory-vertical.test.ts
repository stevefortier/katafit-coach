import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "../src/config/store.js";
import { Worker } from "../src/worker/runner.js";
import { fixture as workerFixture } from "./worker.test.js";
import { fixture as nativeFixture } from "./helpers/native.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";

const exec = promisify(execFile);

function memoryHost(store: Store) {
  const method = (store as any).memoryAuthority;
  return typeof method === "function"
    ? method.call(store)
    : store.publicConfig().origin;
}

const lockHolderScript = String.raw`
const { spawn } = require("node:child_process");
const { constants } = require("node:fs");
const { lstat, open } = require("node:fs/promises");

(async () => {
  const path = process.argv[1];
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const [opened, linked] = await Promise.all([handle.stat(), lstat(path)]);
  if (
    !opened.isFile() ||
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    opened.dev !== linked.dev ||
    opened.ino !== linked.ino ||
    opened.nlink !== 1 ||
    opened.size !== 0 ||
    (opened.mode & 0o777) !== 0o600 ||
    (process.getuid !== undefined && opened.uid !== process.getuid())
  ) {
    throw new Error("LOCK_INVALID");
  }
  const flock = spawn("/usr/bin/flock", ["--exclusive", "3"], {
    env: {},
    stdio: ["ignore", "ignore", "ignore", handle.fd],
  });
  flock.once("error", (error) => {
    throw error;
  });
  flock.once("close", (code) => {
    if (code !== 0) throw new Error("LOCK_UNAVAILABLE");
    process.send?.({ status: "locked" });
    setInterval(() => {}, 1000);
  });
  process.once("SIGTERM", async () => {
    await handle.close().catch(() => {});
    process.exit(0);
  });
})().catch((error) => {
  process.send?.({ status: "error", message: error?.message || String(error) });
  process.exit(1);
});
`;

async function spawnLockHolder(lockPath: string) {
  const child = spawn(process.execPath, ["-e", lockHolderScript, lockPath], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("LOCK_HOLDER_TIMEOUT"));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("error", failed);
      child.off("exit", exited);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = () => {
      cleanup();
      reject(
        new Error(
          "LOCK_HOLDER_EXITED " + Buffer.concat(stderr).toString("utf8"),
        ),
      );
    };
    const message = (value: any) => {
      if (value?.status === "locked") {
        cleanup();
        resolve();
      } else if (value?.status === "error") {
        cleanup();
        reject(new Error(value.message || "LOCK_HOLDER_FAILED"));
      }
    };
    child.once("error", failed);
    child.once("exit", exited);
    child.on("message", message);
  });
  return child;
}

async function closeChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "close").catch(() => {});
}

test("memory store recovers after a SIGKILLed descriptor flock holder", async (t) => {
  if (process.platform !== "linux") {
    t.skip("descriptor flock lock is Linux-only");
    return;
  }
  const dir = await mkdtemp(tmpdir() + "/coach-memory-lock-");
  const store = new Store(dir);
  let holder: ChildProcess | undefined;
  try {
    await store.init();
    const lockPath = join(dir, "memories.lock");
    holder = await spawnLockHolder(lockPath);
    await assert.rejects(
      exec("/usr/bin/flock", ["--nonblock", lockPath, "true"]),
      /flock/,
    );
    holder.kill("SIGKILL");
    await once(holder, "close");
    holder = undefined;
    const entry = await store.memories.add({
      host: "synthetic-authority",
      subject: { scope: "boss" },
      kind: "preference",
      text: "Prefers lock recovery checks.",
      source: { type: "operator_correction", id: "synthetic-lock" },
    });
    assert.equal(entry.text, "Prefers lock recovery checks.");
  } finally {
    await closeChild(holder);
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory store serializes concurrent cross-process writers", async (t) => {
  if (process.platform !== "linux") {
    t.skip("descriptor flock lock is Linux-only");
    return;
  }
  const dir = await mkdtemp(tmpdir() + "/coach-memory-concurrent-");
  const store = new Store(dir);
  try {
    await store.init();
    const writer = String.raw`
      import { Store } from "./src/config/store.js";
      const store = new Store(process.argv[1]);
      await store.init();
      await store.memories.add({
        host: "synthetic-authority",
        subject: { scope: "boss" },
        kind: "fact",
        text: "Concurrent writer " + process.argv[2] + ".",
        source: { type: "operator_correction", id: "writer:" + process.argv[2] },
      });
    `;
    const children = Array.from({ length: 6 }, (_, index) =>
      spawn(
        process.execPath,
        [...process.execArgv, "-e", writer, dir, String(index)],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    try {
      const results = await Promise.all(
        children.map(
          (child) =>
            new Promise<{ code: number | null; stderr: string }>((resolve) => {
              const stderr: Buffer[] = [];
              child.stderr?.on("data", (chunk) =>
                stderr.push(Buffer.from(chunk)),
              );
              child.once("close", (code) =>
                resolve({
                  code,
                  stderr: Buffer.concat(stderr).toString("utf8"),
                }),
              );
            }),
        ),
      );
      assert.deepEqual(
        results.map((result) => result.code),
        [0, 0, 0, 0, 0, 0],
        results.map((result) => result.stderr).join("\n"),
      );
    } finally {
      await Promise.all(children.map(closeChild));
    }
    const restarted = new Store(dir);
    await restarted.init();
    assert.equal(
      restarted.memories.list({ host: "synthetic-authority" }).total,
      6,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale memory writers cannot resurrect a forgotten memory", async () => {
  const dir = await mkdtemp(tmpdir() + "/coach-memory-stale-");
  const first = new Store(dir);
  const stale = new Store(dir);
  try {
    await first.init();
    const entry = await first.memories.add({
      host: "synthetic-authority",
      subject: { scope: "boss" },
      kind: "preference",
      text: "Prefers stale writer fencing.",
      source: { type: "operator_correction", id: "synthetic-stale" },
    });
    await stale.init();
    await first.memories.forget(entry.id);
    await assert.rejects(
      stale.memories.update(entry.id, {
        text: "Prefers resurrected stale writes.",
        operator_note: "stale writer",
      }),
      /MEMORY_NOT_FOUND/,
    );
    const restarted = new Store(dir);
    await restarted.init();
    assert.equal(restarted.memories.list({ include_archived: true }).total, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker member memory fails closed without backend durable authority", async () => {
  const backend = await workerFixture();
  const dir = await mkdtemp(tmpdir() + "/coach-memory-worker-");
  const store = new Store(dir);
  await store.init();
  await store.save({
    ...store.publicConfig(),
    origin: backend.origin,
    token: "synthetic-token",
    apiKey: "synthetic-provider-key",
  });
  const systems: string[] = [];
  const recallResults: string[] = [];
  const makeWorker = () =>
    new Worker({
      origin: backend.origin,
      token: "synthetic-token",
      system: "Coach",
      memories: store.memories.runtime({ host: memoryHost(store) }),
      complete: async (_context, _signal, system, tools) => {
        systems.push(system);
        const recall = tools.find(
          (tool) => tool.name === "coach_recall_memory",
        );
        if (recall) {
          const result = await recall.execute(
            "synthetic",
            { query: "morning workouts", scopes: ["member"] },
            AbortSignal.timeout(1000),
          );
          recallResults.push(result.content[0].text);
        }
        return "Synthetic response";
      },
    });
  try {
    backend.enqueue("Please remember that I prefer morning workouts.");
    backend.current.requester_id = "member-one";
    await makeWorker().pollOnce();
    assert.equal(
      store.memories.list({ subject_ref: "member-one" }).items.length,
      0,
    );
    assert.doesNotMatch(systems.at(-1) ?? "", /morning workouts/i);
    assert.match(recallResults.at(-1) ?? "", /authority_unavailable/i);
    assert.match(recallResults.at(-1) ?? "", /durable memory authority/i);

    backend.enqueue("What should I do today?");
    backend.current.requester_id = "member-one";
    await makeWorker().pollOnce();
    assert.doesNotMatch(systems.at(-1) ?? "", /morning workouts/i);
    await assert.rejects(
      store.memories.add({
        host: memoryHost(store),
        subject: { scope: "member", ref: "member-one" },
        kind: "preference",
        text: "Prefers morning workouts.",
        source: { type: "operator_correction", id: "user-supplied" },
      }),
      /MEMORY_AUTHORITY_UNAVAILABLE/,
    );

    const retain = await store.memories.retainWorkerInteraction({
      host: memoryHost(store),
      request: {
        id: "stale",
        lease_generation: 1,
        requester_id: "member-one",
        scope: "dojo",
        message: "Please remember that I prefer evening workouts.",
        created_at: new Date().toISOString(),
      },
      assistant: "stale extraction",
    });
    assert.deepEqual(retain, { stored: 0, status: "authority_unavailable" });
    assert.equal(
      store.memories.list({ subject_ref: "member-one" }).items.length,
      0,
    );
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("native Operator provider turns receive current boss memory without restart and can use recall tool", async () => {
  const native = await nativeFixture();
  try {
    await native.store.memories.add({
      host: memoryHost(native.store),
      subject: { scope: "boss" },
      kind: "preference",
      text: "Prefers concise summaries.",
      confidence: 0.9,
      importance: 0.9,
      relevance: 0.9,
      pinned: true,
      source: { type: "operator_correction", id: "synthetic-native" },
    });
    const gateway = await openNativeGateway(native.store);
    try {
      const catalog = await gateway.handle({ kind: "catalog" });
      assert.ok(
        catalog.tools.some((tool: any) => tool.name === "coach_recall_memory"),
      );
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "How should you answer me?" }],
        },
      });
      assert.match(
        JSON.stringify(
          native.calls.find((c) => c.path === "/v1/chat/completions")?.body,
        ),
        /concise summaries/i,
      );

      const remembered = await gateway.handle({
        kind: "tool",
        name: "coach_recall_memory",
        args: { query: "summary style", scopes: ["boss"] },
      });
      assert.match(JSON.stringify(remembered), /concise summaries/i);

      const item = native.store.memories.list({ scope: "boss" }).items[0];
      await native.store.memories.update(item.id, {
        text: "Prefers detailed tradeoff notes.",
        importance: 0.95,
        pinned: true,
        operator_note: "Synthetic native correction",
      });
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [
            { role: "user", content: "How should you answer me now?" },
          ],
        },
      });
      assert.match(
        JSON.stringify(
          native.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)
            ?.body,
        ),
        /detailed tradeoff notes/i,
      );
      assert.doesNotMatch(
        JSON.stringify(
          native.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)
            ?.body,
        ),
        /concise summaries/i,
      );
    } finally {
      await gateway.close();
    }
  } finally {
    await native.close();
  }
});

test("same-origin backend credential rotation hides prior local boss memories", async () => {
  const native = await nativeFixture();
  try {
    await native.store.memories.add({
      host: memoryHost(native.store),
      subject: { scope: "boss" },
      kind: "fact",
      text: "Old owner prefers predecessor-only briefings.",
      importance: 0.95,
      relevance: 0.95,
      source: { type: "operator_correction", id: "synthetic-old-owner" },
    });
    await native.store.save({
      ...native.store.publicConfig(),
      token: "replacement-backend-credential",
    });
    const gateway = await openNativeGateway(native.store);
    try {
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "What local memory applies?" }],
        },
      });
      assert.doesNotMatch(
        JSON.stringify(
          native.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)
            ?.body,
        ),
        /predecessor-only briefings/i,
      );
    } finally {
      await gateway.close();
    }
  } finally {
    await native.close();
  }
});

test("forget tears down a native runtime that already saw that memory", async () => {
  const native = await nativeFixture();
  const terminated: string[] = [];
  try {
    const entry = await native.store.memories.add({
      host: memoryHost(native.store),
      subject: { scope: "boss" },
      kind: "preference",
      text: "Prefers runtime teardown after forget.",
      importance: 0.95,
      relevance: 0.95,
      source: { type: "operator_correction", id: "synthetic-forget" },
    });
    const gateway = await openNativeGateway(native.store, undefined, {
      onTerminate: (reason) => terminated.push(reason),
    });
    try {
      await gateway.handle({
        kind: "provider",
        body: {
          model: "approved-custom-model",
          messages: [{ role: "user", content: "Prime memory context." }],
        },
      });
      assert.match(
        JSON.stringify(
          native.calls.filter((c) => c.path === "/v1/chat/completions").at(-1)
            ?.body,
        ),
        /runtime teardown after forget/i,
      );
      await native.store.memories.forget(entry.id);
      await assert.rejects(
        gateway.handle({
          kind: "provider",
          body: {
            model: "approved-custom-model",
            messages: [{ role: "user", content: "Use anything remembered." }],
          },
        }),
        /NATIVE_SESSION_REVOKED/,
      );
      assert.deepEqual(terminated, ["MEMORY_FORGOTTEN"]);
    } finally {
      await gateway.close();
    }
  } finally {
    await native.close();
  }
});
