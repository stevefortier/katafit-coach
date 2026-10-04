import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/native.js";
import { NativeRuntime } from "../src/sandbox/runtime.js";
import { openNativeGateway } from "../src/sandbox/gateway.js";
import { Actions } from "../src/chat/actions.js";
import { PI_READY } from "./helpers/native-ready.js";
import { answer, toolCall } from "./helpers/continuity.js";
import { isExtraction } from "./helpers/native-memory.js";
import { startAccountMemoryBackend } from "./helpers/account-memory-backend.js";
import { lossyProxy } from "./helpers/account-backend.js";

const options = {
  skip: process.env.NATIVE_DOCKER_TEST !== "1",
  timeout: 60000,
};
const waitFor = async (check: () => boolean, diagnostic: () => string) => {
  const end = Date.now() + 25000;
  while (!check()) {
    if (Date.now() > end) throw new Error(diagnostic());
    await new Promise((r) => setTimeout(r, 40));
  }
};
async function harness(mode: "reuse" | "binding" | "writes" | "uncertain") {
  let denied = false;
  const f = await fixture(
    (name, result, body) => {
      if (name !== "provider") return result;
      if (isExtraction(body)) return answer(JSON.stringify({ proposals: [] }));
      const last = body.messages.findLastIndex((m: any) => m.role === "user");
      const human = JSON.stringify(body.messages[last]);
      const turn = /third/.test(human)
        ? "third"
        : /second/.test(human)
          ? "second"
          : "first";
      const returned = body.messages
        .slice(last + 1)
        .find((m: any) => m.role === "tool");
      if (mode === "reuse" && turn === "third") {
        // Ground internal reuse in the actual prior native tool result.
        const acquired = body.messages.find(
          (m: any) =>
            m.role === "tool" && m.content.includes("Synthetic Alice"),
        );
        return answer(
          acquired ? "SECURITY_third_REUSED" : "SECURITY_third_MISSING",
        );
      }
      if (returned) {
        const text = JSON.stringify(returned.content);
        const verified =
          mode === "writes"
            ? /committed|saved|memory_id/.test(text) &&
              !/MEMORY_.*UNKNOWN|AUTH_EXPIRED/.test(text)
            : /Synthetic Alice/.test(text);
        return answer(
          `SECURITY_${turn}_${mode === "uncertain" ? "UNCERTAIN" : verified ? "VERIFIED" : "DENIED"}`,
        );
      }
      return toolCall(
        "katafit_rest_request",
        mode === "writes"
          ? {
              method: "POST",
              path: "/api/coach/memory",
              body: {
                kind: "fact",
                text: `Synthetic intentional ${turn} memory.`,
              },
            }
          : mode === "uncertain"
            ? {
                method: "POST",
                path: "/api/synthetic-write",
                body: { text: `Synthetic ${turn}.` },
              }
            : { method: "GET", path: "/api/users/me" },
        `security_${turn}`,
      );
    },
    (url) =>
      url === "/api/users/me"
        ? {
            status: denied ? 401 : 200,
            body: JSON.stringify({ name: "Synthetic Alice" }),
          }
        : { status: 404 },
  );
  const memory =
    mode === "writes" ? await startAccountMemoryBackend() : undefined;
  const proxy =
    mode === "uncertain"
      ? await lossyProxy(f.store.publicConfig().origin)
      : undefined;
  if (memory || proxy)
    await f.store.save({
      ...f.store.publicConfig(),
      origin: memory?.origin ?? proxy!.origin,
      ...(memory ? { token: memory.token } : {}),
    });
  if (proxy) proxy.state.dropNext = true;
  let gateway = await openNativeGateway(f.store);
  let runtime: NativeRuntime;
  let output = "";
  const start = async () => {
    runtime = new NativeRuntime(process.env.NATIVE_TEST_IMAGE!);
    runtime.onOutput = (chunk) => {
      output = (output + chunk).slice(-150000);
    };
    await runtime.start(gateway);
    await runtime.attach();
    await waitFor(
      () => output.includes(PI_READY),
      () => output.slice(-6000),
    );
    await new Promise((r) => setTimeout(r, 100));
  };
  try {
    await start();
  } catch (e) {
    await runtime!.stop();
    await gateway.close();
    await proxy?.close();
    await memory?.close();
    await f.close();
    throw e;
  }
  return {
    f,
    memory,
    proxy,
    revoke: () => {
      denied = true;
    },
    submit: (turn: string) =>
      runtime.input(`Perform explicit ${turn} synthetic task.\r`),
    result: (text: string) =>
      waitFor(
        () => output.includes(text),
        () => output.slice(-6000),
      ),
    restart: async () => {
      await runtime.stop();
      await gateway.close();
      gateway = await openNativeGateway(f.store);
      output = "";
      await start();
    },
    close: async () => {
      await runtime.stop();
      await gateway.close();
      await proxy?.close();
      await memory?.close();
      await f.close();
    },
  };
}

