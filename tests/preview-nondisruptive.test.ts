import { test, before, after } from "node:test";
import { NativeTerminal } from "../src/server/terminal.js";
import { openNativeGateway as legacyGateway } from "./helpers/legacy-gateway.js";
const proto = NativeTerminal.prototype as any;
const originalOpen = proto.openGateway;
// This fixture holds a legacy backend start to exercise nondisruptive lifecycle.
before(() => {
  proto.openGateway = legacyGateway;
});
after(() => {
  proto.openGateway = originalOpen;
});
import assert from "node:assert/strict";
import { Updates } from "../src/update/updates.js";
import { PREVIEW, aborted, bounded, harness, held } from "./helpers/preview.js";

// Studio preview is an isolated, read-only inference over the saved revision.
// It must never stop, start or restart the worker or close native sessions,
// on success, failure, cancellation or connection loss.
const livePreview =
  (text = "Synthetic preview answer") =>
  async () =>
    text;

test("preview with a stopped Coach needs no confirmation and leaves it stopped", async () => {
  const h = await harness(livePreview());
  try {
    const before = await h.status();
    assert.equal(before.state, "stopped");
    const response = await h.post("preview", { text: PREVIEW });
    const body = (await response.json()) as any;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.text, "Synthetic preview answer");
    assert.equal(body.lifecycle, undefined, "preview is not a lifecycle op");
    const after = await h.status();
    assert.equal(after.state, "stopped");
    assert.equal(after.transition, false);
    assert.equal(after.preview, false);
    assert.equal(after.lifecycle, undefined);
    assert.equal(h.calls.includes("initialize"), false, "no worker started");
  } finally {
    await h.close();
  }
});

test("preview beside a running Coach never pauses its in-flight live request", async () => {
  const h = await harness(livePreview());
  try {
    h.enqueue("Live member question");
    assert.equal((await h.post("run")).status, 200);
    await bounded(h.work.started, "worker inference");
    const signal = h.work.signals[0];
    // Both a current UI (no consent field) and a cached older UI (explicit
    // restart consent) get the same non-disruptive preview.
    for (const body of [
      { text: PREVIEW },
      { text: PREVIEW, confirmRestart: true },
    ]) {
      const response = await h.post("preview", body);
      const data = (await response.json()) as any;
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.text, "Synthetic preview answer");
      assert.equal(data.lifecycle, undefined);
      assert.equal(signal.aborted, false, "live work was not cancelled");
      const s = await h.status();
      assert.notEqual(s.state, "stopped");
      assert.equal(s.lifecycle, undefined);
    }
    assert.equal(h.work.signals.length, 1, "worker was never restarted");
    h.work.release();
    for (let i = 0; i < 100 && h.publications === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.publications, 1, "live request completed exactly once");
    assert.notEqual((await h.status()).state, "stopped");
  } finally {
    await h.close();
  }
});

test("preview failure, cancel, disconnect and late output never touch live work", async () => {
  let mode: "fail" | "wait" | "ignore-abort" = "wait";
  const previewEntered: Array<() => void> = [];
  const nextPreview = () =>
    new Promise<void>((r) => previewEntered.push(r)).then(() => {});
  let entered = nextPreview();
  const h = await harness(async (signal) => {
    previewEntered.shift()?.();
    if (mode === "fail") throw new Error("PROVIDER_UNAVAILABLE");
    if (mode === "ignore-abort") {
      await new Promise((r) => setTimeout(r, 150));
      return "late answer that must never be shown";
    }
    await aborted(signal);
    return "never";
  });
  try {
    h.enqueue("Live member question");
    assert.equal((await h.post("run")).status, 200);
    await bounded(h.work.started, "worker inference");
    const signal = h.work.signals[0];

    // Explicit cancel.
    let pending = h.post("preview", { text: PREVIEW });
    await bounded(entered, "preview start");
    const duplicate = await h.post("preview", { text: PREVIEW });
    assert.equal(duplicate.status, 409, "duplicate preview rejected");
    assert.equal(((await duplicate.json()) as any).lifecycle, undefined);
    assert.equal((await h.post("cancel")).status, 200);
    let result = await pending;
    let data = (await result.json()) as any;
    assert.equal(data.error, "CANCELLED");
    assert.equal(data.lifecycle, undefined);

    // Browser/network loss aborts the provider call through the socket.
    entered = nextPreview();
    const lost = new AbortController();
    const disconnected = h
      .post("preview", { text: PREVIEW }, lost.signal)
      .catch(() => "disconnected");
    await bounded(entered, "preview start");
    lost.abort();
    assert.equal(await disconnected, "disconnected");
    for (let i = 0; i < 100 && (await h.status()).preview; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal((await h.status()).preview, false);

    // Output arriving after cancel is never returned.
    mode = "ignore-abort";
    entered = nextPreview();
    pending = h.post("preview", { text: PREVIEW });
    await bounded(entered, "preview start");
    assert.equal((await h.post("cancel")).status, 200);
    result = await pending;
    const text = await result.text();
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(text).error, "CANCELLED");
    assert.equal(text.includes("late answer"), false);

    // Provider failure.
    mode = "fail";
    result = await h.post("preview", { text: PREVIEW });
    assert.equal(result.status, 400);
    assert.equal(((await result.json()) as any).lifecycle, undefined);

    // Retry after all of that succeeds.
    mode = "wait";
    entered = nextPreview();
    pending = h.post("preview", { text: PREVIEW });
    await bounded(entered, "preview retry start");
    await h.post("cancel");
    await pending;

    assert.equal(signal.aborted, false, "live work was never cancelled");
    assert.equal(h.work.signals.length, 1, "worker was never restarted");
    const s = await h.status();
    assert.notEqual(s.state, "stopped");
    assert.equal(s.lifecycle, undefined);
    assert.equal(s.lastError?.code === "WORKER_STOP_UNCONFIRMED", false);
    h.work.release();
    for (let i = 0; i < 100 && h.publications === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.publications, 1);
  } finally {
    await h.close();
  }
});

test("Run and Stop during a preview neither cancel it nor are undone by it", async () => {
  const gate = held();
  const h = await harness(async (signal) => {
    gate.entered();
    await Promise.race([gate.gate, aborted(signal)]);
    return "Synthetic preview answer";
  });
  try {
    const pending = h.post("preview", { text: PREVIEW });
    await bounded(gate.started, "preview start");
    const run = await h.post("run");
    assert.equal(run.status, 200, await run.clone().text());
    assert.notEqual((await h.status()).state, "stopped");
    assert.equal((await h.status()).preview, true, "preview still running");
    const stop = await h.post("stop");
    assert.equal(stop.status, 200);
    assert.equal((await h.status()).state, "stopped");
    assert.equal((await h.status()).preview, true, "preview still running");
    assert.equal((await h.post("run")).status, 200);
    gate.release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as any).text,
      "Synthetic preview answer",
    );
    const s = await h.status();
    assert.notEqual(s.state, "stopped", "preview did not stop Coach");
    assert.equal(s.lifecycle, undefined);
  } finally {
    gate.release();
    await h.close();
  }
});