test(
  "real Pi reuses acquired REST context internally after revocation without refreshing or opening history",
  options,
  async () => {
    const h = await harness("reuse");
    try {
      h.submit("first");
      await h.result("SECURITY_first_VERIFIED");
      h.submit("second");
      await h.result("SECURITY_second_VERIFIED");
      h.revoke();
      h.submit("third");
      await h.result("SECURITY_third_REUSED");
      assert.equal(
        h.f.calls.filter((c) => c.path === "/api/users/me").length,
        2,
      );
      assert.equal(
        h.f.calls.filter((c) => c.body?.method === "tools/call").length,
        0,
        "no legacy source-permission refresh/history session",
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi changed credential invalidates the live host binding before another generation",
  options,
  async () => {
    const h = await harness("binding");
    try {
      h.submit("first");
      await h.result("SECURITY_first_VERIFIED");
      const before = h.f.calls.filter(
        (c) => c.path === "/v1/chat/completions",
      ).length;
      await h.f.store.save({
        ...h.f.store.publicConfig(),
        token: "rotated-synthetic-token",
      });
      h.submit("second");
      await h.result("no longer authorized");
      assert.equal(
        h.f.calls.filter((c) => c.path === "/v1/chat/completions").length,
        before,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi admits two intentional receipted memory writes rather than obsolete one-send session quota",
  options,
  async () => {
    const h = await harness("writes");
    try {
      h.submit("first");
      await h.result("SECURITY_first_VERIFIED");
      h.submit("second");
      await h.result("SECURITY_second_VERIFIED");
      assert.deepEqual(
        [...h.memory!.items.values()].map((i) => i.text).sort(),
        [
          "Synthetic intentional first memory.",
          "Synthetic intentional second memory.",
        ],
      );
      assert.equal(
        h.memory!.requests.filter(
          (r) => r.method === "POST" && r.path === "/api/coach/memory",
        ).length,
        2,
      );
      assert.equal(
        h.f.calls.filter((c) => c.body?.method === "tools/call").length,
        0,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "real Pi uncertain REST write cannot replay across later turns or a fresh runtime/gateway",
  options,
  async () => {
    const h = await harness("uncertain");
    try {
      h.submit("first");
      await h.result("SECURITY_first_UNCERTAIN");
      h.submit("second");
      await h.result("SECURITY_second_UNCERTAIN");
      assert.equal(
        h.proxy!.state.requests.filter((r) => r.path === "/api/synthetic-write")
          .length,
        1,
      );
      const original = new Actions(h.f.store)
        .snapshot()
        .find((a) => a.status === "unknown");
      assert.ok(original);
      await h.restart();
      h.submit("third");
      await h.result("SECURITY_third_UNCERTAIN");
      assert.equal(
        h.proxy!.state.requests.filter((r) => r.path === "/api/synthetic-write")
          .length,
        1,
      );
      assert.deepEqual(new Actions(h.f.store).snapshot(), [original]);
    } finally {
      await h.close();
    }
  },
);