test("preview keeps exclusive settings/update safety and a coherent saved snapshot", async () => {
  const gate = held();
  const seen: any[] = [];
  const h = await harness(async (signal, provider) => {
    seen.push(provider);
    gate.entered();
    await Promise.race([gate.gate, aborted(signal)]);
    return "Synthetic preview answer";
  });
  try {
    const revision = h.store.publicConfig().revision;
    const pending = h.post("preview", { text: PREVIEW });
    await bounded(gate.started, "preview start");
    const saved = h.store.publicConfig();
    const save = await h.post("config", {
      ...saved,
      persona: { ...saved.persona, name: "Changed during preview" },
      apiKey: "synthetic-preview-provider-key-2",
    });
    assert.equal(save.status, 409);
    const saveBody = (await save.json()) as any;
    assert.equal(saveBody.error, "OPERATION_IN_PROGRESS");
    assert.match(saveBody.hint, /preview/i);
    assert.equal(h.store.publicConfig().revision, revision);
    const restore = await h.post("persona-restore", { revision: 1 });
    assert.equal(restore.status, 409);
    assert.equal(h.store.publicConfig().revision, revision);
    gate.release();
    const response = await pending;
    const data = (await response.json()) as any;
    assert.equal(response.status, 200);
    assert.equal(data.revision, revision);
    assert.equal(seen[0].apiKey, "synthetic-preview-provider-key");
    assert.equal(seen[0].model, "synthetic-model");
    // Once the preview settles, settings save normally again.
    const after = await h.post("config", {
      ...saved,
      persona: { ...saved.persona, name: "Saved after preview" },
    });
    assert.equal(after.status, 200, await after.clone().text());
  } finally {
    gate.release();
    await h.close();
  }
});

test("shutdown cancels a running preview without a late answer", async () => {
  const gate = held();
  const h = await harness(async (signal) => {
    gate.entered();
    await aborted(signal);
    return "never";
  });
  let closed = false;
  try {
    const pending = h
      .post("preview", { text: PREVIEW })
      .then((r) => r.text())
      .catch(() => "");
    await bounded(gate.started, "preview start");
    await bounded(h.app.close(), "shutdown");
    closed = true;
    assert.equal((await pending).includes("never"), false);
  } finally {
    if (!closed) await h.app.close();
    await h.close();
  }
});

test("preview admitted during another operation is refused without side effects", async () => {
  let previews = 0;
  const h = await harness(async () => {
    previews++;
    return "Synthetic preview answer";
  });
  let connect: Promise<Response> | undefined;
  try {
    h.backendHold.name = "coach_list_requests";
    connect = h.post("connect");
    await bounded(h.backendHold.started, "connect held");
    assert.equal((await h.status()).transition, true);
    const refused = await h.post("preview", { text: PREVIEW });
    const body = (await refused.json()) as any;
    assert.equal(refused.status, 409);
    assert.equal(body.error, "OPERATION_IN_PROGRESS");
    assert.match(body.hint, /retry preview/i);
    assert.equal(body.lifecycle, undefined);
    assert.equal(previews, 0, "no provider call while refused");
    h.backendHold.release();
    assert.equal((await connect).status, 200);
    const s = await h.status();
    assert.equal(s.state, "stopped");
    assert.equal(s.preview, false);
    assert.equal(s.lifecycle, undefined);
    const retried = await h.post("preview", { text: PREVIEW });
    assert.equal(retried.status, 200);
    assert.equal(previews, 1);
  } finally {
    h.backendHold.release();
    await connect?.catch(() => {});
    await h.close();
  }
});

test("a preview whose body arrives after shutdown begins is never admitted", async () => {
  let previews = 0;
  const h = await harness(async () => {
    previews++;
    return "never";
  });
  let closing: Promise<void> | undefined;
  try {
    // A held backend stop report keeps shutdown in Worker.stop, so the late
    // preview body deterministically arrives after `closing` is set.
    h.presence.enabled = true;
    assert.equal((await h.post("run")).status, 200);
    assert.equal((await h.status()).presence, "reported");
    h.backendHold.name = "coach_report_worker_presence";
    const { request } = await import("node:http");
    const body = JSON.stringify({ text: PREVIEW });
    let req!: ReturnType<typeof request>;
    const outcome = new Promise<string>((resolve) => {
      req = request(
        new URL(h.app.origin + "/api/preview"),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + h.store.secrets.admin,
            Origin: h.app.origin,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve(res.statusCode + " " + raw));
          res.on("error", () => resolve("reset"));
        },
      );
      req.on("error", () => resolve("reset"));
    });
    req.write(body.slice(0, 5));
    await new Promise((r) => setTimeout(r, 50));
    closing = h.app.close();
    await new Promise((r) => setTimeout(r, 50));
    req.end(body.slice(5));
    const result = await bounded(outcome, "late preview outcome");
    assert.equal(result.startsWith("503"), true, result);
    assert.match(result, /SERVICE_CLOSING/);
    assert.equal(previews, 0, "no provider call after shutdown began");
  } finally {
    h.backendHold.release();
    await closing?.catch(() => {});
    await h.close();
  }
});

test("a provider that ignores abort cannot hold the preview slot after cancel", async () => {
  let calls = 0;
  const h = await harness(() => {
    calls++;
    return new Promise<string>(() => {});
  });
  try {
    const pending = h.post("preview", { text: PREVIEW });
    for (let i = 0; i < 100 && calls === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1);
    assert.equal((await h.post("cancel")).status, 200);
    const result = await bounded(pending, "cancelled preview reply");
    assert.equal(result.status, 400);
    assert.equal(((await result.json()) as any).error, "CANCELLED");
    assert.equal((await h.status()).preview, false, "slot released");
    const saved = h.store.publicConfig();
    const save = await h.post("config", {
      ...saved,
      persona: { ...saved.persona, name: "Saved after stuck preview" },
    });
    assert.equal(save.status, 200, await save.clone().text());
    const retry = h.post("preview", { text: PREVIEW });
    for (let i = 0; i < 100 && calls === 1; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 2, "retry admitted");
    // Shutdown is not held hostage by the unresponsive provider either.
    await bounded(h.app.close(), "shutdown with stuck provider");
    await retry.catch(() => {});
  } finally {
    await h.close();
  }
});

test("manual update and automatic quiesce stay excluded from a running preview", async () => {
  const sha = "f".repeat(40);
  let applications = 0;
  let finish!: () => void;
  const gate = held();
  const updates = new Updates(
    null,
    async () => {
      applications++;
      await new Promise<void>((r) => (finish = r));
    },
    async () => new Response(JSON.stringify({ object: { sha } })),
  );
  updates.latest = sha;
  updates.checkedAt = Date.now();
  const h = await harness(
    async (signal) => {
      gate.entered();
      await Promise.race([gate.gate, aborted(signal)]);
      return "Synthetic preview answer";
    },
    { updates, quiesce: true },
  );
  try {
    h.enqueue("Live member question");
    assert.equal((await h.post("run")).status, 200);
    await bounded(h.work.started, "worker inference");
    const pending = h.post("preview", { text: PREVIEW });
    await bounded(gate.started, "preview start");
    const apply = await h.post("update/apply", { sha, confirm: true });
    assert.equal(apply.status, 409);
    assert.match(((await apply.json()) as any).hint, /preview/i);
    const quiesce = await h.post("update/quiesce", { confirm: true });
    assert.equal(quiesce.status, 409);
    assert.equal(((await quiesce.json()) as any).error, "UPDATE_BUSY");
    const s = await h.status();
    assert.equal(s.updateQuiesced, false);
    assert.notEqual(s.state, "stopped");
    assert.equal(h.work.signals[0].aborted, false, "live work untouched");
    assert.equal(applications, 0, "nothing applied");
    gate.release();
    assert.equal((await pending).status, 200);

    // Once an update is accepted, preview is refused rather than racing it.
    assert.equal((await h.post("stop")).status, 200);
    assert.equal(
      (await h.post("update/apply", { sha, confirm: true })).status,
      202,
    );
    const refused = await h.post("preview", { text: PREVIEW });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as any).error, "UPDATE_IN_PROGRESS");
    assert.equal(applications, 1);
  } finally {
    gate.release();
    finish?.();
    await h.close();
  }
});
